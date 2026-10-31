// Virtual native-binding layer (route B): implements `globalThis.ego` —
// the API the closed-source ego lite app injects natively — on top of a
// stock Chromium driven over CDP.
//
// Implemented per repo/docs/native-bindings-api.md:
//   getBrowserVersion, listProfiles, createTaskSpace, listTaskSpaces,
//   claimTaskSpace, useTaskSpace, closeTaskSpace, completeTaskSpace,
//   handOffTaskSpace, takeOverTaskSpace, setAgentTaskState, createTab,
//   listTabs, snapshot, animationHighlightMouseToPosition,
//   sendCDPMessage / onCDPMessage / onSendCDPMessageError.
//
// Task spaces are binding-layer state (target groups in one shared
// Chromium profile), persisted to disk so short-lived CLI processes see
// the same spaces across rounds, like the original.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { PROFILES_DIR } from "./chromium.js";
import { buildSnapshot } from "./snapshot.js";

const APP_VERSION = "0.6.0.16";
const BUILTIN_PROFILE = { id: "Default", name: "Personal", isDefault: true };
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

function invalidArgument(message) {
  const error = new TypeError(message);
  error.error_code = "EGO_INVALID_ARGUMENT";
  return error;
}

function egoError(message, errorCode) {
  const error = new Error(message);
  error.error_code = errorCode;
  return error;
}

function errorObject(message, errorCode) {
  return { error: message, error_code: errorCode };
}

const USER_IN_CONTROL = () =>
  errorObject("manual_takeover", "EGO_TASK_SPACE_USER_IN_CONTROL");

/**
 * Whether commands are blocked on this space: the user is in control either
 * because it is their own space ("user") or because an agent-owned space was
 * handed off / taken over in the UI ("agentDelegatedToUser"). Both states
 * report EGO_TASK_SPACE_USER_IN_CONTROL on the blocked command set, matching
 * docs/native-bindings-api.md. takeOverTaskSpace/claimTaskSpace stay
 * unblocked: they are the recovery path back to agent control.
 */
const isUserControlled = (space) =>
  space.ownership === "user" || space.ownership === "agentDelegatedToUser";

/**
 * Linux equivalent of the original's browser-side update signal.
 * The stock SDK prints "[ego-browser:notice] Ego Lite update is available …
 * run `ego-browser upgrade`" exactly when getBrowserVersion() reports
 * updateAvailable: true (src/update-notice.ts). Here the signal is: the repo
 * checkout has fetched upstream commits that are not in the local HEAD.
 * FETCH_HEAD is rewritten by every `git fetch` (including upgrade's check),
 * so this is a local, network-free read. Never throws; any doubt reports
 * false (no notice) rather than a wrong true.
 */
function isUpdateAvailable() {
  try {
    const repoDir = process.env.EGO_REPO_DIR || join(SRC_DIR, "..", "..", "repo");
    if (!existsSync(join(repoDir, ".git"))) return false;
    const read = (args) => {
      const r = spawnSync("git", args, {
        cwd: repoDir,
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (r.status !== 0) return null;
      return (r.stdout || "").trim() || null;
    };
    const head = read(["rev-parse", "HEAD"]);
    const fetched = read(["rev-parse", "FETCH_HEAD"]);
    if (!head || !fetched || head === fetched) return false;
    // Strictly ahead: commits in FETCH_HEAD that HEAD does not have.
    // (A merge-base ancestor check would misfire with our local port commit
    // sitting on top of upstream.)
    const ahead = read(["rev-list", "--count", `${head}..${fetched}`]);
    return ahead !== null && /^\d+$/.test(ahead) && parseInt(ahead, 10) > 0;
  } catch {
    return false;
  }
}

export class EgoBindings {
  #pool;
  #statePath;
  #state;
  #selectedId = null;
  #sessions = new Map(); // `${profileId}::${targetId}` -> binding-owned CDP sessionId
  #saveQueue = Promise.resolve();
  #profilesCache = null;

  constructor(pool, statePath, state) {
    this.#pool = pool;
    this.#statePath = statePath;
    this.#state = state;
    pool.onRuntimeMessage = (text) => {
      if (typeof this.onCDPMessage === "function") {
        // Delivered asynchronously through the event loop, like the native
        // side. (The pool already defers via queueMicrotask.)
        this.onCDPMessage(text);
      }
    };
    pool.onEvent = (message, profileId) => {
      if (message.method === "Target.targetDestroyed") {
        const targetId = message.params && message.params.targetId;
        if (targetId) {
          this.#sessions.delete(`${profileId}::${targetId}`);
          this.#forgetTarget(profileId, targetId);
        }
      }
    };
    pool.onFirstConnect = (profileId) => this.#reconcileTargets(profileId);
  }

  static async create(pool, statePath) {
    let state = { nextId: 1, spaces: [] };
    if (existsSync(statePath)) {
      try {
        const parsed = JSON.parse(await readFile(statePath, "utf8"));
        if (parsed && Array.isArray(parsed.spaces)) state = parsed;
      } catch {
        // Corrupt state file: start fresh rather than failing every call.
      }
    }
    const bindings = new EgoBindings(pool, statePath, state);
    // Backfill: spaces recorded before profileId existed belong to Default.
    for (const space of state.spaces) {
      if (!space.profileId) space.profileId = "Default";
    }
    return bindings;
  }

  async #reconcileTargets(profileId) {
    let transport;
    try {
      transport = await this.#pool.forProfile(profileId);
    } catch {
      return;
    }
    let alive = new Set();
    try {
      const { targetInfos } = await transport.call("Target.getTargets");
      alive = new Set(
        (targetInfos || [])
          .filter((info) => info.type === "page")
          .map((info) => info.targetId),
      );
    } catch {
      return;
    }
    let changed = false;
    for (const space of this.#state.spaces) {
      if ((space.profileId || "Default") !== profileId) continue;
      const before = space.targetIds.length;
      space.targetIds = space.targetIds.filter((id) => alive.has(id));
      if (!space.targetIds.includes(space.activeTargetId)) {
        space.activeTargetId = space.targetIds[space.targetIds.length - 1];
      }
      if (space.targetIds.length !== before) changed = true;
    }
    if (changed) await this.#save();
  }

  /** Binding-layer transport for a profile (spawns that profile's browser). */
  #transportFor(profileId) {
    return this.#pool.forProfile(profileId || "Default");
  }

  /**
   * Drop a destroyed target from every space of the profile and keep the
   * active pointer sane. Tab closes issued through the raw CDP channel
   * (the SDK's closeTab helper sends Target.closeTarget directly) never
   * pass through the binding's close path, so the space model is healed
   * from the targetDestroyed event instead.
   */
  #forgetTarget(profileId, targetId) {
    let changed = false;
    for (const space of this.#state.spaces) {
      if ((space.profileId || "Default") !== profileId) continue;
      const i = space.targetIds.indexOf(targetId);
      if (i !== -1) {
        space.targetIds.splice(i, 1);
        changed = true;
      }
      if (space.activeTargetId === targetId) {
        space.activeTargetId = space.targetIds[space.targetIds.length - 1];
        changed = true;
      }
    }
    if (changed) this.#save().catch(() => {});
  }

  async #profiles() {
    if (this.#profilesCache) return this.#profilesCache;
    const profiles = [{ ...BUILTIN_PROFILE }];
    let entries;
    try {
      entries = await readdir(PROFILES_DIR, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let meta = null;
      try {
        meta = JSON.parse(
          await readFile(join(PROFILES_DIR, entry.name, "profile.json"), "utf8"),
        );
      } catch {
        // A bare directory is still a usable profile store.
      }
      profiles.push({
        id: entry.name,
        name: (meta && meta.name) || entry.name,
        isDefault: false,
      });
    }
    profiles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    this.#profilesCache = profiles;
    return profiles;
  }

  async #resolveProfile(profileId) {
    if (
      profileId === undefined ||
      profileId === "" ||
      profileId === "default"
    ) {
      return { ...BUILTIN_PROFILE };
    }
    const profiles = await this.#profiles();
    return profiles.find((candidate) => candidate.id === profileId) || null;
  }

  #save() {
    const snapshot = JSON.stringify(this.#state, null, 2);
    this.#saveQueue = this.#saveQueue.then(async () => {
      await mkdir(dirname(this.#statePath), { recursive: true });
      await writeFile(this.#statePath, snapshot);
    });
    return this.#saveQueue;
  }

  #spaceById(id) {
    return this.#state.spaces.find((space) => space.id === id);
  }

  #selectedSpace() {
    if (this.#selectedId === null) return null;
    return this.#spaceById(this.#selectedId) || null;
  }

  #requireSelectedSpace() {
    const space = this.#selectedSpace();
    if (!space) {
      return {
        error: errorObject(
          "Task space not selected",
          "EGO_TASK_SPACE_NOT_SELECTED",
        ),
      };
    }
    return { space };
  }

  // ------------------------------------------------------------------
  // Browser version / profiles
  // ------------------------------------------------------------------

  async getBrowserVersion() {
    return { currentVersion: APP_VERSION, updateAvailable: isUpdateAvailable() };
  }

  async listProfiles(...args) {
    if (args.length > 0) {
      throw invalidArgument("ego.listProfiles() expects no arguments.");
    }
    const profiles = await this.#profiles();
    return { profiles: profiles.map((profile) => ({ ...profile })) };
  }

  // ------------------------------------------------------------------
  // Task spaces
  // ------------------------------------------------------------------

  async createTaskSpace(...args) {
    const [name, profileId] = args;
    if (
      args.length < 1 ||
      args.length > 2 ||
      typeof name !== "string" ||
      name.length === 0 ||
      (profileId !== undefined && typeof profileId !== "string")
    ) {
      throw invalidArgument(
        "ego.createTaskSpace(name, profileId?) expects a string task name and an optional profile id.",
      );
    }
    const profile = await this.#resolveProfile(profileId);
    if (!profile) {
      return errorObject("Profile not found", "EGO_PROFILE_NOT_FOUND");
    }
    const space = {
      id: this.#state.nextId++,
      taskId: name,
      name,
      createdBy: "agent",
      ownership: "agent",
      profileId: profile.id,
      targetIds: [],
      activeTargetId: undefined,
      stateText: undefined,
    };
    // A new task space starts with one managed blank page (the guide's
    // "p1"); navigation helpers attach to it instead of creating tabs.
    // The target is created in the Chromium instance backing this profile,
    // so spaces of the same profile share that profile's cookie jar, like
    // the original.
    try {
      const transport = await this.#transportFor(profile.id);
      const { targetId } = await transport.call("Target.createTarget", {
        url: "about:blank",
      });
      space.targetIds.push(targetId);
      space.activeTargetId = targetId;
    } catch {
      return errorObject("No active browser", "EGO_BROWSER_UNAVAILABLE");
    }
    this.#state.spaces.push(space);
    await this.#save();
    return { taskId: space.taskId, id: space.id, name: space.name };
  }

  async listTaskSpaces(...args) {
    if (args.length > 0) {
      throw invalidArgument("ego.listTaskSpaces() expects no arguments.");
    }
    // Merge target inventories across the profiles that currently have a
    // live browser; a listing must not spawn browsers as a side effect.
    const tabsByTarget = new Map();
    const profileIds = new Set(
      this.#state.spaces.map((space) => space.profileId || "Default"),
    );
    profileIds.add("Default");
    for (const profileId of profileIds) {
      const transport = this.#pool.cachedTransport(profileId);
      if (!transport) continue;
      for (const [targetId, info] of await this.#targetInfoMap(transport)) {
        tabsByTarget.set(targetId, info);
      }
    }
    return {
      taskSpaces: this.#state.spaces.map((space) => {
        const out = {
          taskId: space.taskId,
          id: space.id,
          name: space.name,
          createdBy: space.createdBy,
          ownership: space.ownership,
          recentTabTitles: space.targetIds
            .map((id) => tabsByTarget.get(id))
            .filter((info) => info && info.title)
            .map((info) => info.title),
        };
        if (space.profileId) out.profileId = space.profileId;
        return out;
      }),
    };
  }

  async claimTaskSpace(...args) {
    const [id, name] = args;
    if (
      args.length < 1 ||
      args.length > 2 ||
      typeof id !== "number" ||
      (name !== undefined && typeof name !== "string")
    ) {
      throw invalidArgument(
        "ego.claimTaskSpace(id, name?) expects a numeric task space id and an optional name.",
      );
    }
    const space = this.#spaceById(id);
    if (!space) {
      return errorObject(
        `Task space not found: ${id}`,
        "EGO_TASK_SPACE_NOT_FOUND",
      );
    }
    if (name !== undefined) {
      space.name = name;
      space.taskId = name;
    }
    space.createdBy = "agent";
    space.ownership = "agent";
    await this.#save();
    return { taskId: space.taskId, id: space.id, name: space.name };
  }

  useTaskSpace(...args) {
    const [id] = args;
    if (args.length !== 1 || typeof id !== "number") {
      throw invalidArgument("ego.useTaskSpace(id) expects a numeric task id.");
    }
    // Per native-bindings-api.md: selecting the local context only — no
    // creation, no validation, and no ownership gating. Operations performed
    // afterwards enforce ownership themselves; useTaskSpace must never fail
    // with EGO_TASK_SPACE_USER_IN_CONTROL, otherwise takeOverTaskSpace(id)
    // could never select a user-held space to take over.
    this.#selectedId = id;
    return id;
  }

  async closeTaskSpace(...args) {
    if (args.length > 0) {
      throw invalidArgument("ego.closeTaskSpace() expects no arguments.");
    }
    const { space, error } = this.#requireSelectedSpace();
    if (error) return error;
    if (isUserControlled(space)) return USER_IN_CONTROL();
    const transport = await this.#transportFor(space.profileId);
    for (const targetId of [...space.targetIds]) {
      await transport.call("Target.closeTarget", { targetId }).catch(() => {});
      this.#sessions.delete(`${space.profileId || "Default"}::${targetId}`);
    }
    this.#state.spaces = this.#state.spaces.filter((s) => s.id !== space.id);
    const id = space.id;
    if (this.#selectedId === id) this.#selectedId = null;
    await this.#save();
    return `${id} task space closed.`;
  }

  async completeTaskSpace(...args) {
    if (args.length > 0) {
      throw invalidArgument("ego.completeTaskSpace() expects no arguments.");
    }
    const { space, error } = this.#requireSelectedSpace();
    if (error) return error;
    if (isUserControlled(space)) return USER_IN_CONTROL();
    space.ownership = "user";
    space.createdBy = "user";
    await this.#save();
    return `${space.id} task space completed.`;
  }

  async handOffTaskSpace(...args) {
    if (args.length > 0) {
      throw invalidArgument("ego.handOffTaskSpace() expects no arguments.");
    }
    const { space, error } = this.#requireSelectedSpace();
    if (error) return error;
    // An agent-owned space handed to the user becomes "agentDelegatedToUser"
    // (still agent-owned, control temporarily with the user — see the
    // ownership policy in the SDK's helpers.ts). A user's own space stays
    // "user". Both states block the command set with
    // EGO_TASK_SPACE_USER_IN_CONTROL until takeOverTaskSpace().
    if (space.ownership !== "user") space.ownership = "agentDelegatedToUser";
    await this.#save();
    return `${space.id} has been handed off to the user.`;
  }

  async takeOverTaskSpace(...args) {
    if (args.length > 0) {
      throw invalidArgument("ego.takeOverTaskSpace() expects no arguments.");
    }
    const { space, error } = this.#requireSelectedSpace();
    if (error) return error;
    space.ownership = "agent";
    await this.#save();
    return `${space.id} has been taken over by the agent.`;
  }

  async setAgentTaskState(...args) {
    const [stateText] = args;
    if (args.length !== 1 || typeof stateText !== "string") {
      throw invalidArgument(
        "ego.setAgentTaskState(state) expects a string state.",
      );
    }
    const { space, error } = this.#requireSelectedSpace();
    if (error) return error;
    if (isUserControlled(space)) return USER_IN_CONTROL();
    space.stateText = stateText;
    await this.#save();
    return `${space.id} state updated.`;
  }

  // ------------------------------------------------------------------
  // Tabs
  // ------------------------------------------------------------------

  async #targetInfoMap(transport) {
    const map = new Map();
    try {
      const { targetInfos } = await transport.call("Target.getTargets");
      for (const info of targetInfos || []) map.set(info.targetId, info);
    } catch {
      // Browser unavailable: callers surface empty inventories.
    }
    return map;
  }

  async createTab(...args) {
    const [url] = args;
    if (args.length !== 1 || typeof url !== "string") {
      throw invalidArgument("ego.createTab(url) expects a string url.");
    }
    const { space, error } = this.#requireSelectedSpace();
    if (error) return error;
    if (isUserControlled(space)) return USER_IN_CONTROL();
    const transport = await this.#transportFor(space.profileId);
    const { targetId } = await transport.call("Target.createTarget", {
      url,
    });
    space.targetIds.push(targetId);
    space.activeTargetId = targetId;
    await this.#save();
    return { targetId };
  }

  async listTabs(...args) {
    if (args.length > 0) {
      throw invalidArgument("ego.listTabs() expects no arguments.");
    }
    const { space, error } = this.#requireSelectedSpace();
    if (error) return error;
    if (isUserControlled(space)) return USER_IN_CONTROL();
    const transport = await this.#transportFor(space.profileId);
    if (space.targetIds.length === 0) {
      // Heal spaces created before initial-tab support (or whose tabs all
      // died): a task space always has its managed blank page.
      const { targetId } = await transport.call("Target.createTarget", {
        url: "about:blank",
      });
      space.targetIds.push(targetId);
      space.activeTargetId = targetId;
      await this.#save();
    }
    const infos = await this.#targetInfoMap(transport);
    const tabs = [];
    space.targetIds.forEach((targetId, index) => {
      const info = infos.get(targetId);
      if (!info) return;
      tabs.push({
        index,
        targetId,
        url: info.url,
        title: info.title,
        active: targetId === space.activeTargetId,
      });
    });
    return { tabs };
  }

  // ------------------------------------------------------------------
  // Snapshot / UI helpers
  // ------------------------------------------------------------------

  async #sessionFor(profileId, targetId) {
    const key = `${profileId || "Default"}::${targetId}`;
    const existing = this.#sessions.get(key);
    if (existing) return existing;
    const transport = await this.#transportFor(profileId);
    const { sessionId } = await transport.call("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    this.#sessions.set(key, sessionId);
    return sessionId;
  }

  async snapshot(...args) {
    const [options] = args;
    if (
      args.length > 1 ||
      (options !== undefined &&
        (typeof options !== "object" || options === null))
    ) {
      throw invalidArgument(
        "ego.snapshot(options?) expects an options object with scope 'only_within_viewport', 'full_page', or 'subtree'.",
      );
    }
    const space = this.#selectedSpace();
    if (!space) {
      throw egoError("Task space not selected", "EGO_TASK_SPACE_NOT_SELECTED");
    }
    if (isUserControlled(space)) {
      throw egoError(
        "The task is under user control",
        "EGO_TASK_SPACE_USER_IN_CONTROL",
      );
    }
    const targetId = space.activeTargetId || space.targetIds[0];
    if (!targetId) {
      throw egoError(
        "No web contents in the current task space",
        "EGO_WEB_CONTENTS_UNAVAILABLE",
      );
    }
    let sessionId;
    try {
      sessionId = await this.#sessionFor(space.profileId, targetId);
    } catch (error) {
      throw egoError(error.message, "EGO_WEB_CONTENTS_UNAVAILABLE");
    }
    const transport = await this.#transportFor(space.profileId);
    return buildSnapshot(transport, sessionId, options || {});
  }

  async animationHighlightMouseToPosition(...args) {
    const [x, y] = args;
    if (
      args.length !== 2 ||
      typeof x !== "number" ||
      typeof y !== "number"
    ) {
      throw invalidArgument(
        "ego.animationHighlightMouseToPosition(x, y) expects two numeric coordinates.",
      );
    }
    const { space, error } = this.#requireSelectedSpace();
    if (error) return error;
    if (isUserControlled(space)) return USER_IN_CONTROL();
    // Headless Linux has no compositor overlay yet; the call is accepted so
    // scripts behave identically. Tracked as a known gap in progress.md.
    return `${space.id} mouse highlight shown.`;
  }

  // ------------------------------------------------------------------
  // Raw CDP channel
  // ------------------------------------------------------------------

  sendCDPMessage(...args) {
    const [message] = args;
    if (args.length !== 1 || typeof message !== "string") {
      throw invalidArgument(
        "ego.sendCDPMessage(message) expects a string message.",
      );
    }
    const fail = (errorMessage, errorCode) => {
      queueMicrotask(() => {
        if (typeof this.onSendCDPMessageError === "function") {
          try {
            this.onSendCDPMessageError(errorMessage, errorCode);
          } catch {
            // Error callbacks must not break the sender.
          }
        }
      });
    };
    const space = this.#selectedSpace();
    if (this.#selectedId === null || !space) {
      fail("Task space not selected", "EGO_TASK_SPACE_NOT_SELECTED");
      return undefined;
    }
    if (isUserControlled(space)) {
      fail(
        "The task is under user control",
        "EGO_TASK_SPACE_USER_IN_CONTROL",
      );
      return undefined;
    }
    // Keep the space's tab model in sync with tab switches issued through
    // the raw CDP channel: the SDK's switchTab helper sends
    // Target.activateTarget directly, bypassing the binding's tab APIs.
    // The native binding owns the tab model; the virtual layer must too,
    // or listTabs().active drifts from what the agent just activated.
    try {
      const parsed = JSON.parse(message);
      if (
        parsed &&
        parsed.method === "Target.activateTarget" &&
        parsed.params &&
        typeof parsed.params.targetId === "string" &&
        space.targetIds.includes(parsed.params.targetId)
      ) {
        space.activeTargetId = parsed.params.targetId;
        this.#save().catch(() => {});
      }
    } catch {
      // Not JSON or an unexpected shape: forward unchanged.
    }
    // The binding surface is synchronous, but the profile's browser may
    // not be connected yet in this process. A cached transport is the
    // common case (every async binding call warms it); otherwise connect
    // in the background and deliver the message once the channel is up,
    // mirroring the native "requires a CDP channel" error only when the
    // channel is actually gone.
    const cached = this.#pool.cachedTransport(space.profileId);
    if (cached) {
      if (cached.closed) {
        const error = new TypeError(
          "ego.sendCDPMessage(message) requires a CDP channel.",
        );
        error.error_code = "EGO_CDP_CHANNEL_UNAVAILABLE";
        throw error;
      }
      cached.sendRuntimeMessage(message);
      return undefined;
    }
    this.#transportFor(space.profileId).then(
      (transport) => transport.sendRuntimeMessage(message),
      (error) => fail(error.message || String(error), "EGO_CDP_SEND_FAILED"),
    );
    return undefined;
  }
}
