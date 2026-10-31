import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { runtimeStateDir } from "../env.js";
const WAITERS_DIRECTORY = "waiters";
const STALE_WAITER_MS = 60 * 60 * 1e3;
const WAITER_REFRESH_MS = 10 * 60 * 1e3;
const STALE_FILE_MS = 24 * 60 * 60 * 1e3;
const FILE_POLL_INTERVAL_MS = 50;
let sharedDirectory;
let waiterRefreshTimer;
const ownedFiles = /* @__PURE__ */ new Set();
const armedInterceptions = /* @__PURE__ */ new Set();
const activeInterceptions = /* @__PURE__ */ new Set();
const activeDownloadTargets = /* @__PURE__ */ new Set();
function downloadDirectory() {
  if (sharedDirectory) return sharedDirectory;
  const directory = join(runtimeStateDir(), "downloads");
  mkdirSync(join(directory, WAITERS_DIRECTORY), { recursive: true });
  removeStaleFiles(directory);
  sharedDirectory = directory;
  return directory;
}
function preparePageDownload(services, targetId, { timeoutMs }) {
  if (activeDownloadTargets.has(targetId)) {
    throw new Error(`${targetId} is already waiting for a download`);
  }
  activeDownloadTargets.add(targetId);
  const token = Symbol(targetId);
  const configuredSessions = /* @__PURE__ */ new Set();
  let guid;
  let filePath;
  let disposed = false;
  let settled = false;
  let filePollTimer;
  let resolveEvent;
  let rejectEvent;
  let resolveCompletion;
  const event = new Promise((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  void event.catch(() => {
  });
  const completion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  const restoreBehavior = async () => {
    const sessions = [...configuredSessions];
    configuredSessions.clear();
    if (!releaseSharedBehavior(token)) return;
    const restored = await Promise.all(
      sessions.map(
        (sessionId) => services.cdp(
          "Page.setDownloadBehavior",
          { behavior: "default" },
          sessionId,
          1e3
        ).then(
          () => sessionId,
          () => void 0
        )
      )
    );
    const session = restored.find((sessionId) => sessionId !== void 0);
    if (!session || armedInterceptions.size > 0 || !hasOtherLiveWaiter()) {
      return;
    }
    await services.cdp(
      "Page.setDownloadBehavior",
      { behavior: "allowAndName", downloadPath: downloadDirectory() },
      session,
      1e3
    ).catch(() => {
    });
  };
  const finish = async (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (filePollTimer) clearTimeout(filePollTimer);
    unsubscribe();
    activeInterceptions.delete(disposeSynchronously);
    await restoreBehavior();
    activeDownloadTargets.delete(targetId);
    resolveCompletion(result);
  };
  const checkForDownloadedFile = async () => {
    filePollTimer = void 0;
    if (disposed || settled || !filePath) return;
    try {
      await stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        scheduleFileCheck();
        return;
      }
      await finish({ failure: asError(error).message });
      return;
    }
    await finish({ path: filePath, failure: null });
  };
  const scheduleFileCheck = () => {
    if (disposed || settled || filePollTimer) return;
    filePollTimer = setTimeout(
      () => void checkForDownloadedFile(),
      FILE_POLL_INTERVAL_MS
    );
  };
  const onEvent = (message) => {
    const params = message?.params;
    if (message?.method === "Page.downloadWillBegin" && !guid) {
      if (typeof params?.guid !== "string" || typeof params?.url !== "string" || typeof params?.suggestedFilename !== "string") {
        return;
      }
      guid = params.guid;
      filePath = join(downloadDirectory(), params.guid);
      ownedFiles.add(filePath);
      clearTimeout(timer);
      resolveEvent(
        new PageDownloadArtifact(
          services,
          targetId,
          params.guid,
          params.url,
          params.suggestedFilename,
          filePath,
          completion
        )
      );
      scheduleFileCheck();
      return;
    }
    if (message?.method !== "Page.downloadProgress" || params?.guid !== guid) {
      return;
    }
    if (params.state === "completed") {
      if (filePollTimer) clearTimeout(filePollTimer);
      filePollTimer = void 0;
      void checkForDownloadedFile();
    } else if (params.state === "canceled") {
      void finish({ failure: "canceled" });
    }
  };
  const unsubscribe = services.subscribePageEvents(targetId, onEvent);
  const disposeSynchronously = () => {
    if (disposed || settled) return;
    disposed = true;
    clearTimeout(timer);
    if (filePollTimer) clearTimeout(filePollTimer);
    unsubscribe();
    activeDownloadTargets.delete(targetId);
    void restoreBehavior();
    rejectEvent(new Error("download waiter was disposed"));
    resolveCompletion({ failure: "download waiter was disposed" });
  };
  activeInterceptions.add(disposeSynchronously);
  const timer = setTimeout(() => {
    if (guid || disposed || settled) return;
    disposed = true;
    unsubscribe();
    activeInterceptions.delete(disposeSynchronously);
    void (async () => {
      await restoreBehavior();
      activeDownloadTargets.delete(targetId);
      rejectEvent(
        new Error(
          `page.waitForEvent("download") timed out after ${timeoutMs}ms`
        )
      );
      resolveCompletion({ failure: "download did not start" });
    })();
  }, timeoutMs);
  return {
    async ready(sessionId) {
      if (disposed || settled) {
        throw new Error("download waiter is no longer active");
      }
      const downloadPath = downloadDirectory();
      configuredSessions.add(sessionId);
      claimSharedBehavior(token);
      await services.cdp(
        "Page.setDownloadBehavior",
        { behavior: "allowAndName", downloadPath },
        sessionId
      );
    },
    event,
    async dispose(reason = new Error("download waiter was disposed")) {
      if (disposed || settled) return;
      disposed = true;
      clearTimeout(timer);
      if (filePollTimer) clearTimeout(filePollTimer);
      unsubscribe();
      activeInterceptions.delete(disposeSynchronously);
      await restoreBehavior();
      activeDownloadTargets.delete(targetId);
      rejectEvent(reason);
      resolveCompletion({ failure: reason.message });
    }
  };
}
class PageDownloadArtifact {
  url;
  suggestedFilename;
  finished;
  #services;
  #targetId;
  #guid;
  #filePath;
  #completion;
  #completionResult;
  constructor(services, targetId, guid, url, suggestedFilename, filePath, completion) {
    this.#services = services;
    this.#targetId = targetId;
    this.#guid = guid;
    this.url = url;
    this.suggestedFilename = suggestedFilename;
    this.#filePath = filePath;
    this.#completion = completion;
    this.finished = completion.then((result) => {
      this.#completionResult = result;
    });
  }
  async saveAs(path) {
    assertAbsolutePath(path, "download.saveAs");
    const sourcePath = await this.path();
    await mkdir(dirname(path), { recursive: true });
    await copyFile(sourcePath, path);
  }
  async path() {
    const result = await this.#completion;
    if (!("path" in result)) {
      throw new Error(`download failed: ${result.failure}`);
    }
    return result.path;
  }
  async failure() {
    return (await this.#completion).failure;
  }
  async cancel() {
    if (this.#completionResult) return;
    try {
      const targetInfo = await this.#services.cdp("Target.getTargetInfo", {
        targetId: this.#targetId
      });
      const browserContextId = targetInfo?.targetInfo?.browserContextId;
      await this.#services.cdp("Browser.cancelDownload", {
        guid: this.#guid,
        ...typeof browserContextId === "string" ? { browserContextId } : {}
      });
    } catch (error) {
      if (this.#completionResult) return;
      throw error;
    }
  }
  async delete() {
    await this.#completion;
    ownedFiles.delete(this.#filePath);
    await rm(this.#filePath, { force: true });
  }
}
function claimSharedBehavior(token) {
  armedInterceptions.add(token);
  writeWaiterMarker();
  if (!waiterRefreshTimer) {
    waiterRefreshTimer = setInterval(writeWaiterMarker, WAITER_REFRESH_MS);
    waiterRefreshTimer.unref?.();
  }
}
function releaseSharedBehavior(token) {
  armedInterceptions.delete(token);
  if (armedInterceptions.size > 0) return false;
  stopWaiterMarker();
  return !hasOtherLiveWaiter();
}
function writeWaiterMarker() {
  try {
    writeFileSync(
      waiterMarkerPath(),
      JSON.stringify({ pid: process.pid, since: Date.now() })
    );
  } catch {
  }
}
function stopWaiterMarker() {
  if (waiterRefreshTimer) clearInterval(waiterRefreshTimer);
  waiterRefreshTimer = void 0;
  rmSync(waiterMarkerPath(), { force: true });
}
function waiterMarkerPath() {
  return join(downloadDirectory(), WAITERS_DIRECTORY, String(process.pid));
}
function hasOtherLiveWaiter() {
  const waitersDirectory = join(downloadDirectory(), WAITERS_DIRECTORY);
  let names;
  try {
    names = readdirSync(waitersDirectory);
  } catch {
    return false;
  }
  const now = Date.now();
  for (const name of names) {
    const path = join(waitersDirectory, name);
    const pid = Number(name);
    if (pid === process.pid) continue;
    let stale = !Number.isInteger(pid) || !isProcessAlive(pid);
    if (!stale) {
      try {
        stale = now - statSync(path).mtimeMs > STALE_WAITER_MS;
      } catch {
        continue;
      }
    }
    if (stale) {
      rmSync(path, { force: true });
      continue;
    }
    return true;
  }
  return false;
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function removeStaleFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_FILE_MS;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(directory, entry.name);
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
    } catch {
    }
  }
}
function assertAbsolutePath(path, method) {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new TypeError(`${method} requires an absolute file path`);
  }
}
function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
function disposeDownloadArtifacts() {
  for (const dispose of [...activeInterceptions]) dispose();
  activeInterceptions.clear();
  activeDownloadTargets.clear();
  if (armedInterceptions.size > 0) {
    armedInterceptions.clear();
    if (sharedDirectory) stopWaiterMarker();
  }
  for (const path of ownedFiles) {
    rmSync(path, { force: true });
    rmSync(`${path}.crdownload`, { force: true });
  }
  ownedFiles.clear();
}
export {
  disposeDownloadArtifacts,
  downloadDirectory,
  preparePageDownload
};
