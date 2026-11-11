import { randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { state } from "../state.js";
import { cdp, runtimeValue } from "../cdp-eval.js";
import {
  browserEgo,
  browserSnapshotRefsToRefMap,
  drainBrowserEvents,
  ensureSession,
  isBrowserRuntime
} from "../browser-runtime.js";
import { invokeEgo } from "../ego-errors.js";
import { resolveElementCenter } from "../element-resolver.js";
import { resolveInPageFrames } from "./element-ops.js";
import { compactSnapshotResult } from "../snapshot-result.js";
import {
  browserRefMap,
  ensureRefMapForRef,
  registerSnapshotForRefRefresh
} from "../ref-state.js";
async function drainEvents() {
  const sessionId = isBrowserRuntime() ? await ensureSession() : void 0;
  return drainBrowserEvents(sessionId);
}
async function snapshot(options = {}) {
  const result = await invokeEgo(
    "snapshot",
    () => browserEgo().snapshot(options)
  );
  compactSnapshotResult(result);
  browserSnapshotRefsToRefMap(browserRefMap, result.refs || []);
  return result;
}
registerSnapshotForRefRefresh(() => snapshot());
const snapshotRaw = snapshot;
async function snapshotText(options = {}) {
  const result = await snapshot({
    scope: options.scope ?? "full_page",
    ...options.root === void 0 ? {} : { root: options.root },
    includeActionMarks: options.includeActionMarks ?? true,
    includeStableLocator: options.includeStableLocator ?? true
  });
  return result.content || "";
}
async function elementCenter(selectorOrRef) {
  await ensureRefMapForRef(selectorOrRef);
  return resolveInPageFrames(
    selectorOrRef,
    (iframeSessions) => resolveElementCenter(
      { sendRaw: cdp },
      void 0,
      browserRefMap,
      selectorOrRef,
      iframeSessions
    )
  );
}
function defaultScreenshotPath() {
  const outputDir = globalThis.EGO_BROWSER_OUTPUT_DIR;
  let directory = tmpdir();
  if (outputDir !== void 0) {
    if (typeof outputDir !== "string" || outputDir.length === 0 || !isAbsolute(outputDir)) {
      throw new TypeError(
        "globalThis.EGO_BROWSER_OUTPUT_DIR must be an absolute directory path"
      );
    }
    directory = outputDir;
  }
  const suffix = String(randomInt(0, 1e6)).padStart(6, "0");
  return join(directory, `ego-browser-shot-${suffix}.png`);
}
async function captureScreenshot(path, options = {}) {
  assertScreenshotScale(options.scale);
  const sessionId = isBrowserRuntime() ? await ensureSession() : void 0;
  return captureScreenshotForSession(path, options, sessionId);
}
async function captureScreenshotForSession(path, options = {}, sessionId) {
  assertScreenshotScale(options.scale);
  const outputPath = path ?? defaultScreenshotPath();
  const full = options.full ?? false;
  const scale = options.scale ?? "css";
  const raw = scale === "css" ? false : options.raw ?? false;
  const params = {
    format: "png",
    captureBeyondViewport: full
  };
  if (raw) {
    if (options.clip) {
      params.clip = { ...options.clip };
    }
  } else {
    const dprExpression = "window.devicePixelRatio";
    const dpr = Number(
      runtimeValue(
        await cdp(
          "Runtime.evaluate",
          {
            expression: dprExpression,
            returnByValue: true
          },
          sessionId
        ),
        dprExpression
      )
    ) || 1;
    const cssScale = 1 / dpr;
    if (options.clip) {
      params.clip = { scale: cssScale, ...options.clip };
    } else {
      const infoExpression = "({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})";
      const info = runtimeValue(
        await cdp(
          "Runtime.evaluate",
          {
            expression: infoExpression,
            returnByValue: true
          },
          sessionId
        ),
        infoExpression
      );
      params.clip = {
        // CDP interprets clip coordinates in the page's document coordinate
        // space. A viewport screenshot therefore starts at the current scroll
        // offset, while a full-page screenshot still starts at the document
        // origin.
        x: full ? 0 : info.sx,
        y: full ? 0 : info.sy,
        width: full ? info.pw : info.w,
        height: full ? info.ph : info.h,
        scale: cssScale
      };
    }
  }
  const result = await cdp("Page.captureScreenshot", params, sessionId);
  await mkdir(dirname(outputPath), { recursive: true });
  await state.writeFile(outputPath, Buffer.from(result.data, "base64"));
  return outputPath;
}
function assertScreenshotScale(scale) {
  if (scale !== void 0 && scale !== "css") {
    throw new TypeError("captureScreenshot scale must be css");
  }
}
export {
  captureScreenshot,
  captureScreenshotForSession,
  drainEvents,
  elementCenter,
  snapshot,
  snapshotRaw,
  snapshotText
};
