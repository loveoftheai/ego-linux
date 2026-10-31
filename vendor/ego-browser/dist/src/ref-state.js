import { parseRef, RefMap } from "./ref-map.js";
const browserRefMap = new RefMap();
let ensuring = false;
let snapshotImpl = null;
function registerSnapshotForRefRefresh(fn) {
  snapshotImpl = fn;
}
async function ensureRefMapForRef(selectorOrRef) {
  if (ensuring) return;
  if (typeof selectorOrRef !== "string") return;
  if (!parseRef(selectorOrRef)) return;
  if (browserRefMap.map.size > 0) return;
  if (!snapshotImpl) return;
  ensuring = true;
  try {
    await snapshotImpl();
  } finally {
    ensuring = false;
  }
}
export {
  browserRefMap,
  ensureRefMapForRef,
  registerSnapshotForRefRefresh
};
