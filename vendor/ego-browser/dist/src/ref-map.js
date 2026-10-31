class RefMap {
  map;
  allowFallback;
  constructor({ allowFallback = true } = {}) {
    this.map = /* @__PURE__ */ new Map();
    this.allowFallback = allowFallback;
  }
  add(refId, backendNodeId, role, name, nth = void 0) {
    this.addWithFrame(refId, backendNodeId, role, name, nth, void 0);
  }
  addWithFrame(refId, backendNodeId, role, name, nth = void 0, frameId = void 0, frameProvenance = void 0) {
    this.map.set(refId, {
      backendNodeId,
      role,
      name,
      nth,
      frameId,
      ...frameProvenance ? { frameProvenance } : {}
    });
  }
  get(refId) {
    return this.map.get(refId);
  }
  clear() {
    this.map.clear();
  }
}
function parseRef(input) {
  const trimmed = String(input || "").trim();
  for (const candidate of [
    trimmed.startsWith("@") ? trimmed.slice(1) : null,
    trimmed.startsWith("ref=") ? trimmed.slice(4) : null,
    trimmed
  ]) {
    if (candidate && /^\d+$/.test(candidate)) {
      return candidate;
    }
  }
  return null;
}
export {
  RefMap,
  parseRef
};
