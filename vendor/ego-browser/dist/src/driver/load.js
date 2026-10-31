import { cdp, js } from "../cdp-eval.js";
import { state } from "../state.js";
async function waitForDocumentLoad(options = {}) {
  const timeout = options.timeout ?? 15;
  const deadline = state.now() + timeout * 1e3;
  while (state.now() < deadline) {
    let committed = true;
    try {
      const tree = await cdp("Page.getFrameTree");
      const url = tree.frameTree?.frame?.url || "";
      committed = url !== "" && url !== ":" && url !== "about:blank";
    } catch {
    }
    if (committed && await js("document.readyState") === "complete") {
      return true;
    }
    await state.sleep(300);
  }
  return false;
}
export {
  waitForDocumentLoad
};
