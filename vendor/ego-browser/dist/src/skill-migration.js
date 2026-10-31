import { markHardStop } from "./output-sink.js";
const STALE_SKILL_PREFIX = "[ego-browser:skill-stale]";
const EGO_BROWSER_13_MEMBERS = /* @__PURE__ */ new Set([
  "helper",
  "site",
  "showTaskState",
  "snapshot",
  "listProfile",
  "listTaskSpace",
  "newTaskSpace",
  "switchTaskSpace",
  "claimTaskSpace",
  "handOffTaskSpace",
  "takeOverTaskSpace",
  "waitForAgentControlTaskSpace",
  "completeTaskSpace",
  "closeTaskSpace"
]);
class EgoBrowserSkillStaleError extends Error {
  constructor(member) {
    super(
      [
        `${STALE_SKILL_PREFIX} This script uses the old egoBrowser.${member} API.`,
        "Run `ego-browser skill` to read the current usage guide, then retry with the TaskSpace/Page API. Start with:",
        "  const task = await taskSpace(nameOrId)"
      ].join("\n")
    );
    this.name = "EgoBrowserSkillStaleError";
  }
}
function createStaleEgoBrowserGuard() {
  return new Proxy(/* @__PURE__ */ Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string" || !EGO_BROWSER_13_MEMBERS.has(property)) {
        return void 0;
      }
      const error = new EgoBrowserSkillStaleError(property);
      markHardStop(error.message);
      throw error;
    }
  });
}
function installStaleEgoBrowserGuard(target) {
  Object.defineProperty(target, "egoBrowser", {
    value: createStaleEgoBrowserGuard(),
    writable: true,
    configurable: true,
    enumerable: false
  });
}
export {
  EgoBrowserSkillStaleError,
  STALE_SKILL_PREFIX,
  createStaleEgoBrowserGuard,
  installStaleEgoBrowserGuard
};
