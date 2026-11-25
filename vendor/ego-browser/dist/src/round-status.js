const REFRESH_TIMEOUT_MS = 1500;
const touched = /* @__PURE__ */ new Map();
const statuses = /* @__PURE__ */ new Map();
const expired = /* @__PURE__ */ new Set();
function touchRoundSpace(spaceId, name, refresh) {
  touched.set(spaceId, { name, refresh });
}
function recordRoundSpaceStatus(spaceId, status) {
  if (expired.has(spaceId)) return;
  statuses.set(spaceId, status);
}
function forgetRoundSpaceStatus(spaceId) {
  statuses.delete(spaceId);
  expired.delete(spaceId);
}
function addRoundStatusPage(spaceId, page) {
  const status = statuses.get(spaceId);
  if (status?.state !== "ready" || !status.pages) return;
  status.pages = sortPages([
    ...status.pages.filter((item) => item.label !== page.label),
    page
  ]);
}
function removeRoundStatusPage(spaceId, label) {
  const status = statuses.get(spaceId);
  if (status?.state !== "ready" || !status.pages) return;
  status.pages = status.pages.filter((item) => item.label !== label);
}
async function refreshRoundStatus(timeoutMs = REFRESH_TIMEOUT_MS) {
  const pending = [...touched].filter(([spaceId, space]) => {
    const state = statuses.get(spaceId)?.state;
    return space.refresh && (state === void 0 || state === "ready");
  });
  if (pending.length === 0) return;
  const deadline = Date.now() + timeoutMs;
  for (const [spaceId, space] of pending) {
    const remaining = deadline - Date.now();
    const unknown = { state: "unknown", pages: null };
    const controller = new AbortController();
    let status = unknown;
    if (remaining > 0) {
      status = await withTimeout(
        space.refresh(controller.signal),
        remaining
      ).catch(() => unknown);
    }
    if (status === unknown) {
      controller.abort();
      expired.add(spaceId);
    }
    statuses.set(spaceId, status);
  }
}
function roundStatusNeedsRefresh() {
  return [...touched].some(([spaceId, space]) => {
    const state = statuses.get(spaceId)?.state;
    return space.refresh && (state === void 0 || state === "ready");
  });
}
function formatRoundStatus(notices) {
  if (touched.size === 0) return { line: "", remainingNotices: notices };
  const noticeByTarget = new Map(
    notices.map((notice) => [
      noticeKey(notice.spaceId, notice.targetId),
      notice
    ])
  );
  const folded = /* @__PURE__ */ new Set();
  const parts = [...touched].map(([spaceId, space]) => {
    const status = statuses.get(spaceId) ?? { state: "unknown", pages: null };
    const pages = (status.pages ?? []).map((page) => {
      const notice = noticeByTarget.get(noticeKey(spaceId, page.targetId));
      if (notice) folded.add(notice);
      const tags = pageTags(page, notice);
      return `${page.label} ${JSON.stringify(page.title)}${tags.length > 0 ? ` (${tags.join(", ")})` : ""}`;
    });
    const head = `${spaceId} ${JSON.stringify(space.name)} ${status.state}`;
    return pages.length > 0 ? `${head}: ${pages.join(", ")}` : head;
  });
  return {
    line: `[${parts.join("; ")}]
`,
    remainingNotices: notices.filter((notice) => !folded.has(notice))
  };
}
function resetRoundStatus() {
  touched.clear();
  statuses.clear();
  expired.clear();
}
function sortPages(pages) {
  return [...pages].sort((a, b) => labelNumber(a.label) - labelNumber(b.label));
}
function pageTags(page, notice) {
  const tags = [];
  if (page.openedBy !== "agent") tags.push("user");
  if (notice) {
    tags.push(notice.openerLabel ? `new from ${notice.openerLabel}` : "new");
  }
  return tags;
}
function labelNumber(label) {
  const match = /^p(\d+)$/.exec(label);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}
function noticeKey(spaceId, targetId) {
  return `${spaceId}:${targetId}`;
}
function withTimeout(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("round status timed out")),
      timeoutMs
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
export {
  addRoundStatusPage,
  forgetRoundSpaceStatus,
  formatRoundStatus,
  recordRoundSpaceStatus,
  refreshRoundStatus,
  removeRoundStatusPage,
  resetRoundStatus,
  roundStatusNeedsRefresh,
  sortPages,
  touchRoundSpace
};
