import {
  browserEgo,
  clearPreferredTarget,
  ensureSession,
  invalidateSession,
  isBrowserRuntime,
  pendingDialog,
  setPreferredTarget
} from "../browser-runtime.js";
import { cdp, js } from "../cdp-eval.js";
import { invokeEgo } from "../ego-errors.js";
import { state } from "../state.js";
import { waitForDocumentLoad } from "./load.js";
const INTERNAL_URL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "chrome-extension://",
  "about:"
];
async function gotoUrl(url) {
  return cdp("Page.navigate", { url });
}
async function gotoAndWait(url, options = {}) {
  const navigation = await gotoUrl(url);
  const loaded = options.wait === false ? false : await waitForDocumentLoad({ timeout: options.timeout ?? 20 });
  const settle = Number(options.settle ?? 0);
  if (settle > 0) {
    await state.sleep(settle * 1e3);
  }
  return { navigation, loaded };
}
async function pageInfo() {
  if (isBrowserRuntime()) {
    const sessionId = await ensureSession();
    const dialog = pendingDialog(sessionId);
    if (dialog) {
      return { dialog };
    }
  }
  const expression = "JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})";
  return JSON.parse(await js(expression));
}
async function listTabs(options = {}) {
  const includeChrome = options.includeChrome ?? true;
  const result = await invokeEgo("listTabs", () => browserEgo().listTabs());
  const tabs = result.tabs || [];
  return tabs.filter(
    (tab) => includeChrome || !INTERNAL_URL_PREFIXES.some(
      (prefix) => (tab.url || "").startsWith(prefix)
    )
  ).map((tab) => ({
    targetId: tab.targetId,
    title: tab.title || "",
    url: tab.url || "",
    active: Boolean(tab.active),
    index: tab.index
  }));
}
async function currentTab() {
  const tabs = await listTabs();
  const active = tabs.find((tab) => tab.active) || tabs[0];
  if (!active) {
    throw new Error("no active browser tab");
  }
  return { targetId: active.targetId, url: active.url, title: active.title };
}
async function switchTab(target) {
  const targetId = typeof target === "object" ? target.targetId : target;
  await cdp("Target.activateTarget", { targetId });
  setPreferredTarget(targetId);
  return targetId;
}
async function newTab(url = "about:blank") {
  const result = await invokeEgo("newTab", () => browserEgo().createTab(url));
  if (!result.targetId) {
    throw new Error("newTab returned no targetId");
  }
  setPreferredTarget(result.targetId);
  return result.targetId;
}
async function openOrReuseTab(url, options = {}) {
  const tabs = await listTabs({ includeChrome: false });
  const match = options.match || "exact";
  const existing = tabs.find((tab) => tabMatchesUrl(tab.url, url, match));
  if (existing) {
    await switchTab(existing.targetId);
    if (options.wait) {
      await waitForDocumentLoad({ timeout: options.timeout ?? 20 });
    }
    const settle2 = Number(options.settle ?? 0);
    if (settle2 > 0) {
      await state.sleep(settle2 * 1e3);
    }
    return { ...existing, active: true, reused: true };
  }
  const targetId = await newTab(url);
  if (options.wait !== false) {
    await waitForDocumentLoad({ timeout: options.timeout ?? 20 });
  }
  const settle = Number(options.settle ?? 0);
  if (settle > 0) {
    await state.sleep(settle * 1e3);
  }
  return { targetId, url, title: "", active: true, reused: false };
}
async function closeTab(target = void 0) {
  const targetId = target === void 0 ? (await currentTab()).targetId : typeof target === "object" ? target.targetId : target;
  if (!targetId) {
    throw new Error("closeTab requires a targetId");
  }
  await cdp("Target.closeTarget", { targetId });
  invalidateSession(targetId);
  if (state.preferredTargetId === targetId) {
    clearPreferredTarget();
  }
  return targetId;
}
async function ensureRealTab() {
  const tabs = await listTabs({ includeChrome: false });
  if (tabs.length === 0) {
    return null;
  }
  const current = await currentTab().catch(() => null);
  if (current?.url && !INTERNAL_URL_PREFIXES.some((prefix) => current.url.startsWith(prefix))) {
    return current;
  }
  await switchTab(tabs[0].targetId);
  return tabs[0];
}
async function iframeTarget(urlSubstring) {
  const targets = (await cdp("Target.getTargets")).targetInfos || [];
  return targets.find(
    (target) => target.type === "iframe" && (target.url || "").includes(urlSubstring)
  )?.targetId || null;
}
function tabMatchesUrl(tabUrl, wantedUrl, match) {
  if (!tabUrl) {
    return false;
  }
  if (match === "includes") {
    return tabUrl.includes(wantedUrl);
  }
  let tab;
  let wanted;
  try {
    tab = new URL(tabUrl);
    wanted = new URL(wantedUrl);
  } catch {
    return tabUrl === wantedUrl;
  }
  if (match === "origin") {
    return tab.origin === wanted.origin;
  }
  if (match === "origin+path") {
    return tab.origin === wanted.origin && trimSlash(tab.pathname) === trimSlash(wanted.pathname);
  }
  return tab.href === wanted.href;
}
function trimSlash(pathname) {
  return pathname.replace(/\/+$/, "") || "/";
}
export {
  INTERNAL_URL_PREFIXES,
  closeTab,
  currentTab,
  ensureRealTab,
  gotoAndWait,
  gotoUrl,
  iframeTarget,
  listTabs,
  newTab,
  openOrReuseTab,
  pageInfo,
  switchTab
};
