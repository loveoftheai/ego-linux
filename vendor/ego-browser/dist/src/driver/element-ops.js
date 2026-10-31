import { cdp } from "../cdp-eval.js";
import { browserRefMap, ensureRefMapForRef } from "../ref-state.js";
import { resolveElementObjectId } from "../element-resolver.js";
async function resolveHandle(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return resolveElementObjectId(
    { sendRaw: cdp },
    void 0,
    browserRefMap,
    selectorOrRef
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
  withHandle
};
