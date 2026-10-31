import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  validatePageRefState
} from "./page-ref-registry.js";
const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1e3;
function runtimeInstanceId(parentPid = process.ppid) {
  const fromEnv = process.env.EGO_BROWSER_INSTANCE_ID;
  if (fromEnv !== void 0 && fromEnv.length > 0) return fromEnv;
  return `browser-host:${parentPid}`;
}
class PageLedgerStore {
  rootDir;
  #writeToken = randomUUID();
  #browserInstanceId;
  #staleAfterMs;
  #now;
  #temporarySequence = 0;
  #resolvedBrowserInstanceId;
  #cleanup;
  constructor(options = {}) {
    this.rootDir = options.rootDir || process.env.EGO_BROWSER_STATE_DIR || join(homedir(), ".ego-browser", "state");
    this.#browserInstanceId = options.browserInstanceId;
    this.#staleAfterMs = options.staleAfterMs === void 0 ? DEFAULT_STALE_AFTER_MS : options.staleAfterMs;
    this.#now = options.now || Date.now;
    if (!Number.isFinite(this.#staleAfterMs) || this.#staleAfterMs < 0) {
      throw new TypeError("staleAfterMs must be a non-negative number");
    }
  }
  async read(spaceId) {
    assertSpaceId(spaceId);
    const ledger = await this.#readCurrent(spaceId);
    return cloneLedger(ledger);
  }
  /** Replace any stale state for a newly created space with its Agent-owned p1. */
  async initializeCreatedSpace(spaceId, targetId) {
    assertSpaceId(spaceId);
    assertTargetId(targetId);
    const browserInstanceId = await this.#currentBrowserInstanceId();
    await this.#cleanupExpiredLedgers(browserInstanceId);
    const ledger = emptyLedger(spaceId, browserInstanceId);
    const label = nextAutomaticLabel(ledger, /* @__PURE__ */ new Set());
    const entry = { targetId, openedBy: "agent" };
    ledger.initialized = true;
    ledger.usedLabels.push(label);
    ledger.pages[label] = entry;
    await this.#writeAtomic(spaceId, ledger);
    return { label, ...entry };
  }
  /** Remove all Page-model state after its task space is finished or closed. */
  async discard(spaceId) {
    assertSpaceId(spaceId);
    await rm(this.#path(spaceId), { force: true });
  }
  async getPage(spaceId, label) {
    assertLabel(label);
    const ledger = await this.read(spaceId);
    const entry = ledger.pages[label];
    if (entry) return { label, ...entry };
    if (ledger.releasedLabels.includes(label)) {
      throw new Error(`page ${label} was released`);
    }
    if (ledger.usedLabels.includes(label)) {
      throw new Error(`page ${label} was closed`);
    }
    throw new Error(`page label not found: ${label}`);
  }
  async addPage(spaceId, targetId, options = {}) {
    assertTargetId(targetId);
    if (options.as !== void 0) assertLabel(options.as);
    let added;
    await this.#update(spaceId, (ledger) => {
      const existing = Object.entries(ledger.pages).find(
        ([, page]) => page.targetId === targetId
      );
      if (existing) {
        throw new Error(`target ${targetId} is already page ${existing[0]}`);
      }
      const used = new Set(ledger.usedLabels);
      const label = options.as || nextAutomaticLabel(ledger, used);
      if (used.has(label)) {
        throw new Error(`page label already used: ${label}`);
      }
      const entry = {
        targetId,
        openedBy: options.openedBy || "agent"
      };
      ledger.initialized = true;
      delete ledger.unmanagedTargets[targetId];
      ledger.usedLabels.push(label);
      ledger.pages[label] = entry;
      added = { label, ...entry };
    });
    return added;
  }
  async setPageRefs(spaceId, label, refs) {
    assertLabel(label);
    await this.#update(spaceId, (ledger) => {
      const page = ledger.pages[label];
      if (!page) throw new Error(`page label not found: ${label}`);
      page.refs = validatePageRefState(refs);
    });
  }
  async closePage(spaceId, label) {
    assertLabel(label);
    let removed;
    await this.#update(spaceId, (ledger) => {
      const entry = ledger.pages[label];
      if (!entry) {
        if (ledger.releasedLabels.includes(label)) {
          throw new Error(`page ${label} was released`);
        }
        if (ledger.usedLabels.includes(label)) {
          throw new Error(`page ${label} was closed`);
        }
        throw new Error(`page label not found: ${label}`);
      }
      removed = { label, ...entry };
      delete ledger.pages[label];
    });
    return removed;
  }
  async releasePage(spaceId, label) {
    assertLabel(label);
    let removed;
    await this.#update(spaceId, (ledger) => {
      const entry = ledger.pages[label];
      if (!entry) {
        if (ledger.releasedLabels.includes(label)) {
          throw new Error(`page ${label} was released`);
        }
        if (ledger.usedLabels.includes(label)) {
          throw new Error(`page ${label} was closed`);
        }
        throw new Error(`page label not found: ${label}`);
      }
      removed = { label, ...entry };
      delete ledger.pages[label];
      ledger.releasedLabels.push(label);
      ledger.unmanagedTargets[entry.targetId] = entry.openedBy;
    });
    return removed;
  }
  async keepUnmanaged(spaceId, targetId, openedBy = "unknown") {
    assertTargetId(targetId);
    if (!["agent", "unknown"].includes(openedBy)) {
      throw new TypeError(`invalid unmanaged page origin: ${openedBy}`);
    }
    await this.#update(spaceId, (ledger) => {
      const existing = Object.entries(ledger.pages).find(
        ([, page]) => page.targetId === targetId
      );
      if (existing) {
        throw new Error(`target ${targetId} is already page ${existing[0]}`);
      }
      ledger.initialized = true;
      ledger.unmanagedTargets[targetId] = openedBy;
    });
  }
  /** Mark the next reconciliation as crossing a user-control boundary. */
  async beginUserControl(spaceId) {
    await this.#update(spaceId, (ledger) => {
      ledger.userControlPending = true;
    });
  }
  /** Roll back a boundary marker when the native handoff itself fails. */
  async cancelUserControl(spaceId) {
    await this.#update(spaceId, (ledger) => {
      ledger.userControlPending = false;
    });
  }
  async reconcile(spaceId, liveTargetIds, options = {}) {
    const live = new Set(liveTargetIds);
    const current = await this.read(spaceId);
    const hasMissingPage = Object.values(current.pages).some(
      (page) => !live.has(page.targetId)
    );
    const hasMissingUnmanaged = Object.keys(current.unmanagedTargets).some(
      (targetId) => !live.has(targetId)
    );
    const knownTargets = /* @__PURE__ */ new Set([
      ...Object.values(current.pages).map((page) => page.targetId),
      ...Object.keys(current.unmanagedTargets)
    ]);
    const newTargets = [...live].filter(
      (targetId) => !knownTargets.has(targetId)
    );
    const needsInitialization = !current.initialized;
    const protectsUserTabs = options.afterUserControl || current.userControlPending;
    const shouldAdopt = current.initialized && options.autoAdoptNew && !protectsUserTabs && newTargets.length > 0;
    if (!hasMissingPage && !hasMissingUnmanaged && !needsInitialization && !protectsUserTabs && !shouldAdopt) {
      return current;
    }
    return this.#update(spaceId, (ledger) => {
      for (const [label, page] of Object.entries(ledger.pages)) {
        if (!live.has(page.targetId)) delete ledger.pages[label];
      }
      for (const targetId of Object.keys(ledger.unmanagedTargets)) {
        if (!live.has(targetId)) delete ledger.unmanagedTargets[targetId];
      }
      const managedTargets = new Set(
        Object.values(ledger.pages).map((page) => page.targetId)
      );
      const untracked = [...live].filter(
        (targetId) => !managedTargets.has(targetId) && !Object.hasOwn(ledger.unmanagedTargets, targetId)
      );
      if (!ledger.initialized) {
        for (const targetId of untracked) {
          ledger.unmanagedTargets[targetId] = "unknown";
        }
        ledger.initialized = true;
        ledger.userControlPending = false;
        return;
      }
      if (protectsUserTabs) {
        for (const targetId of untracked) {
          ledger.unmanagedTargets[targetId] = "unknown";
        }
        ledger.userControlPending = false;
        return;
      }
      if (!options.autoAdoptNew) return;
      const used = new Set(ledger.usedLabels);
      for (const targetId of untracked) {
        const label = nextAutomaticLabel(ledger, used);
        used.add(label);
        ledger.usedLabels.push(label);
        ledger.pages[label] = {
          targetId,
          openedBy: "agent"
        };
      }
    });
  }
  async #update(spaceId, mutate) {
    assertSpaceId(spaceId);
    const next = await this.#readCurrent(spaceId);
    mutate(next);
    await this.#writeAtomic(spaceId, next);
    return cloneLedger(next);
  }
  async #readCurrent(spaceId) {
    const browserInstanceId = await this.#currentBrowserInstanceId();
    await this.#cleanupExpiredLedgers(browserInstanceId);
    const path = this.#path(spaceId);
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return emptyLedger(spaceId, browserInstanceId);
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`invalid page ledger ${path}: ${error.message}`);
    }
    const storedBrowserInstanceId = ledgerBrowserInstanceId(parsed);
    if (browserInstanceId !== void 0 && storedBrowserInstanceId !== void 0 && storedBrowserInstanceId !== browserInstanceId) {
      return emptyLedger(spaceId, browserInstanceId);
    }
    const ledger = validateLedger(parsed, spaceId, path);
    if (browserInstanceId !== void 0 && storedBrowserInstanceId === void 0) {
      ledger.browserInstanceId = browserInstanceId;
      await this.#writeAtomic(spaceId, ledger);
    }
    return ledger;
  }
  async #currentBrowserInstanceId() {
    this.#resolvedBrowserInstanceId ||= Promise.resolve(
      typeof this.#browserInstanceId === "function" ? this.#browserInstanceId() : this.#browserInstanceId
    ).then((value) => {
      if (value === void 0) return void 0;
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError("browserInstanceId must be a non-empty string");
      }
      return value;
    });
    return this.#resolvedBrowserInstanceId;
  }
  async #cleanupExpiredLedgers(browserInstanceId) {
    if (browserInstanceId === void 0) return;
    this.#cleanup ||= this.#removeExpiredLedgers(browserInstanceId);
    await this.#cleanup;
  }
  async #removeExpiredLedgers(browserInstanceId) {
    let names;
    try {
      names = await readdir(this.rootDir);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    await Promise.all(
      names.filter((name) => /^space-\d+\.json$/.test(name)).map(async (name) => {
        const path = join(this.rootDir, name);
        const metadata = await stat(path).catch(() => void 0);
        if (!metadata || this.#now() - metadata.mtimeMs < this.#staleAfterMs) {
          return;
        }
        let storedInstanceId;
        try {
          storedInstanceId = ledgerBrowserInstanceId(
            JSON.parse(await readFile(path, "utf8"))
          );
        } catch {
        }
        if (storedInstanceId !== browserInstanceId) {
          await rm(path, { force: true });
        }
      })
    );
  }
  async #writeAtomic(spaceId, ledger) {
    await mkdir(this.rootDir, { recursive: true, mode: 448 });
    const path = this.#path(spaceId);
    const temporary = `${path}.${process.pid}.${this.#writeToken}.${++this.#temporarySequence}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}
`, {
        encoding: "utf8",
        mode: 384
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {
      });
    }
  }
  #path(spaceId) {
    return join(this.rootDir, `space-${spaceId}.json`);
  }
}
function emptyLedger(spaceId, browserInstanceId) {
  return {
    ...browserInstanceId ? { browserInstanceId } : {},
    spaceId,
    nextLabel: 1,
    usedLabels: [],
    releasedLabels: [],
    initialized: false,
    userControlPending: false,
    unmanagedTargets: {},
    pages: {}
  };
}
function ledgerBrowserInstanceId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return void 0;
  }
  const browserInstanceId = value.browserInstanceId;
  return typeof browserInstanceId === "string" && browserInstanceId.length > 0 ? browserInstanceId : void 0;
}
function nextAutomaticLabel(ledger, used) {
  let sequence = ledger.nextLabel;
  let label = `p${sequence}`;
  while (used.has(label)) {
    sequence += 1;
    label = `p${sequence}`;
  }
  ledger.nextLabel = sequence + 1;
  return label;
}
function validateLedger(value, expectedSpaceId, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid page ledger ${path}: expected an object`);
  }
  const stored = value;
  const releasedLabels = stored.releasedLabels ?? [];
  const initialized = stored.initialized ?? false;
  const legacyHandoffBaseline = stored.handoffBaseline;
  const userControlPending = stored.userControlPending ?? (legacyHandoffBaseline !== void 0 && legacyHandoffBaseline !== null);
  const unmanagedTargets = stored.unmanagedTargets ?? {};
  if (stored.browserInstanceId !== void 0 && (typeof stored.browserInstanceId !== "string" || stored.browserInstanceId.length === 0) || stored.spaceId !== expectedSpaceId || !Number.isInteger(stored.nextLabel) || stored.nextLabel < 1 || !Array.isArray(stored.usedLabels) || stored.usedLabels.some((label) => typeof label !== "string") || !Array.isArray(releasedLabels) || releasedLabels.some(
    (label) => typeof label !== "string" || !stored.usedLabels.includes(label) || Object.hasOwn(stored.pages || {}, label)
  ) || typeof initialized !== "boolean" || typeof userControlPending !== "boolean" || legacyHandoffBaseline !== void 0 && legacyHandoffBaseline !== null && (!Array.isArray(legacyHandoffBaseline) || legacyHandoffBaseline.some(
    (targetId) => typeof targetId !== "string" || targetId.length === 0
  )) || !unmanagedTargets || typeof unmanagedTargets !== "object" || Array.isArray(unmanagedTargets) || Object.entries(unmanagedTargets).some(
    ([targetId, openedBy]) => targetId.length === 0 || !["agent", "user", "unknown"].includes(openedBy)
  ) || !stored.pages || typeof stored.pages !== "object" || Array.isArray(stored.pages)) {
    throw new Error(`invalid page ledger ${path}: schema mismatch`);
  }
  const pages = {};
  for (const [label, page] of Object.entries(stored.pages)) {
    if (!stored.usedLabels.includes(label) || !page || typeof page.targetId !== "string" || !["agent", "user", "unknown"].includes(page.openedBy)) {
      throw new Error(`invalid page ledger ${path}: invalid page ${label}`);
    }
    if (Object.hasOwn(unmanagedTargets, page.targetId)) {
      throw new Error(
        `invalid page ledger ${path}: target ${page.targetId} is both managed and unmanaged`
      );
    }
    pages[label] = {
      targetId: page.targetId,
      openedBy: normalizePageOrigin(page.openedBy),
      ...page.refs === void 0 ? {} : { refs: validatePageRefState(page.refs) }
    };
  }
  const normalizedUnmanagedTargets = Object.fromEntries(
    Object.entries(unmanagedTargets).map(([targetId, openedBy]) => [
      targetId,
      normalizePageOrigin(openedBy)
    ])
  );
  return {
    ...stored.browserInstanceId ? { browserInstanceId: stored.browserInstanceId } : {},
    spaceId: stored.spaceId,
    nextLabel: stored.nextLabel,
    usedLabels: [...stored.usedLabels],
    releasedLabels: [...releasedLabels],
    initialized,
    userControlPending,
    unmanagedTargets: normalizedUnmanagedTargets,
    pages
  };
}
function normalizePageOrigin(value) {
  return value === "agent" ? "agent" : "unknown";
}
function cloneLedger(ledger) {
  return structuredClone(ledger);
}
function assertSpaceId(spaceId) {
  if (!Number.isInteger(spaceId) || spaceId < 0) {
    throw new TypeError("spaceId must be a non-negative integer");
  }
}
function assertTargetId(targetId) {
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new TypeError("targetId must be a non-empty string");
  }
}
function assertLabel(label) {
  if (typeof label !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(label)) {
    throw new TypeError(
      "page label must start with a letter and contain only letters, numbers, _ or -"
    );
  }
}
export {
  PageLedgerStore,
  runtimeInstanceId
};
