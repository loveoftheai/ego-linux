import { state } from "../state.js";
import { cdp } from "../cdp-eval.js";
import { resolveHandle, releaseHandle } from "./element-ops.js";
import { ElementResolutionError } from "../element-resolver.js";
import { waitForDocumentLoad } from "./load.js";
import { drainEvents } from "./observe.js";
import {
  ensureNetworkTracking,
  ensureSession,
  isCdpRequestTimeoutError,
  isBrowserRuntime,
  isSessionLostError,
  networkActivity,
  pageNetworkSessions
} from "../browser-runtime.js";
async function wait(seconds = 1) {
  await state.sleep(seconds * 1e3);
}
async function waitForLoad(options = {}) {
  return waitForDocumentLoad(options);
}
async function waitForElement(selector, options = {}) {
  const timeout = options.timeout ?? 10;
  const visible = options.visible ?? false;
  const deadline = state.now() + timeout * 1e3;
  const visibilityFn = "function(){if(typeof this.checkVisibility==='function')return this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(this);return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0';}";
  while (state.now() < deadline) {
    let handle;
    try {
      handle = await resolveHandle(selector);
    } catch (err) {
      if (err instanceof ElementResolutionError && err.kind === "transient") {
        await state.sleep(300);
        continue;
      }
      throw err;
    }
    try {
      if (!visible) return true;
      const response = await cdp(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: visibilityFn,
          objectId: handle.objectId,
          returnByValue: true,
          awaitPromise: false
        },
        handle.sessionId
      );
      if (response.result?.value) return true;
    } catch {
    } finally {
      await releaseHandle(handle.objectId, handle.sessionId);
    }
    await state.sleep(300);
  }
  return false;
}
async function waitForNetworkIdle(options = {}) {
  const timeout = options.timeout ?? 10;
  const idleMs = options.idleMs ?? 500;
  const deadline = state.now() + timeout * 1e3;
  if (isBrowserRuntime()) {
    return waitForBrowserNetworkIdle(deadline, idleMs);
  }
  return waitForLegacyNetworkIdle(deadline, idleMs);
}
async function waitForBrowserNetworkIdle(deadline, idleMs) {
  const sessionId = await ensureSession(
    void 0,
    Math.max(1, deadline - state.now())
  );
  let hasTracked = false;
  while (state.now() < deadline) {
    try {
      const sessionIds = await pageNetworkSessions(
        sessionId,
        Math.max(1, deadline - state.now())
      );
      await ensureNetworkTracking(
        sessionIds,
        Math.max(1, deadline - state.now())
      );
      const activity = networkActivity(sessionIds);
      hasTracked ||= activity.tracking;
      if (activity.tracking && activity.inflight === 0 && state.now() - activity.lastActivityAt >= idleMs) {
        return true;
      }
    } catch (error) {
      if (!hasTracked && isUnsupportedNetworkTrackingError(error)) {
        return waitForPassiveIdle(deadline, idleMs);
      }
      if (!isRetryableNetworkRefreshError(error)) throw error;
    }
    const remaining = deadline - state.now();
    if (remaining <= 0) break;
    await state.sleep(Math.min(100, remaining));
  }
  return false;
}
function isUnsupportedNetworkTrackingError(error) {
  return /Network\.enable.*(?:not found|wasn't found|unsupported|unknown method)/i.test(
    error instanceof Error ? error.message : String(error)
  );
}
function isRetryableNetworkRefreshError(error) {
  if (isCdpRequestTimeoutError(error) || isSessionLostError(error)) return true;
  return /detached Page session/i.test(
    error instanceof Error ? error.message : String(error)
  );
}
async function waitForPassiveIdle(deadline, idleMs) {
  const remaining = deadline - state.now();
  if (remaining < idleMs) return false;
  await state.sleep(idleMs);
  return true;
}
async function waitForLegacyNetworkIdle(deadline, idleMs) {
  let lastActivity = state.now();
  const inflight = /* @__PURE__ */ new Set();
  const ownsNetworkDomain = !state.networkDomainEnabled;
  await cdp("Network.enable").catch(() => {
  });
  try {
    while (state.now() < deadline) {
      const events = await drainEvents();
      for (const event of events) {
        const method = event.method || "";
        const params = event.params || {};
        if (method === "Network.requestWillBeSent") {
          inflight.add(params.requestId);
          lastActivity = state.now();
        } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
          inflight.delete(params.requestId);
          lastActivity = state.now();
        } else if (method.startsWith("Network.")) {
          lastActivity = state.now();
        }
      }
      if (inflight.size === 0 && state.now() - lastActivity >= idleMs) {
        return true;
      }
      await state.sleep(100);
    }
    return false;
  } finally {
    if (ownsNetworkDomain) {
      await cdp("Network.disable").catch(() => {
      });
    }
  }
}
export {
  wait,
  waitForElement,
  waitForLoad,
  waitForNetworkIdle
};
