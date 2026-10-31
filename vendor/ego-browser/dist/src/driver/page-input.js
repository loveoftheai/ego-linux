import { isAbsolute } from "node:path";
import { resolveElementObjectId } from "../element-resolver.js";
import { COMPOSED_TREE_HELPERS } from "./action-target.js";
const RESOLVE_FILE_INPUT_SOURCE = `function resolveFileInputForUpload() {
  ${COMPOSED_TREE_HELPERS}
  const isFileInput = (element) =>
    String(element?.tagName || "").toUpperCase() === "INPUT" &&
    String(element.type || "").toLowerCase() === "file";
  if (isFileInput(this)) return this;
  const isFileLabel = (element) =>
    String(element?.tagName || "").toUpperCase() === "LABEL" &&
    isFileInput(element.control);
  if (isFileLabel(this)) {
    return this.control;
  }
  const label = nearestComposedAncestor(this, isFileLabel);
  if (label) return label.control;
  const descendants = composedDescendantMatches(this, isFileInput, true);
  if (descendants.length === 1) return descendants[0];
  if (descendants.length > 1) {
    throw new TypeError(
      "page.setInputFiles selected a container with multiple file inputs",
    );
  }
  throw new TypeError(
    "page.setInputFiles requires a file input, its label, or a container with a file input",
  );
}`;
async function setInputFilesInPage(services, sessionId, refMap, selector, path, iframeSessions = /* @__PURE__ */ new Map()) {
  const files = normalizeFilePaths(path, "page.setInputFiles");
  const resolved = await resolveElementObjectId(
    cdpAdapter(services),
    sessionId,
    refMap,
    selector,
    iframeSessions,
    { strict: true }
  );
  let inputObjectId;
  try {
    const input = await services.cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: RESOLVE_FILE_INPUT_SOURCE,
        objectId: resolved.objectId,
        returnByValue: false,
        awaitPromise: false
      },
      resolved.sessionId
    );
    if (input?.exceptionDetails) {
      throw new TypeError(
        input.exceptionDetails.exception?.description || input.exceptionDetails.text || "page.setInputFiles could not resolve a file input"
      );
    }
    inputObjectId = input?.result?.objectId;
    if (!inputObjectId) {
      throw new TypeError("page.setInputFiles could not resolve a file input");
    }
    await setFilesOnBackendNode(
      services,
      resolved.sessionId,
      files,
      void 0,
      inputObjectId
    );
  } finally {
    if (inputObjectId && inputObjectId !== resolved.objectId) {
      await releaseObject(services, resolved.sessionId, inputObjectId);
    }
    await releaseObject(services, resolved.sessionId, resolved.objectId);
  }
}
function normalizeFilePaths(path, methodName) {
  const files = Array.isArray(path) ? path : [path];
  if (files.some(
    (file) => typeof file !== "string" || file.length === 0 || !isAbsolute(file)
  )) {
    throw new TypeError(`${methodName} requires absolute file paths`);
  }
  return files;
}
async function setFilesOnBackendNode(services, sessionId, files, backendNodeId, objectId) {
  await services.cdp(
    "DOM.setFileInputFiles",
    {
      files,
      ...backendNodeId === void 0 ? {} : { backendNodeId },
      ...objectId === void 0 ? {} : { objectId }
    },
    sessionId
  );
}
function cdpAdapter(services) {
  return {
    sendRaw(method, params, sessionId) {
      return services.cdp(method, params, sessionId);
    }
  };
}
async function releaseObject(services, sessionId, objectId) {
  await services.cdp("Runtime.releaseObject", { objectId }, sessionId).catch(() => {
  });
}
export {
  normalizeFilePaths,
  setFilesOnBackendNode,
  setInputFilesInPage
};
