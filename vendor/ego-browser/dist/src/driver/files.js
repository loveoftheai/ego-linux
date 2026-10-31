import { cdp } from "../cdp-eval.js";
import { withHandle } from "./element-ops.js";
async function uploadFile(selector, path) {
  const files = Array.isArray(path) ? path : [path];
  await withHandle(selector, async ({ objectId, sessionId }) => {
    await cdp("DOM.setFileInputFiles", { files, objectId }, sessionId);
  });
}
export {
  uploadFile
};
