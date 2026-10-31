const pendingPageNotices = /* @__PURE__ */ new Map();
const observedPages = /* @__PURE__ */ new Set();
const pageNoticeListeners = /* @__PURE__ */ new Set();
function recordUnhandledPage(notice) {
  const key = pageKey(notice.spaceId, notice.targetId);
  if (observedPages.has(key)) return;
  const merged = {
    ...pendingPageNotices.get(key),
    ...notice
  };
  pendingPageNotices.set(key, merged);
  for (const listener of [...pageNoticeListeners]) listener(merged);
}
function refreshUnhandledPageNotice(spaceId, targetId, url) {
  const key = pageKey(spaceId, targetId);
  const existing = pendingPageNotices.get(key);
  if (!existing) return;
  recordUnhandledPage({ ...existing, url });
}
function markPageObserved(spaceId, targetId) {
  const key = pageKey(spaceId, targetId);
  observedPages.add(key);
  pendingPageNotices.delete(key);
}
function forgetPageNotice(spaceId, targetId) {
  const key = pageKey(spaceId, targetId);
  pendingPageNotices.delete(key);
  observedPages.delete(key);
}
function clearSpacePageNotices(spaceId) {
  const prefix = `${spaceId}:`;
  for (const key of pendingPageNotices.keys()) {
    if (key.startsWith(prefix)) pendingPageNotices.delete(key);
  }
  for (const key of observedPages) {
    if (key.startsWith(prefix)) observedPages.delete(key);
  }
}
function peekUnhandledPageNotices() {
  return [...pendingPageNotices.values()].map((notice) => ({ ...notice }));
}
function subscribeUnhandledPageNotices(listener) {
  pageNoticeListeners.add(listener);
  return () => pageNoticeListeners.delete(listener);
}
function consumeUnhandledPageNotices() {
  const notices = peekUnhandledPageNotices();
  pendingPageNotices.clear();
  return notices;
}
function resetPageNotices() {
  pendingPageNotices.clear();
  observedPages.clear();
  pageNoticeListeners.clear();
}
function pageKey(spaceId, targetId) {
  return `${spaceId}:${targetId}`;
}
export {
  clearSpacePageNotices,
  consumeUnhandledPageNotices,
  forgetPageNotice,
  markPageObserved,
  peekUnhandledPageNotices,
  recordUnhandledPage,
  refreshUnhandledPageNotice,
  resetPageNotices,
  subscribeUnhandledPageNotices
};
