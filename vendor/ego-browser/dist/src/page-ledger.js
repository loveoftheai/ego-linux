import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runtimeStateDir } from "./env.js";
import {
  validatePageRefState
} from "./page-ref-registry.js";
const DEFAULT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1e3;
const MAX_WRITE_CONFLICTS = 8;
const LEDGER_FILE_PATTERN = /^space-\d+(@[A-Za-z0-9_-]+)?(\.\d+)?\.json$/;
const LOCKED_CODES = /* @__PURE__ */ new Set(["EPERM", "EACCES", "EBUSY"]);
const LOCKED_READ_ATTEMPTS = 10;
const LOCKED_READ_BASE_MS = 20;
const LOCKED_READ_MAX_MS = 250;
class LedgerWriteConflict extends Error {
}
class LedgerLockedError extends Error {
  constructor(path, cause) {
    super(
      `cannot read page ledger ${path}: ${cause.message}. Another process holds the file open; the ledger was left unchanged`,
      { cause }
    );
    this.name = "LedgerLockedError";
  }
}
function runtimeInstanceId(parentPid = process.ppid) {
  const fromEnv = process.env.EGO_BROWSER_INSTANCE_ID;
  if (fromEnv !== void 0 && fromEnv.length > 0) return fromEnv;
  return `browser-host:${parentPid}`;
}
class PageLedgerStore {
  rootDir;
  #browserInstanceId;
  #staleAfterMs;
  #now;
  #remove;
  #read;
  #sleep;
  #resolvedBrowserInstanceId;
  #cleanup;
  constructor(options = {}) {
    this.rootDir = options.rootDir || runtimeStateDir();
    this.#browserInstanceId = options.browserInstanceId;
    this.#staleAfterMs = options.staleAfterMs === void 0 ? DEFAULT_STALE_AFTER_MS : options.staleAfterMs;
    this.#now = options.now || Date.now;
    this.#remove = options.remove || ((path) => rm(path, { force: true }));
    this.#read = options.read || ((path) => readFile(path, "utf8"));
    this.#sleep = options.sleep || sleep;
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
    await this.#writeLatest(spaceId, ledger);
    return { label, ...entry };
  }
  /**
   * Remove all Page-model state after its task space is finished or closed.
   * A version that another process still holds open stays behind; it is
   * expired like any other stale ledger.
   */
  async discard(spaceId) {
    assertSpaceId(spaceId);
    const browserInstanceId = await this.#currentBrowserInstanceId();
    await this.#removeAll(await this.#listVersions(spaceId, browserInstanceId));
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
    for (let conflicts = 0; ; conflicts++) {
      const { ledger, files } = await this.#load(spaceId);
      mutate(ledger);
      try {
        await this.#write(spaceId, ledger, files);
        return cloneLedger(ledger);
      } catch (error) {
        if (!(error instanceof LedgerWriteConflict) || conflicts >= MAX_WRITE_CONFLICTS) {
          throw error;
        }
      }
    }
  }
  async #readCurrent(spaceId) {
    return (await this.#load(spaceId)).ledger;
  }
  /**
   * The current ledger plus every version file it was chosen from. A version
   * held open by another process is retried with backoff, then reported.
   */
  async #load(spaceId) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#loadOnce(spaceId);
      } catch (error) {
        if (!(error instanceof LedgerLockedError) || attempt >= LOCKED_READ_ATTEMPTS) {
          throw error;
        }
        await this.#sleep(
          Math.min(LOCKED_READ_BASE_MS * 2 ** attempt, LOCKED_READ_MAX_MS)
        );
      }
    }
  }
  async #loadOnce(spaceId) {
    const browserInstanceId = await this.#currentBrowserInstanceId();
    await this.#cleanupExpiredLedgers(browserInstanceId);
    const files = await this.#listVersions(spaceId, browserInstanceId);
    for (const file of files) {
      const stored = await this.#readLedgerJson(file.path);
      if (stored === void 0) continue;
      return {
        ledger: ownedLedger(stored, spaceId, file.path, browserInstanceId) || emptyLedger(spaceId, browserInstanceId),
        files
      };
    }
    if (browserInstanceId === void 0 || files.length > 0) {
      return { ledger: emptyLedger(spaceId, browserInstanceId), files };
    }
    const legacyPath = this.#legacyPath(spaceId);
    const legacy = await this.#readLedgerJson(legacyPath);
    const ledger = legacy === void 0 ? void 0 : ownedLedger(legacy, spaceId, legacyPath, browserInstanceId);
    if (!ledger) {
      return { ledger: emptyLedger(spaceId, browserInstanceId), files };
    }
    ledger.browserInstanceId = browserInstanceId;
    const written = await this.#writeLatest(spaceId, ledger);
    await this.#remove(legacyPath).catch(() => {
    });
    return { ledger, files: written };
  }
  /** Write `ledger` as the next version, whatever versions exist right now. */
  async #writeLatest(spaceId, ledger) {
    const browserInstanceId = await this.#currentBrowserInstanceId();
    for (let conflicts = 0; ; conflicts++) {
      const files = await this.#listVersions(spaceId, browserInstanceId);
      try {
        return await this.#write(spaceId, ledger, files);
      } catch (error) {
        if (!(error instanceof LedgerWriteConflict) || conflicts >= MAX_WRITE_CONFLICTS) {
          throw error;
        }
      }
    }
  }
  /**
   * Create the version after `files` (the listing the ledger was loaded
   * from), then remove those superseded versions. Another writer that got
   * there first raises LedgerWriteConflict so the caller reloads instead of
   * overwriting its update.
   */
  async #write(spaceId, ledger, files) {
    await mkdir(this.rootDir, { recursive: true, mode: 448 });
    const seq = (files[0]?.seq ?? 0) + 1;
    const path = `${this.#base(spaceId, await this.#currentBrowserInstanceId())}.${seq}.json`;
    try {
      await writeFile(path, `${JSON.stringify(ledger, null, 2)}
`, {
        encoding: "utf8",
        flag: "wx",
        mode: 384
      });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new LedgerWriteConflict(
          `page ledger ${path} was written concurrently`
        );
      }
      throw error;
    }
    await this.#removeAll(files);
    return [{ seq, path }];
  }
  /** Best-effort removal: a version held open elsewhere is left behind. */
  async #removeAll(files) {
    await Promise.all(
      files.map((file) => this.#remove(file.path).catch(() => {
      }))
    );
  }
  /** Every version of one space's ledger, newest first; the unnumbered legacy file is version 0. */
  async #listVersions(spaceId, browserInstanceId) {
    let names;
    try {
      names = await readdir(this.rootDir);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const base = `space-${spaceId}${scopeSuffix(browserInstanceId)}`;
    const pattern = new RegExp(`^${base}(?:\\.(\\d+))?\\.json$`);
    return names.flatMap((name) => {
      const match = pattern.exec(name);
      if (!match) return [];
      return [
        {
          seq: match[1] ? Number(match[1]) : 0,
          path: join(this.rootDir, name)
        }
      ];
    }).sort((a, b) => b.seq - a.seq);
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
      names.filter((name) => LEDGER_FILE_PATTERN.test(name)).map(async (name) => {
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
  /**
   * Read one ledger document. Returns undefined when the file is gone or does
   * not parse: a version another process is still writing, or one left
   * truncated by a crash, must not shadow the version before it. A file that
   * exists but cannot be opened is reported instead, so a reader never
   * mistakes a locked current version for a missing one.
   */
  async #readLedgerJson(path) {
    let raw;
    try {
      raw = await this.#read(path);
    } catch (error) {
      if (error?.code === "ENOENT") return void 0;
      if (LOCKED_CODES.has(error?.code)) {
        throw new LedgerLockedError(path, error);
      }
      throw error;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return void 0;
    }
  }
  #base(spaceId, browserInstanceId) {
    return join(
      this.rootDir,
      `space-${spaceId}${scopeSuffix(browserInstanceId)}`
    );
  }
  /** The shared, unnumbered file that SDKs before instance ids wrote. */
  #legacyPath(spaceId) {
    return `${this.#base(spaceId)}.json`;
  }
}
function scopeSuffix(browserInstanceId) {
  return browserInstanceId === void 0 ? "" : `@${browserInstanceId.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}
function ownedLedger(value, spaceId, path, browserInstanceId) {
  const storedBrowserInstanceId = ledgerBrowserInstanceId(value);
  if (browserInstanceId !== void 0 && storedBrowserInstanceId !== void 0 && storedBrowserInstanceId !== browserInstanceId) {
    return void 0;
  }
  return validateLedger(value, spaceId, path);
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
