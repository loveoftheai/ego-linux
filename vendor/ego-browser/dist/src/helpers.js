import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setOverrides, state } from "./state.js";
import { buildEgoError, invokeEgo, probeAgentControl } from "./ego-errors.js";
import { help as helpRuntime, formatHelp } from "./help-runtime.js";
import { validatePublicApiOptions } from "./public-api-schema.js";
import { createStaleEgoBrowserGuard } from "./skill-migration.js";
import { bufferOutput } from "./output-sink.js";
import { cdp, decodeUnserializableJsValue, js } from "./cdp-eval.js";
import * as pointer from "./driver/pointer.js";
import * as keyboard from "./driver/keyboard.js";
import * as nav from "./driver/nav.js";
import * as observe from "./driver/observe.js";
import * as waits from "./driver/waits.js";
import * as files from "./driver/files.js";
import { browserFetch, serverFetch } from "./http.js";
import {
  captureTaskSpaceUserBoundary,
  createTaskSpaceHandle,
  initializeTaskSpaceHandle,
  rollbackCreatedTaskSpace
} from "./page-model.js";
import {
  loadBrowserToolSource,
  loadLearnedContext,
  runNodeSiteTool,
  siteSkillsForUrl as siteSkillsForUrlCore,
  wrapBrowserTool
} from "./learning/index.js";
import { NAME } from "./state.js";
import { cdp as cdp2, js as js2 } from "./cdp-eval.js";
import {
  click,
  doubleClick,
  hover,
  dragMouse,
  scroll,
  scrollBy,
  scrollToBottomUntil
} from "./driver/pointer.js";
import {
  pressKey,
  typeText,
  fillInput,
  dispatchKey
} from "./driver/keyboard.js";
import {
  INTERNAL_URL_PREFIXES,
  pageInfo,
  listTabs,
  currentTab,
  switchTab,
  openOrReuseTab,
  closeTab,
  gotoUrl,
  gotoAndWait,
  ensureRealTab,
  iframeTarget
} from "./driver/nav.js";
import {
  snapshot,
  snapshotRaw,
  snapshotText,
  captureScreenshot,
  elementCenter,
  drainEvents
} from "./driver/observe.js";
import {
  wait,
  waitForLoad,
  waitForElement,
  waitForNetworkIdle
} from "./driver/waits.js";
import { uploadFile } from "./driver/files.js";
import { browserFetch as browserFetch2, serverFetch as serverFetch2 } from "./http.js";
async function listTaskSpaces() {
  const ego = globalThis.ego;
  if (!ego || typeof ego.listTaskSpaces !== "function") {
    throw new Error("listTaskSpaces requires ego.listTaskSpaces");
  }
  return normalizeTaskSpaces(
    await invokeEgo("listTaskSpaces", () => ego.listTaskSpaces())
  );
}
async function profiles() {
  const ego = globalThis.ego;
  if (!ego || typeof ego.listProfiles !== "function") {
    throw new Error("profiles requires ego.listProfiles");
  }
  const result = await invokeEgo("profiles", () => ego.listProfiles());
  if (!Array.isArray(result?.profiles) || !result.profiles.every(
    (profile) => profile && typeof profile.id === "string" && profile.id.length > 0 && typeof profile.name === "string" && typeof profile.isDefault === "boolean"
  )) {
    throw new Error("profiles expected entries with id, name, and isDefault");
  }
  return result.profiles;
}
function isAgentOwned(ownership) {
  return ownership === "agent" || ownership === "agentDelegatedToUser";
}
async function switchTaskSpace(nameOrId) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.useTaskSpace !== "function") {
    throw new Error("switchTaskSpace requires ego.useTaskSpace");
  }
  const space = await findTaskSpace(nameOrId, "switchTaskSpace");
  if (!isAgentOwned(space.ownership)) {
    throw new Error(
      `switchTaskSpace requires an agent-owned task space, got ownership ${JSON.stringify(space.ownership)}`
    );
  }
  return selectTaskSpace(ego, space, "switchTaskSpace");
}
async function newTaskSpace(name, profileId) {
  assertTaskSpaceName("newTaskSpace", name);
  return (await createTaskSpaceResolution(name, profileId)).descriptor;
}
async function createTaskSpaceResolution(name, profileId, options = {}) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.createTaskSpace !== "function") {
    throw new Error("newTaskSpace requires ego.createTaskSpace");
  }
  const created = normalizeTaskSpace(
    await invokeEgo(
      "newTaskSpace",
      () => profileId === void 0 ? ego.createTaskSpace(name) : ego.createTaskSpace(name, profileId)
    )
  );
  if (!created) {
    throw new Error("newTaskSpace returned an invalid task space");
  }
  taskSpaceNumericId(created, "newTaskSpace");
  const createdByAgent = {
    ...created,
    ownership: created.ownership || "agent"
  };
  const descriptor = options.select === false ? createdByAgent : await selectTaskSpace(ego, createdByAgent, "newTaskSpace");
  return {
    descriptor,
    created: true
  };
}
async function useOrCreateTaskSpace(nameOrId) {
  assertTaskSpaceLocator("useOrCreateTaskSpace", nameOrId);
  return (await resolveTaskSpace(nameOrId)).descriptor;
}
async function resolveTaskSpace(nameOrId, options = {}) {
  const op = options.op ?? "useOrCreateTaskSpace";
  const spaces = await listTaskSpaces();
  const existing = findMatchingTaskSpace(spaces, nameOrId);
  if (!existing) {
    if (typeof nameOrId === "number") {
      throw new Error(`task space not found: ${nameOrId}`);
    }
    return createTaskSpaceResolution(nameOrId, void 0, {
      select: options.select
    });
  }
  if (isAgentOwned(existing.ownership)) {
    return {
      descriptor: options.select === false ? existing : await selectTaskSpace(
        globalThis.ego,
        existing,
        "useOrCreateTaskSpace"
      ),
      created: false
    };
  }
  if (existing.ownership === "user") {
    if (typeof nameOrId === "string" && existing.name === nameOrId) {
      throw buildEgoError(
        {
          error: [
            `A task space named ${JSON.stringify(nameOrId)} already exists and belongs to the user (id ${existing.id}).`,
            `Do not take it over on your own. Ask the user whether to work in it; only if they agree, call claimTaskSpace(${existing.id}).`,
            "Otherwise use a different task space name."
          ].join("\n"),
          error_code: "EGO_TASK_SPACE_NAME_IN_USE"
        },
        op
      );
    }
    return {
      descriptor: options.select === false ? existing : await selectTaskSpace(
        globalThis.ego,
        existing,
        "useOrCreateTaskSpace"
      ),
      created: false
    };
  }
  throw new Error(
    `useOrCreateTaskSpace cannot use task space ${JSON.stringify(nameOrId)} with ownership ${JSON.stringify(existing.ownership)}`
  );
}
async function taskSpace(nameOrId, options = {}) {
  assertTaskSpaceLocator("taskSpace", nameOrId);
  validatePublicApiOptions("taskSpace", options);
  const { profileId } = options;
  if (profileId === void 0) {
    return initializeResolvedTaskSpace(
      await resolveTaskSpace(nameOrId, { select: false, op: "taskSpace" })
    );
  }
  if (typeof nameOrId !== "string") {
    throw new TypeError(
      "taskSpace profileId can only be used with a new task-space name"
    );
  }
  const existing = findMatchingTaskSpace(await listTaskSpaces(), nameOrId);
  if (existing) {
    throw new Error(
      `taskSpace profileId only applies when creating a new task space; ${JSON.stringify(nameOrId)} already exists`
    );
  }
  return initializeResolvedTaskSpace(
    await createTaskSpaceResolution(nameOrId, profileId, { select: false })
  );
}
async function initializeResolvedTaskSpace(resolution) {
  const task = createTaskSpaceHandle(resolution.descriptor);
  if (!resolution.created) {
    await initializeTaskSpaceHandle(task);
    return task;
  }
  try {
    await initializeTaskSpaceHandle(task, { created: true });
    return task;
  } catch (error) {
    await rollbackCreatedTaskSpace(task).catch(() => {
    });
    throw error;
  }
}
async function claimTaskSpace(nameOrId) {
  const space = await findTaskSpace(nameOrId, "claimTaskSpace");
  const claimed = await claimResolvedTaskSpace(space, "claimTaskSpace");
  const task = createTaskSpaceHandle({ ...claimed, ownership: "agent" });
  await captureTaskSpaceUserBoundary(task);
  await initializeTaskSpaceHandle(task);
  return task;
}
async function claimResolvedTaskSpace(space, op = "claimTaskSpace") {
  const ego = globalThis.ego;
  if (!ego || typeof ego.claimTaskSpace !== "function") {
    throw new Error(`${op} requires ego.claimTaskSpace`);
  }
  const id = taskSpaceNumericId(space, op);
  const claimed = normalizeTaskSpace(
    // An empty name would rename the Space while claiming it; omit it so an
    // unnamed user Space keeps its UI placeholder.
    await invokeEgo(
      op,
      () => space.name ? ego.claimTaskSpace(id, space.name) : ego.claimTaskSpace(id)
    )
  );
  if (!claimed) {
    throw new Error(`${op} returned an invalid task space`);
  }
  taskSpaceNumericId(claimed, op);
  return selectTaskSpace(ego, claimed, op);
}
async function selectTaskSpace(ego, space, op) {
  if (!ego || typeof ego.useTaskSpace !== "function") {
    throw new Error(`${op} requires ego.useTaskSpace`);
  }
  await invokeEgo(op, () => ego.useTaskSpace(taskSpaceNumericId(space, op)));
  return space;
}
async function selectTaskSpaceIfProvided(ego, nameOrId, op = "taskSpace") {
  if (nameOrId === void 0) return;
  const match = await findTaskSpace(nameOrId, op);
  await selectTaskSpace(ego, match, op);
}
async function completeTaskSpace(nameOrId, options) {
  if (typeof nameOrId !== "string" && typeof nameOrId !== "number" || nameOrId === "") {
    throw new Error("completeTaskSpace requires a task space name or id");
  }
  if (!options || typeof options.keep !== "boolean") {
    throw new Error("completeTaskSpace requires { keep: boolean }");
  }
  const ego = globalThis.ego;
  if (!ego) {
    throw new Error("completeTaskSpace requires ego runtime");
  }
  const spaces = await listTaskSpaces();
  const match = findMatchingTaskSpace(spaces, nameOrId);
  if (!match) {
    throw new Error(`task space not found: ${nameOrId}`);
  }
  if (options.keep) {
    if (match.ownership === "user") {
      return { done: false, skipped: "user-owned" };
    }
    await selectTaskSpace(ego, match, "completeTaskSpace");
    if (typeof ego.completeTaskSpace !== "function") {
      throw new Error("completeTaskSpace requires ego.completeTaskSpace");
    }
    await invokeEgo("completeTaskSpace", () => ego.completeTaskSpace());
  } else {
    if (match.ownership === "user") {
      await claimResolvedTaskSpace(match, "completeTaskSpace");
    } else {
      await selectTaskSpace(ego, match, "completeTaskSpace");
    }
    if (typeof ego.closeTaskSpace !== "function") {
      throw new Error("completeTaskSpace requires ego.closeTaskSpace");
    }
    await invokeEgo("completeTaskSpace", () => ego.closeTaskSpace());
  }
  return { done: true };
}
async function handOffTaskSpace(nameOrId) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.handOffTaskSpace !== "function") {
    throw new Error("handOffTaskSpace requires ego.handOffTaskSpace");
  }
  if (nameOrId !== void 0) {
    const match = await findTaskSpace(nameOrId, "handOffTaskSpace");
    if (match.ownership === "user") {
      return { done: false, skipped: "user-owned" };
    }
    await selectTaskSpace(ego, match, "handOffTaskSpace");
  }
  await invokeEgo("handOffTaskSpace", () => ego.handOffTaskSpace());
  return { done: true };
}
async function takeOverTaskSpace(nameOrId) {
  const ego = globalThis.ego;
  if (!ego || typeof ego.takeOverTaskSpace !== "function") {
    throw new Error("takeOverTaskSpace requires ego.takeOverTaskSpace");
  }
  let descriptor;
  if (nameOrId !== void 0) {
    descriptor = await findTaskSpace(nameOrId, "takeOverTaskSpace");
    await selectTaskSpace(ego, descriptor, "takeOverTaskSpace");
  }
  await invokeEgo("takeOverTaskSpace", () => ego.takeOverTaskSpace());
  if (descriptor) {
    const task = createTaskSpaceHandle({ ...descriptor, ownership: "agent" });
    if (descriptor.ownership === "agentDelegatedToUser") {
      await captureTaskSpaceUserBoundary(task);
    }
    await initializeTaskSpaceHandle(task);
    return task;
  }
}
async function probeCurrentAgentControl() {
  const ego = globalThis.ego;
  if (!ego || typeof ego.snapshot !== "function") return false;
  return probeAgentControl(() => ego.snapshot({ maxResultLength: 1 }));
}
async function waitForAgentControl(nameOrId, options = {}) {
  if (typeof nameOrId !== "string" && typeof nameOrId !== "number" || nameOrId === "") {
    throw new Error("waitForAgentControl requires a task space name or id");
  }
  const ego = globalThis.ego;
  if (!ego) {
    throw new Error("waitForAgentControl requires ego runtime");
  }
  await selectTaskSpaceIfProvided(ego, nameOrId, "waitForAgentControl");
  const interval = typeof options.interval === "number" ? options.interval : 20;
  const timeout = typeof options.timeout === "number" ? options.timeout : 600;
  const deadline = Date.now() + timeout * 1e3;
  while (true) {
    if (await probeCurrentAgentControl()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitForAgentControl timed out after ${timeout}s`);
    }
    await waits.wait(interval);
  }
}
function normalizeTaskSpaces(raw) {
  if (Array.isArray(raw?.taskSpaces)) {
    return raw.taskSpaces.map(normalizeTaskSpace).filter(Boolean);
  }
  throw new Error("listTaskSpaces expected { taskSpaces: [...] }");
}
function normalizeTaskSpace(space) {
  if (space?.id === void 0 || space?.id === null) {
    return null;
  }
  const name = space.name ?? space.taskId ?? "";
  return {
    ...space,
    taskId: space.taskId ?? name,
    name
  };
}
function taskSpaceNumericId(space, op) {
  if (typeof space?.id !== "number" || !Number.isFinite(space.id)) {
    throw new Error(
      `${op} requires a numeric task space id, got ${JSON.stringify(space?.id)}`
    );
  }
  return space.id;
}
async function findTaskSpace(nameOrId, op) {
  assertTaskSpaceLocator(op, nameOrId);
  const spaces = await listTaskSpaces();
  const match = findMatchingTaskSpace(spaces, nameOrId);
  if (!match) throw new Error(`task space not found: ${nameOrId}`);
  return match;
}
function assertTaskSpaceLocator(op, nameOrId) {
  if (typeof nameOrId === "number" && Number.isSafeInteger(nameOrId)) return;
  if (typeof nameOrId === "string" && nameOrId.trim() !== "") return;
  throw new TypeError(
    `${op} expects a task-space name (non-empty string) or numeric id, got ${describeLocator(nameOrId)}. listTaskSpaces() entries expose the numeric id as "id"; pass entry.id.`
  );
}
function assertTaskSpaceName(op, name) {
  if (typeof name === "string" && name.trim() !== "") return;
  throw new TypeError(
    `${op} expects a non-empty task-space name, got ${describeLocator(name)}`
  );
}
function describeLocator(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || value == null) return String(value);
  return typeof value;
}
function findMatchingTaskSpace(spaces, nameOrId) {
  if (typeof nameOrId === "number") {
    return spaces.find((space) => space.id === nameOrId);
  }
  const byName = spaces.find(
    (space) => space.name === nameOrId || space.taskId === nameOrId
  );
  if (byName) return byName;
  if (/^\d+$/.test(nameOrId)) {
    const id = Number(nameOrId);
    if (Number.isFinite(id)) {
      return spaces.find((space) => space.id === id);
    }
  }
  return void 0;
}
async function siteSkillsForUrl(url) {
  return siteSkillsForUrlCore(url, {
    agentWorkspace: state.agentWorkspace()
  });
}
async function siteSkills(url = void 0) {
  const targetUrl = url ?? (await nav.pageInfo()).url ?? "";
  return siteSkillsForUrl(targetUrl);
}
async function runSiteTool(siteId, toolName, args = {}) {
  return runNodeSiteTool(siteId, toolName, args, helperContext(), {
    agentWorkspace: state.agentWorkspace()
  });
}
async function runSiteBrowserTool(siteId, toolName, args = {}) {
  const source = await loadBrowserToolSource(siteId, toolName, {
    agentWorkspace: state.agentWorkspace()
  });
  return js(wrapBrowserTool(source, args));
}
async function learnContext(url = void 0) {
  const targetUrl = url ?? (await nav.pageInfo()).url ?? "";
  return loadLearnedContext(targetUrl, {
    agentWorkspace: state.agentWorkspace()
  });
}
function helperContext(extra = {}, {
  printHelp = (text) => bufferOutput(`${text}
`)
} = {}) {
  const { newTab: _newTab, ...publicNav } = nav;
  const all = {
    ...pointer,
    ...keyboard,
    ...publicNav,
    ...observe,
    ...waits,
    ...files,
    cdp,
    js,
    serverFetch,
    browserFetch,
    siteSkills,
    siteSkillsForUrl,
    runSiteTool,
    runSiteBrowserTool,
    learnContext,
    profiles,
    listTaskSpaces,
    switchTaskSpace,
    newTaskSpace,
    taskSpace,
    useOrCreateTaskSpace,
    claimTaskSpace,
    completeTaskSpace,
    handOffTaskSpace,
    takeOverTaskSpace,
    waitForAgentControl,
    ...extra
  };
  return {
    ...all,
    // The formal 1.3 Skill starts through egoBrowser.*. Keep a narrow guard so
    // stale conversations get a recovery instruction instead of a ReferenceError.
    egoBrowser: createStaleEgoBrowserGuard(),
    // help() prints its text so `ego-browser nodejs -e 'help()'` shows it, and
    // still returns the text for scripts that already log or inspect it.
    help: (...names) => {
      const result = helpRuntime(all, ...names);
      const text = typeof result === "string" ? result : Array.isArray(result) ? result.map(formatHelp).join("\n\n") : formatHelp(result);
      printHelp(text);
      return text;
    }
  };
}
async function loadAgentHelpers() {
  const path = join(state.agentWorkspace(), "agent_helpers.js");
  if (!existsSync(path)) {
    return {};
  }
  const module = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
  const out = {};
  for (const [name, value] of Object.entries(module)) {
    if (!name.startsWith("_")) {
      out[name] = value;
    }
  }
  return out;
}
const __testing = { setOverrides, decodeUnserializableJsValue };
export {
  INTERNAL_URL_PREFIXES,
  NAME,
  __testing,
  browserFetch2 as browserFetch,
  captureScreenshot,
  cdp2 as cdp,
  claimTaskSpace,
  click,
  closeTab,
  completeTaskSpace,
  currentTab,
  dispatchKey,
  doubleClick,
  dragMouse,
  drainEvents,
  elementCenter,
  ensureRealTab,
  fillInput,
  gotoAndWait,
  gotoUrl,
  handOffTaskSpace,
  helperContext,
  hover,
  iframeTarget,
  js2 as js,
  learnContext,
  listTabs,
  listTaskSpaces,
  loadAgentHelpers,
  newTaskSpace,
  openOrReuseTab,
  pageInfo,
  pressKey,
  profiles,
  runSiteBrowserTool,
  runSiteTool,
  scroll,
  scrollBy,
  scrollToBottomUntil,
  serverFetch2 as serverFetch,
  siteSkills,
  siteSkillsForUrl,
  snapshot,
  snapshotRaw,
  snapshotText,
  switchTab,
  switchTaskSpace,
  takeOverTaskSpace,
  taskSpace,
  typeText,
  uploadFile,
  useOrCreateTaskSpace,
  wait,
  waitForAgentControl,
  waitForElement,
  waitForLoad,
  waitForNetworkIdle
};
