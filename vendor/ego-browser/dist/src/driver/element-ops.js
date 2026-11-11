import { cdp } from "../cdp-eval.js";
import { browserRefMap, ensureRefMapForRef } from "../ref-state.js";
import { resolveElementObjectId } from "../element-resolver.js";
import { parseRef } from "../ref-map.js";
async function resolveInPageFrames(selectorOrRef, resolve) {
  try {
    return await resolve(/* @__PURE__ */ new Map());
  } catch (error) {
    if (typeof selectorOrRef !== "string" || parseRef(selectorOrRef) || !/ matched 0 elements/.test(error?.message || "")) {
      throw error;
    }
    const iframeSessions = await sameProcessFrames();
    if (iframeSessions.size === 0) throw error;
    return resolve(iframeSessions);
  }
}
async function sameProcessFrames() {
  const frames = /* @__PURE__ */ new Map();
  let tree;
  let targetInfos;
  try {
    [tree, targetInfos] = await Promise.all([
      cdp("Page.getFrameTree").then((result) => result?.frameTree),
      cdp("Target.getTargets").then((result) => result?.targetInfos)
    ]);
  } catch {
    return frames;
  }
  if (!Array.isArray(targetInfos)) return frames;
  const outOfProcess = new Set(
    targetInfos.filter((info) => info?.type === "iframe").map((info) => info.targetId)
  );
  const visit = (node) => {
    for (const child of node?.childFrames || []) {
      const frameId = child?.frame?.id;
      if (typeof frameId !== "string" || outOfProcess.has(frameId)) continue;
      frames.set(frameId, void 0);
      visit(child);
    }
  };
  visit(tree);
  return frames;
}
async function resolveHandle(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return resolveInPageFrames(
    selectorOrRef,
    (iframeSessions) => resolveElementObjectId(
      { sendRaw: cdp },
      void 0,
      browserRefMap,
      selectorOrRef,
      iframeSessions
    )
  );
}
async function releaseHandle(objectId, sessionId) {
  if (!objectId) return;
  try {
    await cdp("Runtime.releaseObject", { objectId }, sessionId);
  } catch {
  }
}
async function withHandle(selectorOrRef, fn) {
  const handle = await resolveHandle(selectorOrRef);
  try {
    return await fn(handle);
  } finally {
    await releaseHandle(handle.objectId, handle.sessionId);
  }
}
async function resolveAndCall(selectorOrRef, functionDeclaration, args = []) {
  return withHandle(selectorOrRef, async ({ objectId, sessionId }) => {
    const result = await cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration,
        objectId,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: false
      },
      sessionId
    );
    return { result, objectId, sessionId };
  });
}
export {
  releaseHandle,
  resolveAndCall,
  resolveHandle,
  resolveInPageFrames,
  withHandle
};
