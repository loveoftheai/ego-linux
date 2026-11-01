import { state } from "./state.js";
import {
  buildEgoError,
  invokeEgo,
  isEgoUserControlError
} from "./ego-errors.js";
const DEFAULT_RESPONSE_TIMEOUT_MS = 15e3;
function responseTimeoutMs() {
  const configured = Number(process.env.EGO_BROWSER_RESPONSE_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RESPONSE_TIMEOUT_MS;
}
const SESSION_SETUP_WAIT_MS = 2e3;
const SESSION_TTL_MS = 2e3;
const MAX_BUFFERED_EVENTS = 1e4;
const SESSION_LOST = /Session (?:with given id )?not found|Target closed|No session/i;
const FRAME_LIFECYCLE_LOST = /Frame with the given frameId is not found|No frame with given id found|No target with given id/i;
const BROWSER_LEVEL = (method) => method.startsWith("Target.") || method.startsWith("Browser.");
const OOPIF_AUTO_ATTACH_PARAMS = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  // Ego Lite can pause an excluded related target (dedicated worker,
  // AudioWorklet, ...) without attaching it, leaving no session through which
  // the harness can resume it. Attach every type; the attach handler resumes
  // and detaches everything except iframes.
  filter: [{}]
};
const DIALOG_SAFE_METHOD = (method) => BROWSER_LEVEL(method) || method === "Page.handleJavaScriptDialog" || method === "Page.setDownloadBehavior";
let nextMessageId = 1;
const pending = /* @__PURE__ */ new Map();
const browserEvents = [];
const browserEventSubscribers = /* @__PURE__ */ new Set();
const pageEventSubscribers = /* @__PURE__ */ new Map();
const targetStates = /* @__PURE__ */ new Map();
const sessionTargets = /* @__PURE__ */ new Map();
const childTargets = /* @__PURE__ */ new Map();
const parentTargets = /* @__PURE__ */ new Map();
let defaultTargetId = null;
let userControlProbeState = "idle";
let userControlStopError = null;
let userControlProbeGeneration = 0;
let callbackRuntime;
class CdpRequestTimeoutError extends Error {
  code = "EGO_CDP_REQUEST_TIMEOUT";
  method;
  timeoutMs;
  sessionId;
  constructor(method, timeoutMs, sessionId) {
    super(`CDP request timed out: ${method}`);
    this.name = "CdpRequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
    this.sessionId = sessionId;
  }
}
class PageUnresponsiveError extends CdpRequestTimeoutError {
  code = "EGO_PAGE_UNRESPONSIVE";
  waitedMs;
  targetId;
  /**
   * The pending navigation was stopped once the wait ran out and the Page
   * answers again; `currentUrl` is what its main frame showed afterwards.
   */
  stopped = false;
  currentUrl;
  constructor(method, waitedMs, targetId, sessionId) {
    super(method, waitedMs, sessionId);
    this.name = "PageUnresponsiveError";
    this.message = `Page did not answer ${method} within ${waitedMs}ms; its main-frame navigation has not committed or its renderer is unresponsive`;
    this.waitedMs = waitedMs;
    this.targetId = targetId;
  }
}
function isPageUnresponsiveError(error) {
  return error instanceof PageUnresponsiveError || error instanceof Error && error.code === "EGO_PAGE_UNRESPONSIVE";
}
function isCdpRequestTimeoutError(error) {
  return error instanceof CdpRequestTimeoutError || Boolean(error) && typeof error === "object" && error.code === "EGO_CDP_REQUEST_TIMEOUT";
}
function isSessionLostError(error) {
  return error instanceof Error && SESSION_LOST.test(error.message);
}
function isFrameLifecycleError(error) {
  return error instanceof Error && FRAME_LIFECYCLE_LOST.test(error.message);
}
function isRetryableFrameLifecycleError(error) {
  return isSessionLostError(error) || isFrameLifecycleError(error);
}
class PageDialogOpenedError extends Error {
  code = "EGO_PAGE_DIALOG_OPENED";
  method;
  sessionId;
  dialog;
  constructor(method, sessionId, dialog, { alreadyOpen = false } = {}) {
    const kind = typeof dialog.type === "string" && dialog.type ? `JavaScript ${dialog.type} dialog` : "JavaScript dialog";
    const text = typeof dialog.message === "string" && dialog.message ? ` (${JSON.stringify(dialog.message)})` : "";
    const situation = alreadyOpen ? `${method} cannot run while a ${kind}${text} is open` : `a ${kind}${text} opened while ${method} was running`;
    super(
      `${situation}; handle it with page.acceptDialog() or page.dismissDialog() before continuing`
    );
    this.name = "PageDialogOpenedError";
    this.method = method;
    this.sessionId = sessionId;
    this.dialog = { ...dialog };
  }
}
function isPageDialogOpenedError(error) {
  return error instanceof PageDialogOpenedError || Boolean(error) && typeof error === "object" && error.code === "EGO_PAGE_DIALOG_OPENED";
}
function targetState(targetId) {
  let target = targetStates.get(targetId);
  if (!target) {
    target = {
      sessionId: null,
      sessionAt: 0,
      sessionInflight: null,
      events: [],
      egoAutomationEnabled: false,
      pageEventsEnabled: false,
      pageEnableInflight: null,
      networkDomainEnabled: false,
      networkEnableInflight: null,
      autoAttachEnabled: false,
      autoAttachInflight: null,
      inflightNetworkRequests: /* @__PURE__ */ new Map(),
      ignoredFaviconRequestIds: /* @__PURE__ */ new Set(),
      lastNetworkActivityAt: state.now(),
      pendingDialog: null,
      fileChooserInterception: null
    };
    targetStates.set(targetId, target);
  }
  return target;
}
function registerSession(targetId, sessionId) {
  const target = targetState(targetId);
  if (target.sessionId === sessionId) {
    target.sessionAt = Date.now();
    sessionTargets.set(sessionId, targetId);
    return;
  }
  if (target.sessionId && target.sessionId !== sessionId) {
    sessionTargets.delete(target.sessionId);
  }
  target.sessionId = sessionId;
  target.sessionAt = Date.now();
  target.egoAutomationEnabled = false;
  target.pageEventsEnabled = false;
  target.pageEnableInflight = null;
  target.networkDomainEnabled = false;
  target.networkEnableInflight = null;
  target.autoAttachEnabled = false;
  target.autoAttachInflight = null;
  target.inflightNetworkRequests.clear();
  target.ignoredFaviconRequestIds.clear();
  target.lastNetworkActivityAt = state.now();
  target.pendingDialog = null;
  sessionTargets.set(sessionId, targetId);
}
function registerTargetParent(targetId, parentTargetId) {
  const previousParent = parentTargets.get(targetId);
  if (previousParent === parentTargetId) {
    migrateFrameRequests(targetId, parentTargetId);
    return;
  }
  if (previousParent) {
    const previousChildren = childTargets.get(previousParent);
    previousChildren?.delete(targetId);
    if (previousChildren?.size === 0) childTargets.delete(previousParent);
  }
  parentTargets.set(targetId, parentTargetId);
  let children = childTargets.get(parentTargetId);
  if (!children) {
    children = /* @__PURE__ */ new Set();
    childTargets.set(parentTargetId, children);
  }
  children.add(targetId);
  migrateFrameRequests(targetId, parentTargetId);
}
function migrateFrameRequests(targetId, parentTargetId) {
  const destination = targetState(targetId);
  const rootTargetId = pageRootTargetId(parentTargetId);
  for (const sourceTargetId of pageTreeTargetIds(rootTargetId)) {
    if (sourceTargetId === targetId) continue;
    const source = targetStates.get(sourceTargetId);
    if (!source) continue;
    for (const [requestId, request] of source.inflightNetworkRequests) {
      if (request.frameId !== targetId) continue;
      source.inflightNetworkRequests.delete(requestId);
      destination.inflightNetworkRequests.set(requestId, request);
      destination.lastNetworkActivityAt = Math.max(
        destination.lastNetworkActivityAt,
        source.lastNetworkActivityAt
      );
    }
  }
}
function pageRootTargetId(targetId) {
  let current = targetId;
  const visited = /* @__PURE__ */ new Set();
  while (parentTargets.has(current) && !visited.has(current)) {
    visited.add(current);
    current = parentTargets.get(current);
  }
  return current;
}
function pageTreeTargetIds(rootTargetId) {
  const result = [];
  const visit = (targetId) => {
    result.push(targetId);
    for (const childTargetId of childTargets.get(targetId) || []) {
      visit(childTargetId);
    }
  };
  visit(rootTargetId);
  return result;
}
function unregisterTargetParent(targetId) {
  const parentTargetId = parentTargets.get(targetId);
  if (!parentTargetId) return;
  parentTargets.delete(targetId);
  const siblings = childTargets.get(parentTargetId);
  siblings?.delete(targetId);
  if (siblings?.size === 0) childTargets.delete(parentTargetId);
}
function clearTargetSession(targetId, { remove = false } = {}) {
  const target = targetStates.get(targetId);
  if (!target) return;
  rejectFileChooserInterception(
    target,
    new Error("file chooser session was detached")
  );
  if (target.sessionId) {
    sessionTargets.delete(target.sessionId);
  }
  if (remove) {
    targetStates.delete(targetId);
    if (defaultTargetId === targetId) defaultTargetId = null;
    return;
  }
  target.sessionId = null;
  target.sessionAt = 0;
  target.sessionInflight = null;
  target.events.length = 0;
  target.egoAutomationEnabled = false;
  target.pageEventsEnabled = false;
  target.pageEnableInflight = null;
  target.networkDomainEnabled = false;
  target.networkEnableInflight = null;
  target.autoAttachEnabled = false;
  target.autoAttachInflight = null;
  target.inflightNetworkRequests.clear();
  target.ignoredFaviconRequestIds.clear();
  target.lastNetworkActivityAt = state.now();
  target.pendingDialog = null;
  target.fileChooserInterception = null;
}
function clearTargetSessionTree(targetId, { remove = false } = {}) {
  for (const childTargetId of [...childTargets.get(targetId) || []]) {
    clearTargetSessionTree(childTargetId, { remove: true });
  }
  clearTargetSession(targetId, { remove });
  if (remove) {
    childTargets.delete(targetId);
    unregisterTargetParent(targetId);
  }
}
function capEvents(events) {
  if (events.length > MAX_BUFFERED_EVENTS) {
    events.splice(0, events.length - MAX_BUFFERED_EVENTS);
  }
}
function isBrowserRuntime() {
  return Boolean(
    globalThis.ego && typeof globalThis.ego.sendCDPMessage === "function"
  );
}
function browserEgo() {
  if (!globalThis.ego) {
    throw new Error("browser runtime is not available");
  }
  return globalThis.ego;
}
function guardNativeCallback(label, callback) {
  try {
    callback();
  } catch (error) {
    try {
      console.error(`[ego-browser] ${label} failed:`, error);
    } catch {
    }
  }
}
function dispatchCdpMessage(payload) {
  guardNativeCallback("onCDPMessage", () => handleMessage(payload));
}
function dispatchCdpSendError(message, errorCode) {
  guardNativeCallback(
    "onSendCDPMessageError",
    () => handleSendError(message, errorCode)
  );
}
function bindRuntimeCallbacks(runtime) {
  if (callbackRuntime && callbackRuntime !== runtime) {
    releaseRuntimeCallbacks(callbackRuntime);
  }
  runtime.onCDPMessage = dispatchCdpMessage;
  runtime.onSendCDPMessageError = dispatchCdpSendError;
  callbackRuntime = runtime;
}
function releaseRuntimeCallbacks(runtime = callbackRuntime) {
  if (!runtime) return;
  if (runtime.onCDPMessage === dispatchCdpMessage) {
    runtime.onCDPMessage = void 0;
  }
  if (runtime.onSendCDPMessageError === dispatchCdpSendError) {
    runtime.onSendCDPMessageError = void 0;
  }
  if (callbackRuntime === runtime) callbackRuntime = void 0;
}
function disposeBrowserRuntime(runtime = callbackRuntime) {
  releaseRuntimeCallbacks(runtime);
  rejectAllPending(new Error("ego-browser runtime was disposed"));
  browserEventSubscribers.clear();
  pageEventSubscribers.clear();
  invalidateSession();
}
function subscribeBrowserEvents(listener) {
  if (typeof listener !== "function") {
    throw new TypeError("browser event listener must be a function");
  }
  browserEventSubscribers.add(listener);
  return () => browserEventSubscribers.delete(listener);
}
function subscribePageEvents(targetId, listener) {
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new TypeError("page event subscription requires a targetId");
  }
  if (typeof listener !== "function") {
    throw new TypeError("page event listener must be a function");
  }
  let listeners = pageEventSubscribers.get(targetId);
  if (!listeners) {
    listeners = /* @__PURE__ */ new Set();
    pageEventSubscribers.set(targetId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) pageEventSubscribers.delete(targetId);
  };
}
function rawCdp(method, params = {}, sessionId = void 0, timeoutMs = responseTimeoutMs()) {
  const runtime = browserEgo();
  bindRuntimeCallbacks(runtime);
  const id = nextMessageId++;
  const payload = JSON.stringify({
    id,
    method,
    params,
    ...sessionId ? { sessionId } : {}
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const dialog = sessionId && !DIALOG_SAFE_METHOD(method) ? pendingDialog(sessionId) : null;
      reject(
        dialog ? new PageDialogOpenedError(method, sessionId, dialog, {
          alreadyOpen: true
        }) : new CdpRequestTimeoutError(method, timeoutMs, sessionId)
      );
    }, timeoutMs);
    pending.set(id, {
      method,
      sessionId,
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
    try {
      runtime.sendCDPMessage(payload);
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(buildEgoError(error));
    }
  });
}
async function browserCdp(method, params = {}, sessionId = void 0, timeoutMs = responseTimeoutMs()) {
  if (state.cdpOverride) {
    return state.cdpOverride(method, params, sessionId, timeoutMs);
  }
  const explicit = sessionId !== void 0;
  let effective = sessionId;
  if (!explicit && !BROWSER_LEVEL(method)) {
    effective = await ensureSession();
  }
  const dialog = effective && !DIALOG_SAFE_METHOD(method) ? pendingDialog(effective) : null;
  if (dialog) {
    throw new PageDialogOpenedError(method, effective, dialog, {
      alreadyOpen: true
    });
  }
  try {
    const response = await rawCdp(method, params, effective, timeoutMs);
    recordCommandState(method, params, effective, response);
    return response;
  } catch (error) {
    const lost = SESSION_LOST.test(error?.message || "");
    if (lost && !explicit && !BROWSER_LEVEL(method)) {
      const lostTargetId = effective ? sessionTargets.get(effective) : defaultTargetId;
      if (lostTargetId) clearTargetSession(lostTargetId);
      const fresh = await ensureSession(lostTargetId);
      const response = await rawCdp(method, params, fresh, timeoutMs);
      recordCommandState(method, params, fresh, response);
      return response;
    }
    throw error;
  }
}
function recordCommandState(method, params, sessionId, response) {
  if (method === "Target.attachToTarget") {
    const attachedSessionId = response.result?.sessionId || response.sessionId;
    if (params?.targetId && attachedSessionId) {
      registerSession(params.targetId, attachedSessionId);
      enableEgoAutomation(attachedSessionId);
    }
    return;
  }
  if (method === "Target.detachFromTarget" && params?.sessionId) {
    const targetId2 = sessionTargets.get(params.sessionId);
    if (targetId2) clearTargetSession(targetId2);
    return;
  }
  if (!sessionId) return;
  const targetId = sessionTargets.get(sessionId);
  if (!targetId) return;
  const target = targetStates.get(targetId);
  if (!target) return;
  if (method === "Network.enable") {
    if (!target.networkDomainEnabled) {
      target.lastNetworkActivityAt = state.now();
    }
    target.networkDomainEnabled = true;
  }
  if (method === "Network.disable") {
    target.networkDomainEnabled = false;
    target.inflightNetworkRequests.clear();
    target.ignoredFaviconRequestIds.clear();
    target.lastNetworkActivityAt = state.now();
  }
  if (method === "Target.setAutoAttach") {
    target.autoAttachEnabled = params?.autoAttach === true;
  }
}
async function ensureSession(requestedTargetId = void 0, timeoutMs = responseTimeoutMs()) {
  const cachedTargetId = requestedTargetId || state.preferredTargetId || defaultTargetId;
  const cached = cachedTargetId ? targetStates.get(cachedTargetId) : void 0;
  const setupWaitMs = Math.min(Math.max(1, timeoutMs), SESSION_SETUP_WAIT_MS);
  if (cached?.sessionId && Date.now() - cached.sessionAt < SESSION_TTL_MS) {
    await Promise.all([
      enablePageEvents(cached.sessionId, setupWaitMs),
      enableNetworkTrackingForSession(cached.sessionId, false, setupWaitMs),
      enableOopifAutoAttach(cached.sessionId, setupWaitMs)
    ]);
    cached.sessionAt = Date.now();
    return cached.sessionId;
  }
  let targetId = requestedTargetId;
  if (!targetId) {
    const result = await invokeEgo(
      "listTabs",
      () => browserEgo().listTabs()
    );
    const tabs = result?.tabs || result?.targetInfos || [];
    const preferred = state.preferredTargetId ? tabs.find((tab) => tab.targetId === state.preferredTargetId) : null;
    const active = preferred || tabs.find((tab) => tab.active) || tabs[tabs.length - 1];
    if (!active) {
      throw new Error("no active tab to attach session");
    }
    targetId = active.targetId;
  }
  defaultTargetId = targetId;
  const target = targetState(targetId);
  if (target.sessionInflight) {
    return target.sessionInflight;
  }
  target.sessionInflight = (async () => {
    try {
      if (!target.sessionId) {
        const attached = await rawCdp(
          "Target.attachToTarget",
          { targetId, flatten: true },
          void 0,
          timeoutMs
        );
        const sessionId = attached.result?.sessionId || attached.sessionId;
        if (!sessionId) {
          throw new Error("Target.attachToTarget returned no sessionId");
        }
        registerSession(targetId, sessionId);
      }
      enableEgoAutomation(target.sessionId);
      await Promise.all([
        enablePageEvents(target.sessionId, setupWaitMs),
        enableNetworkTrackingForSession(target.sessionId, false, setupWaitMs),
        enableOopifAutoAttach(target.sessionId, setupWaitMs)
      ]);
      target.sessionAt = Date.now();
      return target.sessionId;
    } finally {
      target.sessionInflight = null;
    }
  })();
  return target.sessionInflight;
}
async function ensureFrameSessions(pageTargetId, timeoutMs = responseTimeoutMs()) {
  if (typeof pageTargetId !== "string" || pageTargetId.length === 0) {
    throw new TypeError("ensureFrameSessions requires a non-empty targetId");
  }
  const startedAt = state.now();
  const deadline = startedAt + Math.max(1, timeoutMs);
  const remaining = () => Math.max(1, deadline - state.now());
  const pageSessionId = await ensureSession(pageTargetId, remaining());
  let response;
  let frameTreeResponse;
  try {
    [response, frameTreeResponse] = await Promise.all([
      browserCdp("Target.getTargets", {}, void 0, remaining()),
      browserCdp("Page.getFrameTree", {}, pageSessionId, remaining())
    ]);
  } catch (error) {
    if (isCdpRequestTimeoutError(error) && error.method === "Page.getFrameTree") {
      throw new PageUnresponsiveError(
        "Page.getFrameTree",
        state.now() - startedAt,
        pageTargetId,
        pageSessionId
      );
    }
    throw error;
  }
  const targetInfos = response?.result?.targetInfos || response?.targetInfos || [];
  const frameTree = frameTreeResponse?.result?.frameTree || frameTreeResponse?.frameTree;
  const frameParents = /* @__PURE__ */ new Map();
  const collectFrameGraph = (tree, recursiveParentId) => {
    const frameId = tree?.frame?.id;
    if (typeof frameId !== "string") return;
    const protocolParentId = tree?.frame?.parentId;
    frameParents.set(
      frameId,
      typeof protocolParentId === "string" ? protocolParentId : recursiveParentId
    );
    for (const child of tree?.childFrames || []) {
      collectFrameGraph(child, frameId);
    }
  };
  if (frameTree) collectFrameGraph(frameTree, void 0);
  const rootFrameId = frameTree?.frame?.id;
  const iframeInfos = targetInfos.filter(
    (info) => info?.type === "iframe" && typeof info.targetId === "string"
  );
  const iframeInfoByTarget = new Map(
    iframeInfos.map((info) => [info.targetId, info])
  );
  const reportedParentFrameId = (info) => {
    const parentFrameId = info?.parentFrameId ?? info?.parentId;
    return typeof parentFrameId === "string" ? parentFrameId : void 0;
  };
  const parentFrameIdOf = (frameId) => {
    if (frameParents.has(frameId)) return frameParents.get(frameId);
    return reportedParentFrameId(iframeInfoByTarget.get(frameId));
  };
  const ancestryToPage = (frameId) => {
    let current = frameId;
    let depth = 0;
    const visited = /* @__PURE__ */ new Set();
    while (current && !visited.has(current)) {
      if (current === pageTargetId || current === rootFrameId) {
        return { belongs: true, depth };
      }
      visited.add(current);
      current = parentFrameIdOf(current);
      depth += 1;
    }
    return { belongs: false, depth };
  };
  const descendants = iframeInfos.map((info) => ({ info, ancestry: ancestryToPage(info.targetId) })).filter(({ ancestry }) => ancestry.belongs).sort((left, right) => left.ancestry.depth - right.ancestry.depth).map(({ info }) => info);
  const liveTargetIds = new Set(
    descendants.map((info) => info.targetId)
  );
  const allLiveIframeTargetIds = new Set(
    iframeInfos.map((info) => info.targetId)
  );
  const knownDescendants = [];
  const collectKnownDescendants = (parentTargetId) => {
    for (const childTargetId of childTargets.get(parentTargetId) || []) {
      knownDescendants.push(childTargetId);
      collectKnownDescendants(childTargetId);
    }
  };
  collectKnownDescendants(pageTargetId);
  for (const knownTargetId of [...knownDescendants].reverse()) {
    if (!allLiveIframeTargetIds.has(knownTargetId)) {
      clearTargetSessionTree(knownTargetId, { remove: true });
    }
  }
  for (const knownTargetId of knownDescendants) {
    if (allLiveIframeTargetIds.has(knownTargetId) && !liveTargetIds.has(knownTargetId)) {
      const info = iframeInfoByTarget.get(knownTargetId);
      if (info) {
        descendants.push(info);
        liveTargetIds.add(knownTargetId);
      }
    }
  }
  const nearestTargetParent = (info) => {
    const ancestry = ancestryToPage(info.targetId);
    if (!ancestry.belongs) {
      const knownParentTargetId = parentTargets.get(info.targetId);
      if (knownParentTargetId) return knownParentTargetId;
    }
    let current = parentFrameIdOf(info.targetId);
    const visited = /* @__PURE__ */ new Set();
    while (current && !visited.has(current)) {
      if (current === pageTargetId || current === rootFrameId) {
        return pageTargetId;
      }
      if (liveTargetIds.has(current)) return current;
      visited.add(current);
      current = parentFrameIdOf(current);
    }
    return pageTargetId;
  };
  const sessionByTarget = /* @__PURE__ */ new Map([
    [pageTargetId, pageSessionId]
  ]);
  const vanishedTargetIds = /* @__PURE__ */ new Set();
  for (const info of descendants) {
    let sessionId;
    try {
      sessionId = await ensureSession(info.targetId, remaining());
    } catch (error) {
      if (!isRetryableFrameLifecycleError(error)) throw error;
      vanishedTargetIds.add(info.targetId);
      liveTargetIds.delete(info.targetId);
      clearTargetSessionTree(info.targetId, { remove: true });
      continue;
    }
    registerTargetParent(info.targetId, nearestTargetParent(info));
    sessionByTarget.set(info.targetId, sessionId);
  }
  const sessions = /* @__PURE__ */ new Map();
  const collectFrameSessions = (tree, inheritedSessionId, isRoot = false) => {
    const frameId = tree?.frame?.id;
    if (typeof frameId !== "string" || vanishedTargetIds.has(frameId)) return;
    const sessionId = sessionByTarget.get(frameId) || inheritedSessionId;
    if (!isRoot) sessions.set(frameId, sessionId);
    for (const child of tree?.childFrames || []) {
      collectFrameSessions(child, sessionId);
    }
  };
  if (frameTree) collectFrameSessions(frameTree, pageSessionId, true);
  for (const info of descendants) {
    if (vanishedTargetIds.has(info.targetId)) continue;
    if (!sessions.has(info.targetId)) {
      sessions.set(info.targetId, sessionByTarget.get(info.targetId));
    }
  }
  sessions.parentFrameIds = new Map(
    [...sessions.keys()].map((frameId) => [frameId, parentFrameIdOf(frameId)])
  );
  return sessions;
}
function invalidateSession(targetId = void 0) {
  if (targetId) {
    clearTargetSessionTree(targetId, { remove: true });
    return;
  }
  for (const knownTargetId of [...targetStates.keys()]) {
    clearTargetSession(knownTargetId, { remove: true });
  }
  browserEvents.length = 0;
  childTargets.clear();
  parentTargets.clear();
  defaultTargetId = null;
  resetUserControlProbe();
}
function setPreferredTarget(targetId) {
  state.preferredTargetId = targetId || null;
}
function clearPreferredTarget() {
  state.preferredTargetId = null;
}
function drainBrowserEvents(sessionId = void 0) {
  const targetId = sessionId ? sessionTargets.get(sessionId) : state.preferredTargetId || defaultTargetId;
  const target = targetId ? targetStates.get(targetId) : void 0;
  const out = browserEvents.splice(0, browserEvents.length);
  if (target) out.push(...target.events.splice(0, target.events.length));
  return out;
}
function drainPageEvents(sessionId) {
  const targetId = sessionId ? sessionTargets.get(sessionId) : void 0;
  const target = targetId ? targetStates.get(targetId) : void 0;
  return target ? target.events.splice(0, target.events.length) : [];
}
function pendingDialog(sessionId) {
  const targetId = sessionId ? sessionTargets.get(sessionId) : state.preferredTargetId || defaultTargetId;
  const dialog = targetId ? targetStates.get(pageRootTargetId(targetId))?.pendingDialog : null;
  return dialog ? { ...dialog } : null;
}
function isNetworkDomainEnabled(sessionId) {
  const targetId = sessionId ? sessionTargets.get(sessionId) : void 0;
  return targetId ? Boolean(targetStates.get(targetId)?.networkDomainEnabled) : false;
}
async function ensureNetworkTracking(sessionIds, timeoutMs = responseTimeoutMs()) {
  const unique = [...new Set(sessionIds.filter(Boolean))];
  await Promise.all(
    unique.map(
      (sessionId) => enableNetworkTrackingForSession(sessionId, true, timeoutMs)
    )
  );
}
function networkActivity(sessionIds) {
  let tracking = sessionIds.length > 0;
  let inflight = 0;
  let lastActivityAt = 0;
  const pendingRequests = [];
  const counted = /* @__PURE__ */ new Set();
  for (const sessionId of new Set(sessionIds)) {
    const targetId = sessionTargets.get(sessionId);
    const target = targetId ? targetStates.get(targetId) : void 0;
    if (!target || target.sessionId !== sessionId || !target.networkDomainEnabled) {
      tracking = false;
      continue;
    }
    for (const treeTargetId of pageTreeTargetIds(targetId)) {
      if (counted.has(treeTargetId)) continue;
      counted.add(treeTargetId);
      const member = targetStates.get(treeTargetId);
      if (!member) continue;
      inflight += member.inflightNetworkRequests.size;
      lastActivityAt = Math.max(lastActivityAt, member.lastNetworkActivityAt);
      for (const request of member.inflightNetworkRequests.values()) {
        pendingRequests.push(
          `${request.type || "Other"} ${request.url || request.requestId}`
        );
      }
    }
  }
  return { tracking, inflight, lastActivityAt, pendingRequests };
}
async function pageNetworkSessions(sessionId, timeoutMs = responseTimeoutMs()) {
  const targetId = sessionTargets.get(sessionId);
  if (!targetId) {
    throw new Error(
      "cannot resolve Page network sessions from a detached session"
    );
  }
  const frameSessions = await ensureFrameSessions(targetId, timeoutMs);
  const currentMainSession = targetStates.get(targetId)?.sessionId;
  if (!currentMainSession) {
    throw new Error("Page session was detached while refreshing network state");
  }
  return [.../* @__PURE__ */ new Set([currentMainSession, ...frameSessions.values()])];
}
function prepareFileChooser(sessionId, { timeoutMs, cancel }) {
  const targetId = sessionTargets.get(sessionId);
  const target = targetId ? targetStates.get(targetId) : void 0;
  if (!target) {
    throw new Error("cannot intercept a file chooser without a Page session");
  }
  if (target.fileChooserInterception) {
    throw new Error("this Page is already waiting for a file chooser");
  }
  let observed;
  let resolveEvent;
  let rejectEvent;
  const event = new Promise((resolve, reject) => {
    resolveEvent = resolve;
    rejectEvent = reject;
  });
  void event.catch(() => {
  });
  const interception = {
    cancelPromise: void 0,
    event,
    reject: rejectEvent,
    resolve(value) {
      if (observed) return;
      observed = value;
      clearTimeout(interception.timer);
      resolveEvent(value);
      if (cancel) {
        interception.cancelPromise = rawCdp(
          "DOM.setFileInputFiles",
          { files: [], backendNodeId: value.backendNodeId },
          sessionId
        ).catch(() => {
        });
      }
    },
    peek() {
      return observed;
    },
    async dispose(reason) {
      if (target.fileChooserInterception !== interception) return;
      target.fileChooserInterception = null;
      clearTimeout(interception.timer);
      if (!observed && reason) rejectEvent(reason);
      await interception.ready.catch(() => {
      });
      await interception.cancelPromise;
      const disable = rawCdp(
        "Page.setInterceptFileChooserDialog",
        { enabled: false },
        sessionId
      ).catch(() => {
      });
      if (target.pendingDialog) {
        void disable;
        return;
      }
      await disable;
    }
  };
  target.fileChooserInterception = interception;
  interception.ready = rawCdp(
    "Page.setInterceptFileChooserDialog",
    { enabled: true },
    sessionId
  ).then(() => {
    interception.timer = setTimeout(() => {
      const error = new Error(
        `page.waitForFileChooser timed out after ${timeoutMs}ms`
      );
      error.code = "EGO_FILE_CHOOSER_TIMEOUT";
      if (target.fileChooserInterception === interception) {
        target.fileChooserInterception = null;
        rejectEvent(error);
        void rawCdp(
          "Page.setInterceptFileChooserDialog",
          { enabled: false },
          sessionId
        ).catch(() => {
        });
      }
    }, timeoutMs);
  }).catch((error) => {
    if (target.fileChooserInterception === interception) {
      target.fileChooserInterception = null;
    }
    rejectEvent(error);
    throw error;
  });
  return interception;
}
function enableEgoAutomation(sessionId) {
  const targetId = sessionId ? sessionTargets.get(sessionId) : void 0;
  const target = targetId ? targetStates.get(targetId) : void 0;
  if (!target || target.sessionId !== sessionId || target.egoAutomationEnabled) {
    return;
  }
  target.egoAutomationEnabled = true;
  void rawCdp("egoAutomated.enable", {}, sessionId).catch(() => {
    void rawCdp(
      "Page.addScriptToEvaluateOnNewDocument",
      {
        source: "Object.defineProperty(navigator,'webdriver',{get:()=>false,configurable:true});try{Object.defineProperty(console,'debug',{value:console.debug,writable:true,configurable:false});Object.defineProperty(console,'clear',{value:console.clear,writable:true,configurable:false});}catch(e){}if(!window.chrome){window.chrome={runtime:{}};}",
        runImmediately: true
      },
      sessionId
    ).catch(() => {
    });
  });
}
async function enablePageEvents(sessionId, timeoutMs = responseTimeoutMs()) {
  const targetId = sessionId ? sessionTargets.get(sessionId) : void 0;
  const target = targetId ? targetStates.get(targetId) : void 0;
  if (!target || target.sessionId !== sessionId || target.pageEventsEnabled) {
    return;
  }
  try {
    await sharedSetupCommand(
      target,
      "pageEnableInflight",
      "Page.enable",
      {},
      sessionId,
      timeoutMs,
      () => {
        target.pageEventsEnabled = true;
      }
    );
  } catch {
  }
}
async function enableNetworkTrackingForSession(sessionId, required = false, timeoutMs = responseTimeoutMs()) {
  const targetId = sessionId ? sessionTargets.get(sessionId) : void 0;
  const target = targetId ? targetStates.get(targetId) : void 0;
  if (!target || target.sessionId !== sessionId) {
    if (required) {
      throw new Error(
        "cannot track network activity for a detached Page session"
      );
    }
    return;
  }
  if (target.networkDomainEnabled) return;
  try {
    await sharedSetupCommand(
      target,
      "networkEnableInflight",
      "Network.enable",
      {},
      sessionId,
      timeoutMs,
      () => {
        if (!target.networkDomainEnabled) {
          target.lastNetworkActivityAt = state.now();
          target.networkDomainEnabled = true;
        }
      }
    );
  } catch (error) {
    if (required) throw error;
  }
  if (required && !target.networkDomainEnabled) {
    throw new Error(
      "network tracking was interrupted by a detached Page session"
    );
  }
}
async function enableOopifAutoAttach(sessionId, timeoutMs = responseTimeoutMs()) {
  const targetId = sessionId ? sessionTargets.get(sessionId) : void 0;
  const target = targetId ? targetStates.get(targetId) : void 0;
  if (!target || target.sessionId !== sessionId || target.autoAttachEnabled) {
    return;
  }
  try {
    await sharedSetupCommand(
      target,
      "autoAttachInflight",
      "Target.setAutoAttach",
      OOPIF_AUTO_ATTACH_PARAMS,
      sessionId,
      timeoutMs,
      () => {
        target.autoAttachEnabled = true;
      }
    );
  } catch {
  }
}
function sharedSetupCommand(target, key, method, params, sessionId, timeoutMs, onSuccess) {
  let inflight = target[key];
  if (!inflight) {
    inflight = rawCdp(method, params, sessionId).then(() => {
      if (target.sessionId === sessionId) onSuccess();
    });
    target[key] = inflight;
    const clear = () => {
      if (target[key] === inflight) target[key] = null;
    };
    void inflight.then(clear, clear);
  }
  return waitForSharedCdpRequest(inflight, method, sessionId, timeoutMs);
}
function waitForSharedCdpRequest(request, method, sessionId, timeoutMs) {
  const callerTimeoutMs = Math.max(1, timeoutMs);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const dialog = DIALOG_SAFE_METHOD(method) ? null : pendingDialog(sessionId);
      reject(
        dialog ? new PageDialogOpenedError(method, sessionId, dialog, {
          alreadyOpen: true
        }) : new CdpRequestTimeoutError(method, callerTimeoutMs, sessionId)
      );
    }, callerTimeoutMs);
    request.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}
function initializeAutoAttachedTarget(sessionId, waitingForDebugger) {
  enableEgoAutomation(sessionId);
  const pageEvents = enablePageEvents(sessionId);
  const networkEvents = enableNetworkTrackingForSession(sessionId);
  const nestedFrames = enableOopifAutoAttach(sessionId);
  const resume = waitingForDebugger ? rawCdp("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {
  }) : Promise.resolve();
  void Promise.allSettled([pageEvents, networkEvents, nestedFrames, resume]);
}
function releaseAutoAttachedTarget(sessionId, parentSessionId, waitingForDebugger) {
  const resume = waitingForDebugger ? rawCdp("Runtime.runIfWaitingForDebugger", {}, sessionId) : Promise.resolve();
  void resume.catch(() => {
  }).then(
    () => rawCdp("Target.detachFromTarget", { sessionId }, parentSessionId)
  ).catch(() => {
  });
}
function finishNetworkRequest(targetId, requestId) {
  const now = state.now();
  const rootTargetId = pageRootTargetId(targetId);
  for (const pageTargetId of pageTreeTargetIds(rootTargetId)) {
    const pageTarget = targetStates.get(pageTargetId);
    if (!pageTarget) continue;
    if (pageTarget.inflightNetworkRequests.delete(requestId)) {
      pageTarget.lastNetworkActivityAt = now;
    }
  }
}
function isIgnoredFaviconRequest(targetId, requestId) {
  const rootTargetId = pageRootTargetId(targetId);
  return pageTreeTargetIds(rootTargetId).some(
    (pageTargetId) => targetStates.get(pageTargetId)?.ignoredFaviconRequestIds.has(requestId)
  );
}
function clearIgnoredFaviconRequest(targetId, requestId) {
  const rootTargetId = pageRootTargetId(targetId);
  let deleted = false;
  for (const pageTargetId of pageTreeTargetIds(rootTargetId)) {
    deleted = Boolean(
      targetStates.get(pageTargetId)?.ignoredFaviconRequestIds.delete(requestId)
    ) || deleted;
  }
  return deleted;
}
function recordNetworkEvent(targetId, target, data) {
  if (!target.networkDomainEnabled && !target.networkEnableInflight) return;
  const requestId = data?.params?.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) return;
  if (data.method === "Network.requestWillBeSent") {
    const url = data.params?.request?.url;
    if (typeof url === "string" && url.endsWith("/favicon.ico") || isIgnoredFaviconRequest(targetId, requestId)) {
      target.ignoredFaviconRequestIds.add(requestId);
      if (target.inflightNetworkRequests.delete(requestId)) {
        target.lastNetworkActivityAt = state.now();
      }
      return;
    }
    target.networkDomainEnabled = true;
    target.inflightNetworkRequests.set(requestId, {
      requestId,
      ...typeof data.params?.frameId === "string" ? { frameId: data.params.frameId } : {},
      ...typeof data.params?.loaderId === "string" ? { loaderId: data.params.loaderId } : {},
      ...typeof data.params?.type === "string" ? { type: data.params.type } : {},
      ...typeof url === "string" ? { url } : {}
    });
    target.lastNetworkActivityAt = state.now();
    return;
  }
  if (data.method === "Network.loadingFinished" || data.method === "Network.loadingFailed") {
    target.networkDomainEnabled = true;
    if (clearIgnoredFaviconRequest(targetId, requestId)) return;
    finishNetworkRequest(targetId, requestId);
    target.lastNetworkActivityAt = state.now();
  }
}
function handleSendError(message, error_code) {
  if (pending.size === 0) return;
  if (error_code !== "EGO_TASK_SPACE_USER_IN_CONTROL") {
    rejectAllPending(buildEgoError({ error: message, error_code }));
    return;
  }
  if (userControlProbeState === "stopped" && userControlStopError) {
    rejectAllPending(userControlStopError);
    return;
  }
  if (userControlProbeState === "probing") return;
  userControlProbeState = "probing";
  const generation = ++userControlProbeGeneration;
  void probeUserControlReason(message, error_code, generation);
}
async function probeUserControlReason(message, error_code, generation) {
  const fallback = { error: message, error_code };
  const runtime = browserEgo();
  if (typeof runtime.setAgentTaskState !== "function") {
    stopForUserControl(fallback, generation);
    return;
  }
  try {
    const result = await runtime.setAgentTaskState("Waiting for the user");
    if (generation !== userControlProbeGeneration) return;
    if (isEgoUserControlError(result)) {
      stopForUserControl(result, generation);
      return;
    }
    if (result && typeof result === "object" && "error" in result) {
      stopForUserControl(fallback, generation);
      return;
    }
    userControlProbeState = "idle";
    userControlStopError = null;
    rejectAllPending(nativeSendError(message, error_code));
  } catch (error) {
    if (generation !== userControlProbeGeneration) return;
    stopForUserControl(
      isEgoUserControlError(error) ? error : fallback,
      generation
    );
  }
}
function stopForUserControl(errorLike, generation) {
  if (generation !== userControlProbeGeneration) return;
  userControlStopError = buildEgoError(errorLike);
  userControlProbeState = "stopped";
  rejectAllPending(userControlStopError);
}
function rejectAllPending(error) {
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) entry.reject(error);
}
function nativeSendError(message, error_code) {
  const error = new Error(
    message || error_code || "CDP send failed"
  );
  if (error_code) error.error_code = error_code;
  return error;
}
function resetUserControlProbe() {
  userControlProbeGeneration += 1;
  userControlProbeState = "idle";
  userControlStopError = null;
}
function handleMessage(message) {
  let data;
  try {
    data = JSON.parse(message);
  } catch {
    return;
  }
  if (Object.hasOwn(data, "id")) {
    const entry = pending.get(data.id);
    if (!entry) {
      return;
    }
    pending.delete(data.id);
    if (data.error) {
      const error = new Error(
        data.error.message || data.error
      );
      if (entry.sessionId) error.sessionId = entry.sessionId;
      entry.reject(error);
      return;
    }
    if (userControlProbeState === "stopped") {
      resetUserControlProbe();
    }
    entry.resolve(data);
    return;
  }
  if (data.method === "Target.detachedFromTarget" || data.method === "Target.targetDestroyed") {
    const targetId2 = data.params?.targetId || data.params?.targetInfo?.targetId || (data.params?.sessionId ? sessionTargets.get(data.params.sessionId) : void 0);
    if (targetId2) {
      clearTargetSessionTree(targetId2, {
        remove: data.method === "Target.targetDestroyed"
      });
    }
  } else if (data.method === "Target.attachedToTarget") {
    const sessionId2 = data.params?.sessionId;
    const targetId2 = data.params?.targetInfo?.targetId;
    const targetType = data.params?.targetInfo?.type;
    const reportedParentFrameId = data.params?.targetInfo?.parentFrameId || data.params?.targetInfo?.parentId;
    const sourceTargetId = data.sessionId ? sessionTargets.get(data.sessionId) : void 0;
    const parentTargetId = sourceTargetId || reportedParentFrameId;
    if (sessionId2 && targetId2) registerSession(targetId2, sessionId2);
    if (targetId2 && parentTargetId && targetId2 !== parentTargetId) {
      registerTargetParent(targetId2, parentTargetId);
    }
    if (sessionId2 && targetType === "iframe") {
      initializeAutoAttachedTarget(
        sessionId2,
        data.params?.waitingForDebugger === true
      );
    } else if (sessionId2 && sourceTargetId && targetType !== "page") {
      releaseAutoAttachedTarget(
        sessionId2,
        data.sessionId,
        data.params?.waitingForDebugger === true
      );
    } else if (sessionId2 && data.params?.waitingForDebugger === true) {
      void rawCdp("Runtime.runIfWaitingForDebugger", {}, sessionId2).catch(
        () => {
        }
      );
    }
  }
  const sessionId = data.sessionId;
  const targetId = sessionId ? sessionTargets.get(sessionId) : void 0;
  const target = targetId ? targetStates.get(targetId) : void 0;
  if (target && typeof data.method === "string") {
    recordNetworkEvent(targetId, target, data);
  }
  if (data.method === "Page.javascriptDialogOpening") {
    if (target) {
      target.pageEventsEnabled = true;
      const root = targetStates.get(pageRootTargetId(targetId));
      if (root) {
        root.pendingDialog = data.params || {};
        rejectCommandsBlockedByDialog(
          targetId,
          root.pendingDialog
        );
      }
    }
  } else if (data.method === "Page.javascriptDialogClosed") {
    const root = targetId ? targetStates.get(pageRootTargetId(targetId)) : void 0;
    if (root) root.pendingDialog = null;
  } else if (data.method === "Page.fileChooserOpened") {
    target?.fileChooserInterception?.resolve(data.params || {});
  }
  if (typeof data.method === "string" && BROWSER_LEVEL(data.method)) {
    for (const listener of [...browserEventSubscribers]) {
      guardNativeCallback("browser event subscriber", () => listener(data));
    }
  }
  if (targetId && typeof data.method === "string") {
    for (const listener of [...pageEventSubscribers.get(targetId) || []]) {
      guardNativeCallback("page event subscriber", () => listener(data));
    }
  }
  const events = target ? target.events : browserEvents;
  events.push(data);
  capEvents(events);
}
function rejectCommandsBlockedByDialog(targetId, dialog) {
  const sessionIds = new Set(
    pageTreeTargetIds(pageRootTargetId(targetId)).map((id) => targetStates.get(id)?.sessionId).filter(Boolean)
  );
  for (const [id, entry] of pending) {
    if (!sessionIds.has(entry.sessionId) || DIALOG_SAFE_METHOD(entry.method)) {
      continue;
    }
    pending.delete(id);
    entry.reject(
      new PageDialogOpenedError(entry.method, entry.sessionId, dialog)
    );
  }
}
function rejectFileChooserInterception(target, error) {
  const interception = target.fileChooserInterception;
  if (!interception) return;
  target.fileChooserInterception = null;
  clearTimeout(interception.timer);
  interception.reject(error);
}
function browserSnapshotRefsToRefMap(refMap, refs = []) {
  refMap.clear();
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") {
      continue;
    }
    if (ref.backendNodeId === void 0 || ref.backendNodeId === null) {
      continue;
    }
    refMap.addWithFrame(
      String(ref.refId ?? ref.backendNodeId),
      ref.backendNodeId,
      ref.role,
      ref.name,
      void 0,
      ref.frameId
    );
  }
}
export {
  CdpRequestTimeoutError,
  PageDialogOpenedError,
  PageUnresponsiveError,
  browserCdp,
  browserEgo,
  browserSnapshotRefsToRefMap,
  clearPreferredTarget,
  disposeBrowserRuntime,
  drainBrowserEvents,
  drainPageEvents,
  ensureFrameSessions,
  ensureNetworkTracking,
  ensureSession,
  invalidateSession,
  isBrowserRuntime,
  isCdpRequestTimeoutError,
  isFrameLifecycleError,
  isNetworkDomainEnabled,
  isPageDialogOpenedError,
  isPageUnresponsiveError,
  isRetryableFrameLifecycleError,
  isSessionLostError,
  networkActivity,
  pageNetworkSessions,
  pendingDialog,
  prepareFileChooser,
  releaseRuntimeCallbacks,
  responseTimeoutMs,
  setPreferredTarget,
  subscribeBrowserEvents,
  subscribePageEvents
};
