import { setTimeout as delay } from "node:timers/promises";
const PROBE_TIMEOUT_MS = 500;
async function emitUpdateNotice(runtime, emit) {
  if (typeof runtime?.getBrowserVersion !== "function") return;
  try {
    const result = await Promise.race([
      runtime.getBrowserVersion(),
      delay(PROBE_TIMEOUT_MS, null, { ref: false })
    ]);
    if (!result || typeof result !== "object") return;
    const info = result;
    if (info.updateAvailable !== true || typeof info.currentVersion !== "string" || info.currentVersion.trim().length === 0) {
      return;
    }
    emit(
      `[ego-browser:notice] Ego Lite update is available (current ${info.currentVersion.trim()}). Finish the current browser task, then ask the user before running \`ego-browser upgrade\`; re-read the ego-browser Skill afterward.`
    );
  } catch {
  }
}
export {
  emitUpdateNotice
};
