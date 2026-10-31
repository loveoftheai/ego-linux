#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import * as helpers from "./helpers.js";
import {
  clearPreferredTarget,
  disposeBrowserRuntime,
  invalidateSession,
  setPreferredTarget
} from "./browser-runtime.js";
import { formatCliLogValue } from "./format.js";
import {
  bufferOutput,
  createRoundConsole,
  installLifecycleFlush,
  resetSink
} from "./output-sink.js";
import { runMain } from "./run.js";
import { installStaleEgoBrowserGuard } from "./skill-migration.js";
import { emitUpdateNotice } from "./update-notice.js";
import { installPageContextGuard } from "./page-context-guard.js";
import { disposeDownloadArtifacts } from "./driver/downloads.js";
export * from "./helpers.js";
import { runMain as runMain2 } from "./run.js";
async function disposeEgoSdk(target = globalThis) {
  disposeDownloadArtifacts();
  disposeBrowserRuntime(target.ego);
}
const SYNC_HELPERS = /* @__PURE__ */ new Set(["help"]);
const EGO_WRAPPED = /* @__PURE__ */ Symbol.for("egoBrowser.sdkWrapped");
function installEgoSdk(target = globalThis, options = {}) {
  if (!target || typeof target !== "object") {
    return target;
  }
  if (target === globalThis) installPageContextGuard(target);
  const usingDefaultCliLog = !options.cliLog;
  const cliLogFn = options.cliLog || createCliLog();
  const context = options.context || helpers.helperContext({}, { printHelp: (text) => cliLogFn(text) });
  const readySignal = Promise.resolve(options.ready);
  void readySignal.catch(() => {
  });
  const installed = {};
  for (const [name, value] of Object.entries(context)) {
    if (typeof value !== "function") {
      continue;
    }
    const exposed = SYNC_HELPERS.has(name) ? value : async (...args) => {
      await readySignal;
      return value(...args);
    };
    Object.defineProperty(target, name, {
      value: exposed,
      writable: true,
      configurable: true,
      enumerable: false
    });
    installed[name] = exposed;
  }
  installStaleEgoBrowserGuard(target);
  Object.defineProperty(target, "cliLog", {
    value: cliLogFn,
    writable: true,
    configurable: true,
    enumerable: false
  });
  installed.cliLog = cliLogFn;
  Object.defineProperty(target, "console", {
    value: createRoundConsole(
      usingDefaultCliLog ? void 0 : (line) => cliLogFn(line.endsWith("\n") ? line.slice(0, -1) : line)
    ),
    writable: true,
    configurable: true,
    enumerable: false
  });
  if (usingDefaultCliLog) {
    resetSink();
    installLifecycleFlush(process.stdout);
  }
  if (target.ego && typeof target.ego === "object") {
    void emitUpdateNotice(target.ego, (line) => {
      if (usingDefaultCliLog) bufferOutput(`${line}
`);
      else cliLogFn(line);
    });
    target.ego.helpers = installed;
    target.ego.learnings = {};
    if (!target.ego[EGO_WRAPPED]) {
      const taskSelection = {};
      wrapCreateTab(target.ego);
      wrapUseTaskSpace(target.ego, taskSelection);
      wrapInvalidating(
        target.ego,
        ["closeTaskSpace", "createTaskSpace", "claimTaskSpace"],
        () => {
          taskSelection.spaceId = void 0;
        }
      );
      Object.defineProperty(target.ego, EGO_WRAPPED, {
        value: true,
        enumerable: false
      });
    }
    exposeEgoMethods(target, target.ego);
  }
  return target;
}
if (isDirectCli()) {
  try {
    process.exitCode = await runMain();
  } catch (error) {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  } finally {
    disposeDownloadArtifacts();
  }
} else {
  installEgoSdk();
}
function createCliLog() {
  return (...args) => {
    bufferOutput(`${args.map(formatCliLogValue).join(" ")}
`);
  };
}
function isDirectCli() {
  return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
}
function wrapInvalidating(ego, methodNames, resetSelection = () => {
}) {
  for (const name of methodNames) {
    const original = ego[name];
    if (typeof original !== "function") continue;
    const after = () => {
      resetSelection();
      invalidateSession();
      clearPreferredTarget();
    };
    ego[name] = function(...args) {
      const result = original.apply(this, args);
      if (result && typeof result.then === "function") {
        return result.then((value) => {
          after();
          return value;
        });
      }
      after();
      return result;
    };
  }
}
function wrapUseTaskSpace(ego, selection) {
  const original = ego.useTaskSpace;
  if (typeof original !== "function") return;
  const after = (spaceId, value) => {
    if (value && typeof value === "object" && Object.hasOwn(value, "error")) {
      return value;
    }
    if (selection.spaceId !== spaceId) {
      invalidateSession();
      clearPreferredTarget();
      selection.spaceId = spaceId;
    }
    return value;
  };
  ego.useTaskSpace = function(...args) {
    const result = original.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.then((value) => after(args[0], value));
    }
    return after(args[0], result);
  };
}
function wrapCreateTab(ego) {
  const original = ego.createTab;
  if (typeof original !== "function") return;
  ego.createTab = function(...args) {
    const result = original.apply(this, args);
    if (result && typeof result.then === "function") {
      return result.then((value) => {
        const id = value?.targetId || value?.result?.targetId;
        if (id) setPreferredTarget(id);
        return value;
      });
    }
    return result;
  };
}
function exposeEgoMethods(target, ego) {
  const skip = /* @__PURE__ */ new Set([
    "helpers",
    "learnings",
    "useTaskSpace",
    "createTaskSpace",
    "claimTaskSpace",
    "closeTaskSpace"
  ]);
  for (const key of Object.keys(ego)) {
    if (skip.has(key)) continue;
    if (key in target) continue;
    const value = ego[key];
    if (typeof value !== "function") continue;
    const bound = value.bind(ego);
    Object.defineProperty(target, key, {
      value: bound,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }
}
export {
  disposeEgoSdk,
  installEgoSdk,
  runMain2 as runMain
};
