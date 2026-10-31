import { RefMap } from "./ref-map.js";
const MAX_INVALIDATED_REFS_PER_TARGET = 1e4;
class PageRefRegistry {
  #targets = /* @__PURE__ */ new Map();
  #states = /* @__PURE__ */ new Map();
  forTarget(targetId) {
    assertTargetId(targetId);
    let refs = this.#targets.get(targetId);
    if (!refs) {
      refs = new RefMap({ allowFallback: false });
      this.#targets.set(targetId, refs);
    }
    return refs;
  }
  replace(targetId, snapshotRefs = []) {
    return this.#register(targetId, snapshotRefs, true);
  }
  merge(targetId, snapshotRefs = []) {
    return this.#register(targetId, snapshotRefs, false);
  }
  exportState(targetId) {
    return structuredClone(this.#states.get(targetId));
  }
  restore(targetId, state) {
    this.clear(targetId);
    if (state) this.#states.set(targetId, validatePageRefState(state));
    this.#rebuild(targetId);
  }
  invalidateChangedDocuments(targetId, documents) {
    const state = this.#states.get(targetId);
    if (!state) return;
    for (const ref of state.refs) {
      if (!ref.documentId || ref.documentId !== pageRefDocumentId(ref, documents)) {
        ref.active = false;
      }
    }
    this.#rebuild(targetId);
  }
  #register(targetId, snapshotRefs, replace) {
    assertTargetId(targetId);
    const state = this.#states.get(targetId) || { nextRef: 1, refs: [] };
    const byIdentity = new Map(
      state.refs.filter((ref) => ref.frameProvenance !== "unknown").map((ref) => [nodeIdentity(ref), ref])
    );
    const byId = new Map(state.refs.map((ref) => [ref.refId, ref]));
    const firstUnused = state.nextRef;
    if (replace) for (const ref of state.refs) ref.active = false;
    for (const ref of snapshotRefs) {
      if (!ref || !Number.isSafeInteger(ref.backendNodeId) || ref.backendNodeId <= 0)
        continue;
      const previous = ref.frameProvenance === "unknown" ? void 0 : byIdentity.get(nodeIdentity(ref));
      let refId = previous?.refId;
      if (!refId) {
        const nativeId = Number(ref.refId ?? ref.backendNodeId);
        const candidate = Number.isSafeInteger(nativeId) && nativeId >= firstUnused && !byId.has(String(nativeId)) ? nativeId : state.nextRef;
        refId = String(candidate);
        state.nextRef = Math.max(state.nextRef, candidate + 1);
        if (!Number.isSafeInteger(state.nextRef))
          throw new Error("Page ref ids exhausted");
      }
      ref.refId = Number(refId);
      const stored = {
        refId,
        backendNodeId: ref.backendNodeId,
        role: ref.role,
        name: ref.name,
        frameId: ref.frameId,
        frameProvenance: ref.frameProvenance,
        documentId: ref.documentId,
        active: true
      };
      byId.set(refId, stored);
      byIdentity.set(nodeIdentity(stored), stored);
    }
    state.refs = [...byId.values()];
    this.#states.set(targetId, state);
    return this.#rebuild(targetId);
  }
  invalidate(targetId) {
    assertTargetId(targetId);
    const state = this.#states.get(targetId);
    if (state) for (const ref of state.refs) ref.active = false;
    this.#rebuild(targetId);
  }
  isInvalidated(targetId, refId) {
    assertTargetId(targetId);
    return this.#states.get(targetId)?.refs.some((ref) => ref.refId === refId && !ref.active) ?? false;
  }
  clear(targetId) {
    assertTargetId(targetId);
    this.#targets.delete(targetId);
    this.#states.delete(targetId);
  }
  #rebuild(targetId) {
    const refs = new RefMap({ allowFallback: false });
    const state = this.#states.get(targetId);
    if (state) {
      let inactive = state.refs.filter((ref) => !ref.active).length;
      state.refs = state.refs.filter((ref) => {
        if (!ref.active && inactive > MAX_INVALIDATED_REFS_PER_TARGET) {
          inactive--;
          return false;
        }
        if (ref.active)
          refs.addWithFrame(
            ref.refId,
            ref.backendNodeId,
            ref.role,
            ref.name,
            void 0,
            ref.frameId,
            ref.frameProvenance
          );
        return true;
      });
    }
    this.#targets.set(targetId, refs);
    return refs;
  }
}
function validatePageRefState(value) {
  const state = value;
  const ids = /* @__PURE__ */ new Set();
  if (!state || !Number.isSafeInteger(state.nextRef) || state.nextRef < 1 || !Array.isArray(state.refs) || state.refs.some((ref) => {
    if (!ref || typeof ref.refId !== "string" || !/^[1-9]\d*$/.test(ref.refId) || ids.has(ref.refId) || Number(ref.refId) >= state.nextRef || !Number.isSafeInteger(ref.backendNodeId) || ref.backendNodeId <= 0 || typeof ref.active !== "boolean" || ![void 0, "page", "frame", "unknown"].includes(
      ref.frameProvenance
    ) || [ref.frameId, ref.documentId, ref.role, ref.name].some(
      (value2) => value2 !== void 0 && typeof value2 !== "string"
    ))
      return true;
    ids.add(ref.refId);
    return false;
  }))
    throw new Error("Invalid persisted Page refs; take a new snapshot");
  return structuredClone(state);
}
function nodeIdentity(ref) {
  return JSON.stringify([
    ref.frameId ?? null,
    ref.backendNodeId,
    ref.documentId ?? null
  ]);
}
function pageRefDocumentId(ref, documents) {
  return ref.frameProvenance === "unknown" ? JSON.stringify([...documents].sort(([a], [b]) => a.localeCompare(b))) : documents.get(ref.frameId || "");
}
function assertTargetId(targetId) {
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new TypeError("PageRefRegistry requires a non-empty targetId");
  }
}
export {
  PageRefRegistry,
  pageRefDocumentId,
  validatePageRefState
};
