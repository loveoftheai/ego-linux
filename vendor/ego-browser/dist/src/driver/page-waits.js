import {
  isCdpRequestTimeoutError,
  isFrameLifecycleError,
  isSessionLostError
} from "../browser-runtime.js";
import {
  ElementResolutionError,
  resolveElementObjectId
} from "../element-resolver.js";
const SELECTOR_POLL_INTERVAL_MS = 100;
const FRAME_DISCOVERY_REFRESH_INTERVAL_MS = 500;
function isTransientElementError(error) {
  return isFrameLifecycleError(error) || error instanceof ElementResolutionError && error.kind === "transient";
}
class PageNavigationTimeoutError extends Error {
  code = "EGO_NAVIGATION_TIMEOUT";
  committed;
  url;
  readyState;
  waitUntil;
  timeoutMs;
  constructor(message, details) {
    super(message);
    this.name = "PageNavigationTimeoutError";
    this.committed = details.committed;
    this.url = details.url;
    this.readyState = details.readyState;
    this.waitUntil = details.waitUntil;
    this.timeoutMs = details.timeoutMs;
  }
}
const VISIBILITY_FUNCTION = "function(){if(typeof this.checkVisibility==='function')return this.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const s=getComputedStyle(this);const r=this.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&r.width>0&&r.height>0;}";
async function waitForSelectorInPage(services, sessionId, refMap, selector, options = {}, getIframeSessions) {
  if (typeof selector !== "string" || selector.length === 0) {
    throw new TypeError(
      "page.waitForSelector selector must be a non-empty string"
    );
  }
  const timeoutMs = options.timeout ?? 1e4;
  const state = options.state ?? "visible";
  const deadline = services.now() + timeoutMs;
  let iframeSessions;
  let refreshFrames = false;
  let nextDiscoveryAt = 0;
  while (true) {
    let resolved;
    try {
      if (!iframeSessions || refreshFrames && services.now() >= nextDiscoveryAt) {
        iframeSessions = await getIframeSessions(
          Math.max(1, deadline - services.now())
        );
        nextDiscoveryAt = services.now() + FRAME_DISCOVERY_REFRESH_INTERVAL_MS;
        refreshFrames = false;
      }
      resolved = await resolveElementObjectId(
        cdpAdapter(services),
        sessionId,
        refMap,
        selector,
        iframeSessions
      );
      if (state === "attached") return true;
      if (state !== "detached") {
        const response = await services.cdp(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: VISIBILITY_FUNCTION,
            objectId: resolved.objectId,
            returnByValue: true,
            awaitPromise: false
          },
          resolved.sessionId
        );
        const visible = response?.result?.value === true;
        if (state === "visible" ? visible : !visible) return true;
      }
    } catch (error) {
      if (isCdpRequestTimeoutError(error) && deadline - services.now() <= 0) {
        break;
      }
      if (!isRetryableSelectorWaitError(error, sessionId)) {
        throw error;
      }
      if (error instanceof ElementResolutionError) {
        if (state === "detached" || state === "hidden") return true;
        refreshFrames = true;
      } else {
        refreshFrames = true;
        nextDiscoveryAt = 0;
      }
    } finally {
      if (resolved?.objectId) {
        await services.cdp(
          "Runtime.releaseObject",
          { objectId: resolved.objectId },
          resolved.sessionId
        ).catch(() => {
        });
      }
    }
    const remaining = deadline - services.now();
    if (remaining <= 0) break;
    await services.sleep(Math.min(SELECTOR_POLL_INTERVAL_MS, remaining));
  }
  throw new Error(
    `page.waitForSelector timed out after ${timeoutMs}ms: ${selector}`
  );
}
function isRetryableSelectorWaitError(error, pageSessionId) {
  if (isTransientElementError(error) || isTransientNavigationContextError(error))
    return true;
  return isSessionLostError(error) && typeof error.sessionId === "string" && error.sessionId !== pageSessionId;
}
async function waitForURLInPage(services, sessionId, expected, options = {}, hooks = {}) {
  const matcher = compilePageURLMatcher(expected);
  const timeoutMs = options.timeout ?? 1e4;
  const deadline = services.now() + timeoutMs;
  let lastUrl = "";
  while (services.now() <= deadline) {
    const remaining = Math.max(1, deadline - services.now());
    let response;
    try {
      response = await services.cdp(
        "Runtime.evaluate",
        { expression: "location.href", returnByValue: true },
        sessionId,
        Math.min(1e3, remaining)
      );
    } catch (error) {
      if (isRuntimeEvaluateTimeout(error)) {
        if (services.now() >= deadline) break;
      } else if (!isTransientNavigationContextError(error)) {
        throw error;
      }
    }
    if (typeof response?.result?.value === "string") {
      lastUrl = response.result.value;
      if (matcher.matches(lastUrl)) return;
    }
    const interruption = hooks.interrupt?.(lastUrl, matcher.matches);
    if (interruption) throw interruption;
    const waitMs = deadline - services.now();
    if (waitMs <= 0) break;
    await services.sleep(Math.min(100, waitMs));
  }
  throw new Error(
    `page.waitForURL timed out after ${timeoutMs}ms: expected ${matcher.description}; last URL was ${JSON.stringify(lastUrl)}`
  );
}
function compilePageURLMatcher(expected) {
  if (typeof expected === "string") {
    if (expected.length === 0) {
      throw invalidPageURLMatcherError();
    }
    const pattern = urlGlobToRegExp(expected);
    return {
      matches: (url) => pattern.test(url),
      description: JSON.stringify(expected)
    };
  }
  if (expected instanceof RegExp) {
    const pattern = new RegExp(expected.source, expected.flags);
    return {
      matches(url) {
        pattern.lastIndex = 0;
        return pattern.test(url);
      },
      description: pattern.toString()
    };
  }
  if (typeof expected === "function") {
    return {
      matches(url) {
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return false;
        }
        let result;
        try {
          result = expected(parsed);
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          throw new TypeError(
            `page.waitForURL predicate threw: ${error.message}. The predicate receives a URL object; use url.href, url.pathname, or url.searchParams.`,
            { cause: error }
          );
        }
        if (typeof result !== "boolean") {
          throw new TypeError(
            "page.waitForURL predicate must return a boolean synchronously"
          );
        }
        return result;
      },
      description: "a URL predicate"
    };
  }
  throw invalidPageURLMatcherError();
}
function invalidPageURLMatcherError() {
  return new TypeError(
    "page.waitForURL expected URL must be a non-empty string, RegExp, or function"
  );
}
const URL_REGEX_SPECIAL_CHARS = /* @__PURE__ */ new Set([
  "$",
  "^",
  "+",
  ".",
  "*",
  "(",
  ")",
  "|",
  "\\",
  "?",
  "{",
  "}",
  "[",
  "]"
]);
function urlGlobToRegExp(glob) {
  const tokens = ["^"];
  let inGroup = false;
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "\\" && index + 1 < glob.length) {
      const escaped = glob[index += 1];
      tokens.push(
        URL_REGEX_SPECIAL_CHARS.has(escaped) ? `\\${escaped}` : escaped
      );
      continue;
    }
    if (char === "*") {
      const charBefore = glob[index - 1];
      let starCount = 1;
      while (glob[index + 1] === "*") {
        starCount += 1;
        index += 1;
      }
      if (starCount === 1) {
        tokens.push("[^/]*");
        continue;
      }
      const charAfter = glob[index + 1];
      if (charAfter === "/") {
        tokens.push(charBefore === "/" ? "(?:(?:.+)/)?" : "(?:.*/)");
        index += 1;
      } else {
        tokens.push(".*");
      }
      continue;
    }
    if (char === "{") {
      if (inGroup) {
        throw invalidURLGlobError(glob, "nested '{' is not supported");
      }
      inGroup = true;
      tokens.push("(");
      continue;
    }
    if (char === "}") {
      if (!inGroup) throw invalidURLGlobError(glob, "unmatched '}'");
      inGroup = false;
      tokens.push(")");
      continue;
    }
    if (char === "," && inGroup) {
      tokens.push("|");
      continue;
    }
    tokens.push(URL_REGEX_SPECIAL_CHARS.has(char) ? `\\${char}` : char);
  }
  if (inGroup) throw invalidURLGlobError(glob, "unmatched '{'");
  tokens.push("$");
  return new RegExp(tokens.join(""));
}
function invalidURLGlobError(glob, reason) {
  return new TypeError(`Invalid URL glob ${JSON.stringify(glob)}: ${reason}`);
}
async function navigateInPage(services, sessionId, url, options) {
  const { timeoutMs, waitUntil, referer } = options;
  const deadline = services.now() + timeoutMs;
  let committed = false;
  let navigation = {};
  try {
    if (waitUntil === "networkidle") {
      await services.ensureNetworkTracking(
        [sessionId],
        navigationTimeRemaining(services, deadline, timeoutMs, waitUntil)
      );
    }
    const response = await services.cdp(
      "Page.navigate",
      {
        url,
        ...referer === void 0 ? {} : { referrer: referer }
      },
      sessionId,
      navigationTimeRemaining(services, deadline, timeoutMs, waitUntil)
    );
    navigation = response?.result || response || {};
    if (navigation.errorText) {
      throw new Error(`page.goto failed: ${navigation.errorText}`);
    }
    if (navigation.isDownload === true) {
      throw new Error("page.goto failed: navigation started a download");
    }
    await waitForNavigationCommit(
      services,
      sessionId,
      navigation,
      deadline,
      timeoutMs,
      waitUntil
    );
    committed = true;
    if (waitUntil === "commit") return;
    await waitForLoadStateInPage(services, sessionId, waitUntil, {
      timeout: navigationTimeRemaining(
        services,
        deadline,
        timeoutMs,
        waitUntil
      )
    });
  } catch (error) {
    if (services.now() >= deadline || isLoadStateTimeout(error)) {
      if (!committed && navigation.loaderId) {
        committed = await navigationMatchesCurrentFrame(
          services,
          sessionId,
          navigation,
          250
        );
      }
      const state = committed ? await currentDocumentState(services, sessionId) : {};
      throw navigationTimeout(timeoutMs, waitUntil, {
        committed,
        ...state
      });
    }
    throw error;
  }
}
async function reloadInPage(services, sessionId, options) {
  const { timeoutMs, waitUntil } = options;
  const deadline = services.now() + timeoutMs;
  try {
    const previousFrame = await mainFrame(
      services,
      sessionId,
      reloadTimeRemaining(services, deadline, timeoutMs, waitUntil)
    );
    if (waitUntil === "networkidle") {
      await services.ensureNetworkTracking(
        [sessionId],
        reloadTimeRemaining(services, deadline, timeoutMs, waitUntil)
      );
    }
    await services.cdp(
      "Page.reload",
      previousFrame.loaderId === void 0 ? {} : { loaderId: previousFrame.loaderId },
      sessionId,
      reloadTimeRemaining(services, deadline, timeoutMs, waitUntil)
    );
    await waitForReloadCommit(
      services,
      sessionId,
      previousFrame,
      deadline,
      timeoutMs,
      waitUntil
    );
    if (waitUntil === "commit") return;
    await waitForLoadStateInPage(services, sessionId, waitUntil, {
      timeout: reloadTimeRemaining(services, deadline, timeoutMs, waitUntil)
    });
  } catch (error) {
    if (services.now() >= deadline || isLoadStateTimeout(error)) {
      throw reloadTimeout(timeoutMs, waitUntil);
    }
    throw error;
  }
}
async function mainFrame(services, sessionId, timeoutMs) {
  const response = await services.cdp(
    "Page.getFrameTree",
    {},
    sessionId,
    timeoutMs
  );
  return response?.result?.frameTree?.frame || response?.frameTree?.frame || {};
}
async function waitForReloadCommit(services, sessionId, previousFrame, deadline, timeoutMs, waitUntil) {
  while (services.now() <= deadline) {
    const remaining = reloadTimeRemaining(
      services,
      deadline,
      timeoutMs,
      waitUntil
    );
    try {
      const frame = await mainFrame(
        services,
        sessionId,
        Math.min(1e3, remaining)
      );
      if (frame.loaderId && (frame.loaderId !== previousFrame.loaderId || previousFrame.id && frame.id !== previousFrame.id)) {
        return;
      }
    } catch (error) {
      if (!isCdpTimeout(error, "Page.getFrameTree")) throw error;
    }
    const waitMs = deadline - services.now();
    if (waitMs <= 0) break;
    await services.sleep(Math.min(50, waitMs));
  }
  throw reloadTimeout(timeoutMs, waitUntil);
}
function reloadTimeRemaining(services, deadline, timeoutMs, waitUntil) {
  const remaining = deadline - services.now();
  if (remaining <= 0) throw reloadTimeout(timeoutMs, waitUntil);
  return remaining;
}
function reloadTimeout(timeoutMs, waitUntil) {
  return new Error(
    `page.reload timed out after ${timeoutMs}ms waiting for ${waitUntil}`
  );
}
async function waitForNavigationCommit(services, sessionId, navigation, deadline, timeoutMs, waitUntil) {
  if (!navigation.loaderId) return;
  while (services.now() <= deadline) {
    const remaining = navigationTimeRemaining(
      services,
      deadline,
      timeoutMs,
      waitUntil
    );
    try {
      const response = await services.cdp(
        "Page.getFrameTree",
        {},
        sessionId,
        Math.min(1e3, remaining)
      );
      const frame = response?.result?.frameTree?.frame || response?.frameTree?.frame;
      if (frame?.loaderId === navigation.loaderId && (!navigation.frameId || frame?.id === navigation.frameId)) {
        return;
      }
    } catch (error) {
      if (!isCdpTimeout(error, "Page.getFrameTree")) throw error;
    }
    const waitMs = deadline - services.now();
    if (waitMs <= 0) break;
    await services.sleep(Math.min(50, waitMs));
  }
  throw navigationTimeout(timeoutMs, waitUntil);
}
async function navigationMatchesCurrentFrame(services, sessionId, navigation, timeoutMs) {
  try {
    const response = await services.cdp(
      "Page.getFrameTree",
      {},
      sessionId,
      timeoutMs
    );
    const frame = response?.result?.frameTree?.frame || response?.frameTree?.frame;
    return Boolean(navigation.loaderId) && frame?.loaderId === navigation.loaderId && (!navigation.frameId || frame?.id === navigation.frameId);
  } catch {
    return false;
  }
}
function navigationTimeRemaining(services, deadline, timeoutMs, waitUntil) {
  const remaining = deadline - services.now();
  if (remaining <= 0) throw navigationTimeout(timeoutMs, waitUntil);
  return remaining;
}
function navigationTimeout(timeoutMs, waitUntil, details = {}) {
  const committed = details.committed === true;
  const nextStep = navigationTimeoutNextStep(waitUntil);
  const state = committed ? `; navigation committed${details.url ? ` at ${JSON.stringify(details.url)}` : ""}${details.readyState ? ` with document.readyState=${JSON.stringify(details.readyState)}` : ""}. ${nextStep}` : "";
  return new PageNavigationTimeoutError(
    `page.goto timed out after ${timeoutMs}ms waiting for ${waitUntil}${state}`,
    {
      committed,
      url: details.url,
      readyState: details.readyState,
      waitUntil,
      timeoutMs
    }
  );
}
function navigationTimeoutNextStep(waitUntil) {
  if (waitUntil === "commit") {
    return "Continue on this Page; the requested document has committed.";
  }
  if (waitUntil === "networkidle") {
    return 'Continue when the needed DOM state is observable, or call page.waitForLoadState("networkidle") if network quiescence is required.';
  }
  return `Continue on this Page; call page.waitForLoadState(${JSON.stringify(waitUntil)}) if that lifecycle state is still required.`;
}
async function currentDocumentState(services, sessionId) {
  try {
    const response = await services.cdp(
      "Runtime.evaluate",
      {
        expression: "({ __egoNavigationState: true, url: location.href, readyState: document.readyState })",
        returnByValue: true,
        timeout: 200
      },
      sessionId,
      250
    );
    const value = response?.result?.value;
    if (!value || typeof value !== "object") return {};
    return {
      ...typeof value.url === "string" ? { url: value.url } : {},
      ...typeof value.readyState === "string" ? { readyState: value.readyState } : {}
    };
  } catch {
    return {};
  }
}
function isLoadStateTimeout(error) {
  return error instanceof Error && error.message.startsWith("page.waitForLoadState(") && error.message.includes(" timed out");
}
async function waitForLoadStateInPage(services, sessionId, state, options = {}) {
  if (state !== "domcontentloaded" && state !== "load" && state !== "networkidle") {
    throw new TypeError(
      'page.waitForLoadState supports only "domcontentloaded", "load", and "networkidle"'
    );
  }
  const timeoutMs = options.timeout ?? 1e4;
  if (state !== "networkidle") {
    await waitForDocumentReadyState(services, sessionId, state, timeoutMs);
    return;
  }
  const idleMs = options.idleMs ?? 500;
  await waitForNetworkIdle(services, sessionId, timeoutMs, idleMs);
}
async function waitForDocumentReadyState(services, sessionId, state, timeoutMs) {
  const expression = state === "domcontentloaded" ? `(() => {
          const navigation = performance.getEntriesByType("navigation")[0];
          const modernEnd = Number(navigation?.domContentLoadedEventEnd || 0);
          const legacyEnd = Number(performance.timing?.domContentLoadedEventEnd || 0);
          return {
            readyState: document.readyState,
            domContentLoaded:
              document.readyState === "complete" || modernEnd > 0 || legacyEnd > 0,
          };
        })()` : "document.readyState";
  const deadline = services.now() + timeoutMs;
  while (services.now() < deadline) {
    const remaining = Math.max(1, deadline - services.now());
    let response;
    try {
      response = await services.cdp(
        "Runtime.evaluate",
        { expression, returnByValue: true },
        sessionId,
        Math.min(1e3, remaining)
      );
    } catch (error) {
      if (!isRuntimeEvaluateTimeout(error) && !isTransientNavigationContextError(error)) {
        throw error;
      }
      if (services.now() >= deadline) break;
    }
    const value = response?.result?.value;
    if (state === "load" && value === "complete") return;
    if (state === "domcontentloaded" && value?.domContentLoaded === true)
      return;
    const waitMs = deadline - services.now();
    if (waitMs <= 0) break;
    await services.sleep(Math.min(100, waitMs));
  }
  throw new Error(
    `page.waitForLoadState(${state}) timed out after ${timeoutMs}ms`
  );
}
function isRuntimeEvaluateTimeout(error) {
  return error instanceof Error && error.message.includes("CDP request timed out: Runtime.evaluate");
}
function isCdpTimeout(error, method) {
  return error instanceof Error && error.message.includes(`CDP request timed out: ${method}`);
}
function isTransientNavigationContextError(error) {
  if (!(error instanceof Error)) return false;
  return error.message.includes("Execution context was destroyed") || error.message.includes("Cannot find context with specified id") || error.message.includes("Inspected target navigated");
}
async function waitForNetworkIdle(services, sessionId, timeoutMs, idleMs) {
  const deadline = services.now() + timeoutMs;
  let sessionIds = [];
  while (services.now() <= deadline) {
    try {
      const discoveryBudget = Math.max(1, deadline - services.now());
      sessionIds = await services.pageNetworkSessions(
        sessionId,
        discoveryBudget
      );
      const trackingBudget = deadline - services.now();
      if (trackingBudget <= 0) break;
      await services.ensureNetworkTracking(sessionIds, trackingBudget);
      const activity = services.networkActivity(sessionIds);
      if (activity.tracking && activity.inflight === 0 && services.now() - activity.lastActivityAt >= idleMs) {
        return;
      }
    } catch (error) {
      if (!isRetryableNetworkRefreshError(error)) throw error;
      if (services.now() >= deadline) break;
    }
    const waitMs = deadline - services.now();
    if (waitMs <= 0) break;
    await services.sleep(Math.min(50, waitMs));
  }
  throw new Error(
    `page.waitForLoadState(networkidle) timed out after ${timeoutMs}ms`
  );
}
function isRetryableNetworkRefreshError(error) {
  if (isCdpRequestTimeoutError(error) || isSessionLostError(error)) return true;
  return /CDP request timed out:|detached Page session/i.test(
    error instanceof Error ? error.message : String(error)
  );
}
function cdpAdapter(services) {
  return {
    sendRaw(method, params, sessionId) {
      return services.cdp(method, params, sessionId);
    }
  };
}
export {
  PageNavigationTimeoutError,
  isTransientElementError,
  navigateInPage,
  reloadInPage,
  waitForLoadStateInPage,
  waitForSelectorInPage,
  waitForURLInPage
};
