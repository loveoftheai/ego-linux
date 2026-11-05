import { cdp, js } from "../cdp-eval.js";
import { browserCdp } from "../browser-runtime.js";
import {
  buildFindElementJs,
  ElementResolutionError,
  isRawSelector
} from "../element-resolver.js";
import { CLICK_POINT_HELPERS } from "./action-target.js";
import { elementCenter } from "./observe.js";
import { resolveAndCall } from "./element-ops.js";
const INPUT_EVENT_DELAY_MS = 0;
const INPUT_DISPATCH_TIMEOUT_MS = 1e3;
const CLICK_PROBE_TTL_MS = 5e3;
async function click(target, options = {}) {
  const { probeId, ...point } = await resolveClickTarget(target);
  const button = options.button || "left";
  const buttons = pressedButtons(button);
  const clickCount = options.clickCount ?? options.clicks ?? 1;
  maybeHighlight(point, options.label);
  try {
    await dispatchMouse(point, "mouseMoved", {
      button: "none",
      buttons: 0
    });
    await inputEventDelay();
    await dispatchMouse(point, "mousePressed", {
      button,
      buttons,
      clickCount
    });
    await inputEventDelay();
    await dispatchMouse(point, "mouseReleased", {
      button,
      buttons: 0,
      clickCount
    });
  } catch (error) {
    if (!isInputDispatchTimeout(error)) throw error;
    const completed = await finishClickProbe(point, probeId, clickCount);
    if (!completed) throw error;
  }
}
async function doubleClick(target, options = {}) {
  await click(target, { ...options, clickCount: 2 });
}
async function hover(target, options = {}) {
  const point = await resolveMouseTarget(target);
  maybeHighlight(point, options.label);
  const probeId = await installHoverProbe(point);
  let dispatchError = null;
  try {
    await dispatchMouse(point, "mouseMoved", { buttons: 0 });
  } catch (error) {
    if (!isInputDispatchTimeout(error)) throw error;
    dispatchError = error;
  }
  const completed = await finishHoverProbe(
    point,
    probeId,
    Boolean(dispatchError)
  );
  if (dispatchError && !completed) throw dispatchError;
}
async function dragMouse(points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error("dragMouse requires at least two points");
  }
  const resolved = [];
  for (const point of points) {
    resolved.push(await resolveMouseTarget(point));
  }
  const button = options.button || "left";
  const buttons = pressedButtons(button);
  const first = resolved[0];
  const last = resolved.at(-1);
  maybeHighlight(first, options.label);
  const probeId = await installMouseUpProbe(last);
  let dispatchError = null;
  try {
    await dispatchMouse(first, "mousePressed", {
      button,
      buttons,
      clickCount: 1
    });
    await inputEventDelay();
    for (let i = 1; i < resolved.length; i += 1) {
      const point = resolved[i];
      await dispatchMouse(
        { ...point, sessionId: point.sessionId ?? first.sessionId },
        "mouseMoved",
        {
          button,
          buttons
        }
      );
      await inputEventDelay(options.delayMs > 0 ? options.delayMs : void 0);
    }
    await dispatchMouse(
      { ...last, sessionId: last.sessionId ?? first.sessionId },
      "mouseReleased",
      {
        button,
        buttons: 0,
        clickCount: 1
      }
    );
  } catch (error) {
    if (!isInputDispatchTimeout(error)) throw error;
    dispatchError = error;
  }
  const completed = await finishDragProbe(
    resolved,
    probeId,
    button,
    Boolean(dispatchError)
  );
  if (dispatchError && !completed) throw dispatchError;
}
function inputEventDelay(ms = INPUT_EVENT_DELAY_MS) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function resolveClickTarget(target) {
  if (typeof target === "string" && canProbeInputFallback()) {
    const point2 = await resolveRawSelectorClickTarget(target);
    if (point2) return point2;
  }
  const point = await resolveElementClickPoint(target);
  return { ...point, probeId: await installClickProbe(point) };
}
async function resolveElementClickPoint(target) {
  const point = await resolveMouseTarget(target);
  const selector = typeof target === "string" ? target : target && typeof target === "object" && "selector" in target ? target.selector : "";
  if (!selector || await pointInViewport(point)) return point;
  const offset = typeof target === "object" && "selector" in target && (target.x !== void 0 || target.y !== void 0) ? { x: numberValue(target.x), y: numberValue(target.y) } : null;
  const { result, sessionId } = await resolveAndCall(
    selector,
    `function(offset){${CLICK_POINT_HELPERS}
      return clickPointForElement(this, offset);
    }`,
    [offset]
  );
  const value = result.result?.value;
  if (value?.error) throw clickPointError(selector, value.error);
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    throw clickPointError(selector, "element position is unavailable");
  }
  return { x: value.x, y: value.y, sessionId };
}
async function pointInViewport(point) {
  const { x, y } = point;
  const result = await cdp(
    "Runtime.evaluate",
    {
      expression: `${x} >= 0 && ${y} >= 0 && ${x} < innerWidth && ${y} < innerHeight`,
      returnByValue: true,
      awaitPromise: false
    },
    point.sessionId
  );
  return result.result?.value !== false;
}
function clickPointError(selector, reason) {
  return new ElementResolutionError(
    `click failed: ${reason}: ${selector}`,
    "transient"
  );
}
async function resolveRawSelectorClickTarget(selector) {
  if (!isRawSelector(selector)) return null;
  const id = newProbeId("click");
  const expression = `(() => {
    ${CLICK_POINT_HELPERS}
    const element = ${buildFindElementJs(selector)};
    if (!element) return null;
    const point = clickPointForElement(element, null);
    if (point.error) return point;
    ${clickProbeInstallJs(id, "point")}
    return { x: point.x, y: point.y };
  })()`;
  const result = await cdp("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false
  });
  if (result.exceptionDetails) return null;
  const value = result.result?.value;
  if (value?.error) throw clickPointError(selector, value.error);
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    return null;
  }
  return { x: value.x, y: value.y, sessionId: void 0, probeId: id };
}
function newProbeId(kind) {
  return `${kind}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}
function clickProbeInstallJs(id, pointExpression) {
  return `
    const probePoint = ${pointExpression};
    window.__egoBrowserInputProbes ||= {};
    const probe = { seen: false, target: document.elementFromPoint(probePoint.x, probePoint.y) };
    probe.dispose = () => {
      document.removeEventListener("click", probe.handler, true);
      clearTimeout(probe.timer);
    };
    probe.handler = (event) => {
      if (
        event.isTrusted && probe.target &&
        (event.target === probe.target || probe.target.contains(event.target))
      ) {
        probe.seen = true;
        probe.dispose();
      }
    };
    probe.timer = setTimeout(() => {
      probe.dispose();
      delete window.__egoBrowserInputProbes[${JSON.stringify(id)}];
    }, ${JSON.stringify(CLICK_PROBE_TTL_MS)});
    document.addEventListener("click", probe.handler, true);
    window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
  `;
}
async function installClickProbe(point) {
  if (!canProbeInputFallback()) return null;
  const id = newProbeId("click");
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        ${clickProbeInstallJs(id, JSON.stringify({ x: point.x, y: point.y }))}
        return Boolean(probe.target);
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      point.sessionId
    );
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}
async function finishClickProbe(point, id, clickCount) {
  if (!id) return false;
  await inputEventDelay(50);
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        probe.dispose();
        delete probes[${JSON.stringify(id)}];
        if (probe.seen || !probe.target) return { seen: probe.seen, fallback: false };
        const target = probe.target;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: ${JSON.stringify(point.x)},
          clientY: ${JSON.stringify(point.y)},
          button: 0,
        };
        target.dispatchEvent(new MouseEvent("mousemove", { ...init, buttons: 0, detail: 0 }));
        target.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1, detail: ${JSON.stringify(clickCount)} }));
        target.dispatchEvent(new MouseEvent("mouseup", { ...init, buttons: 0, detail: ${JSON.stringify(clickCount)} }));
        target.dispatchEvent(new MouseEvent("click", { ...init, buttons: 0, detail: ${JSON.stringify(clickCount)} }));
        if (${JSON.stringify(clickCount)} > 1) {
          target.dispatchEvent(new MouseEvent("dblclick", { ...init, buttons: 0, detail: 2 }));
        }
        return { seen: false, fallback: true };
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      point.sessionId
    );
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    return false;
  }
}
async function installMouseUpProbe(point) {
  if (!canProbeInputFallback()) return null;
  const id = `drag_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("mouseup", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      point.sessionId
    );
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}
async function installHoverProbe(point) {
  if (!canProbeInputFallback()) return null;
  const id = `hover_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const target = document.elementFromPoint(${JSON.stringify(point.x)}, ${JSON.stringify(point.y)});
        window.__egoBrowserInputProbes ||= {};
        const probe = { seen: false, target };
        probe.handler = (event) => {
          if (event.isTrusted && target && (event.target === target || target.contains(event.target))) {
            probe.seen = true;
          }
        };
        document.addEventListener("mousemove", probe.handler, true);
        document.addEventListener("mouseover", probe.handler, true);
        window.__egoBrowserInputProbes[${JSON.stringify(id)}] = probe;
        return Boolean(target);
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      point.sessionId
    );
    return result.result?.value ? id : null;
  } catch {
    return null;
  }
}
async function finishHoverProbe(point, id, settle) {
  if (!id) return false;
  if (settle) await inputEventDelay(50);
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("mousemove", probe.handler, true);
        document.removeEventListener("mouseover", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen || !probe.target) return { seen: probe.seen, fallback: false };
        const target = probe.target;
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: ${JSON.stringify(point.x)},
          clientY: ${JSON.stringify(point.y)},
          button: 0,
          buttons: 0,
        };
        target.dispatchEvent(new MouseEvent("mousemove", init));
        target.dispatchEvent(new MouseEvent("mouseover", init));
        return { seen: false, fallback: true };
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      point.sessionId
    );
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    return false;
  }
}
async function finishDragProbe(points, id, button, settle) {
  if (!id) return false;
  if (settle) await inputEventDelay(50);
  const first = points[0];
  const last = points.at(-1);
  try {
    const result = await cdp(
      "Runtime.evaluate",
      {
        expression: `(() => {
        const probes = window.__egoBrowserInputProbes || {};
        const probe = probes[${JSON.stringify(id)}];
        if (!probe) return { seen: false, fallback: false };
        document.removeEventListener("mouseup", probe.handler, true);
        delete probes[${JSON.stringify(id)}];
        if (probe.seen) return { seen: true, fallback: false };
        const mouseButton = ${JSON.stringify(button === "left" ? 0 : button === "middle" ? 1 : 2)};
        const eventFor = (type, point, buttons) => {
          const target = document.elementFromPoint(point.x, point.y) || document.body;
          target.dispatchEvent(new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: point.x,
            clientY: point.y,
            button: mouseButton,
            buttons,
            detail: type === "mousemove" ? 0 : 1,
          }));
        };
        const points = ${JSON.stringify(points.map(({ x, y }) => ({ x, y })))};
        eventFor("mousedown", points[0], 1);
        for (const point of points.slice(1)) eventFor("mousemove", point, 1);
        eventFor("mouseup", points.at(-1), 0);
        return { seen: false, fallback: true };
      })()`,
        returnByValue: true,
        awaitPromise: false
      },
      last.sessionId ?? first.sessionId
    );
    const value = result.result?.value;
    return Boolean(value?.seen || value?.fallback);
  } catch {
    return false;
  }
}
function canProbeInputFallback() {
  return Boolean(globalThis.ego?.sendCDPMessage);
}
async function scroll(x = 0, y = 0, options = {}) {
  if (x && typeof x === "object" && !Array.isArray(x)) {
    options = x;
    y = options.y ?? 0;
    x = options.x ?? 0;
  } else if (y && typeof y === "object" && !Array.isArray(y)) {
    options = y;
    y = 0;
  }
  const params = {
    type: "mouseWheel",
    x: Number(x) || 0,
    y: Number(y) || 0,
    deltaX: options.dx ?? 0,
    deltaY: options.dy ?? 300
  };
  try {
    await browserCdp("Input.dispatchMouseEvent", params);
  } catch (error) {
    if (!isWheelDispatchUnsupported(error)) {
      throw error;
    }
    if (!hasWarnedAboutWheelFallback) {
      hasWarnedAboutWheelFallback = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `[ego-browser] scroll(): wheel dispatch unsupported on this target (${message}); falling back to DOM scrollBy(). Wheel-only behaviors (virtualized lists, inner scroll panes) may not trigger.
`
      );
    }
    return scrollBy({ dx: params.deltaX, dy: params.deltaY });
  }
}
let hasWarnedAboutWheelFallback = false;
function isWheelDispatchUnsupported(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /not (?:supported|implemented)|wasn't found|isn't found|unknown (?:method|command)|method not found/i.test(
    message
  );
}
async function scrollBy(amount = 900, options = {}) {
  const params = scrollByParams(amount, options);
  return js(`(() => {
    window.scrollBy({
      left: ${JSON.stringify(params.left)},
      top: ${JSON.stringify(params.top)},
      behavior: ${JSON.stringify(params.behavior)}
    });
    return { x: window.scrollX, y: window.scrollY };
  })()`);
}
async function scrollToBottomUntil(condition = null, options = {}) {
  const step = numberValue(options.step ?? options.dy ?? 900);
  const maxSteps = Math.max(0, Math.floor(numberValue(options.maxSteps ?? 30)));
  const stallLimit = Math.max(
    1,
    Math.floor(numberValue(options.stallLimit ?? 2))
  );
  const waitSeconds = numberValue(options.waitSeconds ?? options.wait ?? 0.5);
  let previousY = -1;
  let stalls = 0;
  let state = await scrollState();
  for (let steps = 0; steps <= maxSteps; steps += 1) {
    if (await conditionMet(condition, state)) {
      return { done: true, reason: "condition", steps, state };
    }
    if (state.atBottom) {
      return { done: false, reason: "bottom", steps, state };
    }
    if (steps === maxSteps) {
      return { done: false, reason: "maxSteps", steps, state };
    }
    await scrollBy(step);
    if (waitSeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1e3));
    }
    state = await scrollState();
    stalls = state.y === previousY ? stalls + 1 : 0;
    previousY = state.y;
    if (stalls >= stallLimit) {
      return { done: false, reason: "stalled", steps: steps + 1, state };
    }
  }
  return { done: false, reason: "maxSteps", steps: maxSteps, state };
}
function maybeHighlight(point, label) {
  const ego = globalThis.ego;
  if (!ego) return;
  ego.animationHighlightMouseToPosition?.(point.x, point.y);
  if (label) {
    ego.setAgentTaskState?.(label);
  }
}
async function dispatchMouse(point, type, options = {}) {
  await browserCdp(
    "Input.dispatchMouseEvent",
    {
      type,
      x: point.x,
      y: point.y,
      ...options
    },
    point.sessionId,
    INPUT_DISPATCH_TIMEOUT_MS
  );
}
function isInputDispatchTimeout(error) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /CDP request timed out: Input\.dispatchMouseEvent/.test(message);
}
async function resolveMouseTarget(target) {
  if (typeof target === "string") {
    return elementCenter(target);
  }
  if (Array.isArray(target)) {
    return pointFrom(target);
  }
  if (target && typeof target === "object") {
    if ("selector" in target && typeof target.selector === "string" && target.selector) {
      if (target.x === void 0 && target.y === void 0) {
        return elementCenter(target.selector);
      }
      const [topLeft, center] = await Promise.all([
        elementTopLeft(target.selector),
        elementCenter(target.selector)
      ]);
      return {
        x: topLeft.x + numberValue(target.x),
        y: topLeft.y + numberValue(target.y),
        sessionId: center.sessionId
      };
    }
    if (target.x !== void 0 || target.y !== void 0) {
      return pointFrom(target);
    }
  }
  throw new Error(`invalid mouse target: ${JSON.stringify(target)}`);
}
async function elementTopLeft(selectorOrRef) {
  const { result } = await resolveAndCall(
    selectorOrRef,
    "function(){const rect=this.getBoundingClientRect();return {x:rect.left,y:rect.top};}"
  );
  const value = result.result?.value;
  if (typeof value?.x !== "number" || typeof value?.y !== "number") {
    throw new Error(`element top-left unavailable: ${selectorOrRef}`);
  }
  return { x: value.x, y: value.y };
}
function pointFrom(point) {
  const x = Array.isArray(point) ? point[0] : point?.x;
  const y = Array.isArray(point) ? point[1] : point?.y;
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
    throw new Error(`invalid mouse target: ${JSON.stringify(point)}`);
  }
  return { x: Number(x), y: Number(y), sessionId: void 0 };
}
function numberValue(value) {
  const out = value === void 0 ? 0 : Number(value);
  if (!Number.isFinite(out)) {
    throw new Error(`invalid mouse offset: ${JSON.stringify(value)}`);
  }
  return out;
}
function scrollByParams(amount, options) {
  const input = amount && typeof amount === "object" && !Array.isArray(amount) ? amount : options;
  const top = amount && typeof amount === "object" && !Array.isArray(amount) ? input.top ?? input.dy ?? 900 : input.top ?? input.dy ?? amount;
  return {
    left: numberValue(input.left ?? input.dx ?? 0),
    top: numberValue(top),
    behavior: input.behavior === "smooth" ? "smooth" : "instant"
  };
}
async function scrollState() {
  return js(`(() => {
    const doc = document.documentElement;
    const body = document.body;
    const height = Math.max(
      doc?.scrollHeight || 0,
      body?.scrollHeight || 0,
      doc?.offsetHeight || 0,
      body?.offsetHeight || 0
    );
    const viewportHeight = window.innerHeight || doc?.clientHeight || 0;
    const y = window.scrollY || window.pageYOffset || 0;
    return {
      x: window.scrollX || window.pageXOffset || 0,
      y,
      viewportHeight,
      scrollHeight: height,
      atBottom: y + viewportHeight >= height - 2
    };
  })()`);
}
async function conditionMet(condition, state) {
  if (!condition) {
    return false;
  }
  if (typeof condition === "function") {
    return Boolean(await condition(state));
  }
  if (typeof condition === "string") {
    return Boolean(await js(`Boolean(${condition})`));
  }
  throw new TypeError(
    `scrollToBottomUntil condition must be a function or string, got ${typeof condition}`
  );
}
function pressedButtons(button) {
  if (button === "left") {
    return 1;
  }
  if (button === "right") {
    return 2;
  }
  if (button === "middle") {
    return 4;
  }
  throw new Error(`unsupported mouse button: ${button}`);
}
export {
  click,
  doubleClick,
  dragMouse,
  hover,
  scroll,
  scrollBy,
  scrollToBottomUntil
};
