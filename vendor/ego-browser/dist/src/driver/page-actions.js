import { runtimeValue } from "../cdp-eval.js";
import {
  ElementResolutionError,
  resolveElementObjectId
} from "../element-resolver.js";
import {
  ACTION_TARGET_STATE_HELPERS,
  EDIT_ACTION_TARGET_HELPERS,
  ENABLED_SCROLL_TARGET_HELPERS,
  HIT_TARGET_HELPERS,
  SCROLL_TARGET_HELPERS
} from "./action-target.js";
import { dispatchWheelMotion } from "./scroll-motion.js";
async function selectOptionInPage(services, sessionId, refMap, selector, choices, iframeSessions = /* @__PURE__ */ new Map()) {
  assertPageSelector(selector);
  const resolved = await resolveElementObjectId(
    cdpAdapter(services),
    sessionId,
    refMap,
    selector,
    iframeSessions,
    { strict: true, actionability: "enabled" }
  );
  const source = `function selectOptionsForAction(choices) {
    ${EDIT_ACTION_TARGET_HELPERS}
    let select = String(this.tagName || "").toUpperCase() === "SELECT"
      ? this
      : null;
    if (!select && this.control?.tagName === "SELECT") select = this.control;
    if (!select) {
      const candidates = composedDescendantMatches(
        this,
        (element) => String(element.tagName || "").toUpperCase() === "SELECT",
        true,
      );
      if (candidates.length > 1) {
        return { error: "element contains multiple select controls" };
      }
      select = candidates[0] || null;
    }
    if (!select) return { error: "element is not a select control" };
    if (!select.isConnected) return { error: "element is not connected" };
    const view = select.ownerDocument.defaultView;
    const rect = select.getBoundingClientRect();
    const style = view?.getComputedStyle(select);
    if (
      !view || rect.width <= 0 || rect.height <= 0 ||
      style?.display === "none" || style?.visibility === "hidden"
    ) return { error: "element is not visible" };
    if (isActionTargetDisabled(select)) return { error: "element is disabled" };
    const options = Array.from(select.options);
    const selected = [];
    const selectedOptions = [];
    let remaining = choices.slice();
    const matches = (choice, candidate, index) =>
      typeof choice === "string"
        ? candidate.value === choice || candidate.label === choice
        : (choice.value === undefined || candidate.value === choice.value) &&
          (choice.label === undefined || candidate.label === choice.label) &&
          (choice.index === undefined || index === choice.index);
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      const matchingChoice = remaining.find((choice) =>
        matches(choice, option, index)
      );
      if (matchingChoice === undefined) continue;
      selectedOptions.push(option);
      if (!select.multiple) {
        remaining = [];
        break;
      }
      remaining = remaining.filter(
        (choice) => !matches(choice, option, index),
      );
    }
    if (remaining.length > 0) {
      const available = options
        .map((candidate, index) =>
          index + ': value=' + JSON.stringify(candidate.value) +
          ', label=' + JSON.stringify(candidate.label),
        )
        .join('; ');
      return {
        error:
          'option ' + JSON.stringify(remaining[0]) +
          ' was not found; available options: ' + (available || '(none)'),
      };
    }
    for (const option of options) option.selected = false;
    for (const option of selectedOptions) option.selected = true;
    for (const option of select.selectedOptions) selected.push(option.value);
    select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected };
  }`;
  try {
    const response = await services.cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: source,
        objectId: resolved.objectId,
        arguments: [{ value: choices }],
        returnByValue: true,
        awaitPromise: false
      },
      resolved.sessionId
    );
    const result = runtimeValue(response, source);
    if (typeof result?.error === "string") {
      const transient = /* @__PURE__ */ new Set([
        "element is not connected",
        "element is not visible",
        "element is disabled"
      ]);
      throw transient.has(result.error) || result.error.includes(" was not found;") ? new ElementResolutionError(
        `page.selectOption failed: ${result.error}`,
        "transient"
      ) : new Error(`page.selectOption failed: ${result.error}`);
    }
    if (!Array.isArray(result?.selected)) {
      throw new Error("page.selectOption received an invalid selection result");
    }
    return result.selected;
  } finally {
    await releaseObject(services, resolved.sessionId, resolved.objectId);
  }
}
const INPUT_EVENT_DELAY_MS = 25;
const FILL_VERIFICATION_ATTEMPTS = 5;
const FILL_VERIFICATION_INTERVAL_MS = 50;
const AUTO_SCROLL_ATTEMPTS = 6;
async function clickInPage(services, sessionId, refMap, selector, options = {}, modifiers = 0, iframeSessions = /* @__PURE__ */ new Map()) {
  assertPageSelector(selector);
  const button = options.button ?? "left";
  const clickCount = options.clickCount ?? 1;
  const target = await resolveElementObjectId(
    cdpAdapter(services),
    sessionId,
    refMap,
    selector,
    iframeSessions,
    {
      strict: true,
      actionability: options.force ? "enabled" : "pointer-enabled"
    }
  );
  try {
    let point = await resolveElementPoint(
      services,
      target.sessionId,
      target.objectId,
      {
        position: options.position,
        frameId: target.frameId,
        actionName: "page.click",
        hitTest: !options.force,
        requireEnabled: true,
        stability: "recompute",
        pageSessionId: sessionId,
        iframeSessions
      }
    );
    const cursorPoint = await cursorPointForElement(
      services,
      sessionId,
      target.sessionId,
      target.frameId,
      point,
      point.local,
      iframeSessions
    );
    const buttons = pressedButtons(button);
    showAgentActionLabel(services, options.label ?? "Clicking element");
    await dispatchMouseEvent(
      services,
      target.sessionId,
      {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
        buttons: 0,
        modifiers
      },
      cursorPoint
    );
    if (target.frameId && target.sessionId === sessionId) {
      const pagePoint = await pagePointForFrame(
        services,
        target.sessionId,
        target.frameId,
        point.local,
        sessionId
      );
      point = { ...pagePoint, local: point.local };
      await assertClickTargetActionable(
        services,
        target.sessionId,
        target.objectId,
        point.local,
        { hitTest: !options.force }
      );
      await dispatchMouseEvent(services, target.sessionId, {
        type: "mouseMoved",
        x: point.x,
        y: point.y,
        button: "none",
        buttons: 0,
        modifiers
      });
    }
    for (let count = 1; count <= clickCount; count += 1) {
      if (!target.frameId || count > 1) {
        await assertClickTargetActionable(
          services,
          target.sessionId,
          target.objectId,
          point.local,
          { hitTest: !options.force && !target.frameId }
        );
      }
      await dispatchMouseEvent(services, target.sessionId, {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button,
        buttons,
        modifiers,
        clickCount: count
      });
      if (options.delay) await services.sleep(options.delay);
      await dispatchMouseEvent(services, target.sessionId, {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button,
        buttons: 0,
        modifiers,
        clickCount: count
      });
      if (options.delay && count < clickCount) {
        await services.sleep(options.delay);
      }
    }
  } finally {
    await releaseObject(services, target.sessionId, target.objectId);
  }
}
async function fillInPage(services, sessionId, refMap, selector, value, options = {}, iframeSessions = /* @__PURE__ */ new Map()) {
  assertPageSelector(selector);
  if (typeof value !== "string") {
    throw new TypeError("page.fill value must be a string");
  }
  const clearFirst = options.clearFirst ?? true;
  const resolved = await resolveElementObjectId(
    cdpAdapter(services),
    sessionId,
    refMap,
    selector,
    iframeSessions,
    { strict: true, actionability: "enabled" }
  );
  let actionObjectId;
  try {
    actionObjectId = await resolveFillActionTarget(
      services,
      resolved.sessionId,
      resolved.objectId
    );
    await scrollElementIntoView(
      services,
      resolved.sessionId,
      actionObjectId,
      resolved.frameId,
      "page.fill",
      sessionId,
      iframeSessions
    );
    const preparationSource = `function fillPreparation(value, clearFirst) {
      ${ACTION_TARGET_STATE_HELPERS}
      if (!this.isConnected) return { error: "element is not connected" };
      const visibleCursorPoint = () => {
        const rect = this.getBoundingClientRect();
        const view = this.ownerDocument.defaultView;
        if (!view || rect.width <= 0 || rect.height <= 0) return null;
        const left = Math.max(0, rect.left);
        const top = Math.max(0, rect.top);
        const right = Math.min(view.innerWidth, rect.right);
        const bottom = Math.min(view.innerHeight, rect.bottom);
        if (right <= left || bottom <= top) return null;
        return { x: (left + right) / 2, y: (top + bottom) / 2 };
      };
      const tag = this.nodeName.toLowerCase();
      const observed = tag === "input" || tag === "textarea"
        ? this.value
        : (this.innerText ?? this.textContent ?? "");
      const view = this.ownerDocument.defaultView;
      const rect = this.getBoundingClientRect();
      const style = view?.getComputedStyle(this);
      if (
        !view || rect.width <= 0 || rect.height <= 0 ||
        style?.visibility === "hidden" || style?.display === "none"
      ) return { error: "element is not visible" };
      if (isActionTargetDisabled(this)) return { error: "element is disabled" };
      if (this.readOnly) return { error: "element is read only" };

      if (tag === "input") {
        const type = this.type.toLowerCase();
        const textTypes = new Set(["", "email", "number", "password", "search", "tel", "text", "url"]);
        const directTypes = new Set(["color", "date", "time", "datetime-local", "month", "range", "week"]);
        if (!textTypes.has(type) && !directTypes.has(type)) {
          return { error: 'input type "' + type + '" cannot be filled' };
        }
        if (type === "number" && value.trim() !== "" && Number.isNaN(Number(value.trim()))) {
          return { error: "cannot type non-numeric text into input[type=number]" };
        }
        if (directTypes.has(type)) {
          const nextValue = value.trim();
          this.focus({ preventScroll: true });
          if (isActionTargetDisabled(this)) return { error: "element is disabled" };
          this.value = nextValue;
          if (this.value !== nextValue) return { error: "malformed value" };
          this.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          return { status: "done", kind: "input", cursorPoint: visibleCursorPoint() };
        }
      } else if (tag !== "textarea" && !this.isContentEditable) {
        return { error: "element is not an input, textarea, or contenteditable element" };
      }

      this.focus({ preventScroll: true });
      if (isActionTargetDisabled(this)) return { error: "element is disabled" };
      const cursorPoint = visibleCursorPoint();
      const kind = this.isContentEditable ? "contenteditable" : tag;
      const details = {
        status: "needsinput",
        kind,
        cursorPoint,
        before: String(observed)
      };
      if (!clearFirst) return details;
      if (tag === "input" || tag === "textarea") {
        this.select();
      } else {
        const range = this.ownerDocument.createRange();
        range.selectNodeContents(this);
        const selection = this.ownerDocument.defaultView.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      return details;
    }`;
    const prepare = async () => {
      const preparation = await services.cdp(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: preparationSource,
          objectId: actionObjectId,
          arguments: [{ value }, { value: clearFirst }],
          returnByValue: true,
          awaitPromise: false
        },
        resolved.sessionId
      );
      return runtimeValue(preparation, preparationSource);
    };
    let result = await prepare();
    if (typeof result?.error === "string") {
      throw fillPreparationError(result.error);
    }
    showAgentCursor(
      services,
      await pagePointForFrame(
        services,
        resolved.sessionId,
        resolved.frameId,
        result?.cursorPoint,
        sessionId
      )
    );
    const status = typeof result === "string" ? result : result?.status;
    if (status === "done") return;
    if (status !== "needsinput") {
      throw new Error("page.fill received an invalid preparation result");
    }
    await assertElementEnabled(
      services,
      resolved.sessionId,
      actionObjectId,
      "page.fill"
    );
    await dispatchFillInput(services, resolved.sessionId, value, clearFirst);
    let outcome = await verifyFillOutcome(
      services,
      resolved.sessionId,
      actionObjectId,
      String(result?.before ?? ""),
      value,
      clearFirst
    );
    if (fillOutcomeAccepted(outcome)) {
      return;
    }
    if (result?.kind === "contenteditable" || result?.kind === "input" || result?.kind === "textarea") {
      await clickResolvedElement(
        services,
        resolved.sessionId,
        actionObjectId,
        resolved.frameId,
        sessionId,
        iframeSessions
      );
      result = await prepare();
      if (typeof result?.error === "string") {
        throw fillPreparationError(result.error);
      }
      if (result?.status !== "needsinput") {
        throw new Error("page.fill received an invalid preparation result");
      }
      await assertElementEnabled(
        services,
        resolved.sessionId,
        actionObjectId,
        "page.fill"
      );
      await dispatchFillInput(services, resolved.sessionId, value, clearFirst);
      outcome = await verifyFillOutcome(
        services,
        resolved.sessionId,
        actionObjectId,
        String(result?.before ?? ""),
        value,
        clearFirst
      );
      if (fillOutcomeAccepted(outcome)) {
        return;
      }
    }
    const target = result?.kind === "contenteditable" ? "editor" : "field";
    throw new Error(
      `page.fill did not accept the text. Click the ${target} and use page.keyboard, then verify the result.`
    );
  } finally {
    if (actionObjectId && actionObjectId !== resolved.objectId) {
      await releaseObject(services, resolved.sessionId, actionObjectId);
    }
    await releaseObject(services, resolved.sessionId, resolved.objectId);
  }
}
async function resolveFillActionTarget(services, sessionId, objectId) {
  const source = `function resolveFillTargetForAction() {
    ${EDIT_ACTION_TARGET_HELPERS}
    const tag = String(this.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || isExplicitContentEditable(this)) {
      return this;
    }
    const editingHost = nearestComposedAncestor(this, isExplicitContentEditable);
    if (editingHost) return editingHost;
    const candidates = composedDescendantMatches(
      this,
      isFillableActionTarget,
      true,
    );
    if (candidates.length > 1) {
      throw new TypeError("page.fill selected an element with multiple fillable targets");
    }
    return candidates[0] || this;
  }`;
  const response = await services.cdp(
    "Runtime.callFunctionOn",
    {
      functionDeclaration: source,
      objectId,
      returnByValue: false,
      awaitPromise: false
    },
    sessionId
  );
  if (response?.exceptionDetails) {
    throw new ElementResolutionError(
      exceptionDescription(response),
      "permanent"
    );
  }
  const targetObjectId = response?.result?.objectId;
  if (!targetObjectId) {
    throw new Error("page.fill could not resolve an editable action target");
  }
  return targetObjectId;
}
async function focusInPage(services, sessionId, refMap, selector, iframeSessions = /* @__PURE__ */ new Map()) {
  assertPageSelector(selector);
  const resolved = await resolveElementObjectId(
    cdpAdapter(services),
    sessionId,
    refMap,
    selector,
    iframeSessions,
    { strict: true, actionability: "enabled" }
  );
  const source = `function focusElementForAction() {
    if (!this.isConnected) return { error: "element is not connected" };
    ${EDIT_ACTION_TARGET_HELPERS}
    const deepActiveElement = () => {
      let active = this.ownerDocument.activeElement;
      while (active?.shadowRoot?.activeElement) {
        active = active.shadowRoot.activeElement;
      }
      return active;
    };
    const containsComposed = (container, element) => {
      let current = element;
      while (current) {
        if (current === container) return true;
        current = composedParent(current);
      }
      return false;
    };
    const details = () => ({
      tagName: this.tagName,
      contentEditable: Boolean(this.isContentEditable),
      tabIndex: this.tabIndex,
      activeTagName: deepActiveElement()?.tagName || null,
    });
    const tryFocus = (candidate, retargeted) => {
      if (typeof candidate.focus !== "function") return null;
      candidate.focus();
      const active = deepActiveElement();
      return active === candidate || containsComposed(candidate, active)
        ? { focused: true, retargeted }
        : null;
    };

    const direct = tryFocus(this, null);
    if (direct) return direct;

    let ancestor = composedParent(this);
    while (ancestor) {
      if (isStrongFocusTarget(ancestor)) {
        const focused = tryFocus(ancestor, "ancestor");
        if (focused) return focused;
      }
      ancestor = composedParent(ancestor);
    }

    const editableCandidates = composedDescendantMatches(
      this,
      isEditableFocusTarget,
      true,
    );
    if (editableCandidates.length === 1) {
      const focused = tryFocus(editableCandidates[0], "descendant");
      if (focused) return focused;
    }
    if (editableCandidates.length > 1) {
      return {
        error: "element contains multiple editable targets",
        details: { ...details(), candidateCount: editableCandidates.length },
      };
    }
    return { error: "element is not focusable", details: details() };
  }`;
  try {
    const response = await services.cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: source,
        objectId: resolved.objectId,
        returnByValue: true,
        awaitPromise: false
      },
      resolved.sessionId
    );
    const result = runtimeValue(response, source);
    if (typeof result?.error === "string") {
      const details = result.details;
      const candidateCount = details?.candidateCount ? `, candidates=${String(details.candidateCount)}` : "";
      const description = details ? ` (${String(details.tagName || "element").toLowerCase()}, contenteditable=${Boolean(details.contentEditable)}, tabIndex=${String(details.tabIndex)}, active=${String(details.activeTagName || "none").toLowerCase()}${candidateCount})` : "";
      throw new ElementResolutionError(
        `page.focus failed: ${result.error}${description}`,
        result.error === "element is not connected" ? "transient" : "permanent"
      );
    }
  } finally {
    await releaseObject(services, resolved.sessionId, resolved.objectId);
  }
}
async function dispatchFillInput(services, sessionId, value, clearFirst) {
  if (clearFirst && value.length === 0) {
    const keyDown = {
      type: "rawKeyDown",
      key: "Delete",
      code: "Delete",
      modifiers: 0,
      windowsVirtualKeyCode: 46
    };
    if ((services.platform ?? process.platform) === "darwin") {
      keyDown.commands = ["deleteForward"];
    }
    await services.cdp("Input.dispatchKeyEvent", keyDown, sessionId);
    await services.cdp(
      "Input.dispatchKeyEvent",
      {
        type: "keyUp",
        key: "Delete",
        code: "Delete",
        modifiers: 0,
        windowsVirtualKeyCode: 46
      },
      sessionId
    );
    return;
  }
  if (value.length > 0) {
    await services.cdp("Input.insertText", { text: value }, sessionId);
  }
}
async function verifyFillOutcome(services, sessionId, objectId, before, value, clearFirst) {
  const source = `function readFilledValue() {
    if (!this.isConnected) return { error: "element is not connected" };
    const tag = this.nodeName.toLowerCase();
    const observed = tag === "input" || tag === "textarea"
      ? this.value
      : (this.innerText ?? this.textContent ?? "");
    return {
      actual: String(observed),
      type: tag === "input" ? this.type.toLowerCase() : ""
    };
  }`;
  let prior;
  let consecutiveReads = 0;
  let lastOutcome = "unchanged";
  for (let attempt = 0; attempt < FILL_VERIFICATION_ATTEMPTS; attempt += 1) {
    const response = await services.cdp(
      "Runtime.callFunctionOn",
      {
        functionDeclaration: source,
        objectId,
        returnByValue: true,
        awaitPromise: false
      },
      sessionId
    );
    const result = runtimeValue(response, source);
    if (typeof result?.error === "string") {
      throw new Error(`page.fill could not verify the result: ${result.error}`);
    }
    const outcome = classifyFillOutcome(
      before,
      value,
      String(result?.actual ?? ""),
      clearFirst,
      String(result?.type ?? "")
    );
    lastOutcome = outcome;
    if (fillOutcomeAccepted(outcome)) return outcome;
    const reading = `${outcome}\0${String(result?.actual ?? "")}`;
    if (reading === prior) {
      consecutiveReads += 1;
      if (consecutiveReads === 2) return outcome;
    } else {
      prior = reading;
      consecutiveReads = 1;
    }
    if (attempt + 1 < FILL_VERIFICATION_ATTEMPTS) {
      await services.sleep(FILL_VERIFICATION_INTERVAL_MS);
    }
  }
  return lastOutcome;
}
function fillOutcomeAccepted(outcome) {
  return outcome === "exact" || outcome === "equivalent" || outcome === "transformed";
}
function classifyFillOutcome(beforeValue, expectedValue, actualValue, clearFirst, inputType) {
  const normalize = (text) => String(text).replace(/\r\n?/g, "\n").replace(/\u200b/g, "");
  const before = normalize(beforeValue);
  const expected = normalize(expectedValue);
  const actual = normalize(actualValue);
  if (clearFirst ? actual === expected : actual.includes(expected)) {
    return "exact";
  }
  if (inputType === "number" && expected.trim() !== "" && actual.trim() !== "" && Number(actual) === Number(expected)) {
    return "equivalent";
  }
  const integerExpected = expected.normalize("NFKC").trim();
  if (/^\d+$/.test(integerExpected)) {
    const actualDigits = actual.normalize("NFKC").replace(/\D/g, "");
    if (actualDigits === integerExpected) return "equivalent";
    const beforeDigits = before.normalize("NFKC").replace(/\D/g, "");
    if (clearFirst && beforeDigits.length > 0 && actualDigits === beforeDigits + integerExpected) {
      return "appended";
    }
  }
  if (clearFirst && actual === before + expected && before.length > 0) {
    return "appended";
  }
  return actual === before ? "unchanged" : "transformed";
}
async function clickResolvedElement(services, sessionId, objectId, frameId, pageSessionId = sessionId, iframeSessions = /* @__PURE__ */ new Map()) {
  const point = await resolveElementPoint(services, sessionId, objectId, {
    frameId,
    actionName: "page.fill",
    hitTest: true,
    stability: "recompute",
    pageSessionId,
    iframeSessions
  });
  await assertElementReceivesPointerEvents(
    services,
    sessionId,
    objectId,
    point.local
  );
  await assertSafeFillActivationTarget(
    services,
    sessionId,
    objectId,
    point.local
  );
  await dispatchMouseEvent(services, sessionId, {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    button: "none",
    buttons: 0,
    modifiers: 0
  });
  await assertElementEnabled(services, sessionId, objectId, "page.fill");
  if (frameId) {
    await dispatchMouseEvent(services, sessionId, {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      modifiers: 0
    });
  }
  await dispatchMouseEvent(services, sessionId, {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    modifiers: 0,
    clickCount: 1
  });
  await dispatchMouseEvent(services, sessionId, {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    modifiers: 0,
    clickCount: 1
  });
}
async function assertSafeFillActivationTarget(services, sessionId, objectId, point) {
  const expression = `function safeFillActivationTarget(point) {
    ${HIT_TARGET_HELPERS}
    if (!this.isConnected) return { error: "the editor is not connected" };
    const hit = hitElementAtPoint(this, point);
    let current = hit;
    while (current && current !== this) {
      if (isExplicitInteractiveElement(current)) {
        return { error: describeHitTarget(current) };
      }
      current = composedParent(current);
    }
    return { safe: true };
  }`;
  const response = await services.cdp(
    "Runtime.callFunctionOn",
    {
      functionDeclaration: expression,
      objectId,
      arguments: [{ value: point }],
      returnByValue: true,
      awaitPromise: false
    },
    sessionId
  );
  const result = runtimeValue(response, expression);
  if (typeof result?.error === "string") {
    throw new ElementResolutionError(
      `page.fill cannot safely activate the editor because ${result.error} would receive the click`,
      "permanent"
    );
  }
}
async function hoverInPage(services, sessionId, refMap, selector, options = {}, modifiers = 0, iframeSessions = /* @__PURE__ */ new Map()) {
  assertPageSelector(selector);
  const resolved = await resolveElementObjectId(
    cdpAdapter(services),
    sessionId,
    refMap,
    selector,
    iframeSessions,
    {
      strict: true,
      actionability: options.force ? "visible" : "pointer"
    }
  );
  try {
    const point = await resolveElementPoint(
      services,
      resolved.sessionId,
      resolved.objectId,
      {
        position: options.position,
        frameId: resolved.frameId,
        actionName: "page.hover",
        hitTest: !options.force,
        stability: "strict",
        pageSessionId: sessionId,
        iframeSessions
      }
    );
    showAgentActionLabel(services, options.label);
    await dispatchMouseEvent(services, resolved.sessionId, {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      button: "none",
      buttons: 0,
      modifiers
    });
  } finally {
    await releaseObject(services, resolved.sessionId, resolved.objectId);
  }
}
async function dragAndDropInPage(services, sessionId, refMap, sourceSelector, targetSelector, options = {}, modifiers = 0, iframeSessions = /* @__PURE__ */ new Map()) {
  assertPageSelector(sourceSelector);
  assertPageSelector(targetSelector);
  const source = await resolveElementObjectId(
    cdpAdapter(services),
    sessionId,
    refMap,
    sourceSelector,
    iframeSessions,
    {
      strict: true,
      actionability: options.force ? "visible" : "pointer"
    }
  );
  let target;
  try {
    target = await resolveElementObjectId(
      cdpAdapter(services),
      sessionId,
      refMap,
      targetSelector,
      iframeSessions,
      {
        strict: true,
        actionability: options.force ? "visible" : "pointer"
      }
    );
    const sourcePoint = await resolveElementPoint(
      services,
      source.sessionId,
      source.objectId,
      {
        position: options.sourcePosition,
        frameId: source.frameId,
        actionName: "page.dragAndDrop",
        hitTest: !options.force,
        stability: "strict",
        pageSessionId: sessionId,
        iframeSessions
      }
    );
    const targetPoint = await resolveElementPoint(
      services,
      target.sessionId,
      target.objectId,
      {
        position: options.targetPosition,
        frameId: target.frameId,
        actionName: "page.dragAndDrop",
        hitTest: !options.force,
        stability: "strict",
        pageSessionId: sessionId,
        iframeSessions
      }
    );
    const button = options.button ?? "left";
    const buttons = pressedButtons(button);
    showAgentActionLabel(services, options.label);
    await dispatchMouseEvent(services, source.sessionId, {
      type: "mouseMoved",
      x: sourcePoint.x,
      y: sourcePoint.y,
      button: "none",
      buttons: 0,
      modifiers
    });
    await services.sleep(INPUT_EVENT_DELAY_MS);
    await dispatchMouseEvent(services, source.sessionId, {
      type: "mousePressed",
      x: sourcePoint.x,
      y: sourcePoint.y,
      button,
      buttons,
      modifiers,
      clickCount: 1
    });
    await services.sleep(INPUT_EVENT_DELAY_MS);
    await dispatchMouseEvent(services, source.sessionId, {
      type: "mouseMoved",
      x: targetPoint.x,
      y: targetPoint.y,
      button,
      buttons,
      modifiers
    });
    await services.sleep(INPUT_EVENT_DELAY_MS);
    await dispatchMouseEvent(services, source.sessionId, {
      type: "mouseReleased",
      x: targetPoint.x,
      y: targetPoint.y,
      button,
      buttons: 0,
      modifiers,
      clickCount: 1
    });
  } finally {
    if (target) {
      await releaseObject(services, target.sessionId, target.objectId);
    }
    await releaseObject(services, source.sessionId, source.objectId);
  }
}
async function clickPointInPage(services, sessionId, x, y, options = {}, modifiers = 0, baseButtons = 0) {
  assertPoint(x, y, "page.mouse.click");
  const button = options.button ?? "left";
  const clickCount = options.clickCount ?? 1;
  const buttons = pressedButtons(button);
  showAgentActionLabel(services, options.label);
  await dispatchMouseEvent(services, sessionId, {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons: baseButtons,
    modifiers
  });
  for (let count = 1; count <= clickCount; count += 1) {
    await dispatchMouseEvent(services, sessionId, {
      type: "mousePressed",
      x,
      y,
      button,
      buttons: baseButtons | buttons,
      modifiers,
      clickCount: count
    });
    if (options.delay) await services.sleep(options.delay);
    await dispatchMouseEvent(services, sessionId, {
      type: "mouseReleased",
      x,
      y,
      button,
      buttons: baseButtons,
      modifiers,
      clickCount: count
    });
    if (options.delay && count < clickCount) {
      await services.sleep(options.delay);
    }
  }
}
async function moveMouseInPage(services, sessionId, fromX, fromY, x, y, options) {
  assertPoint(x, y, "page.mouse.move");
  const steps = options.steps ?? 1;
  showAgentActionLabel(services, options.label);
  for (let step = 1; step <= steps; step += 1) {
    await dispatchMouseEvent(services, sessionId, {
      type: "mouseMoved",
      x: fromX + (x - fromX) * (step / steps),
      y: fromY + (y - fromY) * (step / steps),
      button: options.button,
      buttons: options.buttons,
      modifiers: options.modifiers
    });
  }
}
async function mouseButtonInPage(services, sessionId, type, x, y, buttons, options = {}, modifiers = 0) {
  assertPoint(x, y, `page.mouse.${type === "mousePressed" ? "down" : "up"}`);
  const button = options.button ?? "left";
  const clickCount = options.clickCount ?? 1;
  await dispatchMouseEvent(services, sessionId, {
    type,
    x,
    y,
    button,
    buttons,
    modifiers,
    clickCount
  });
  return button;
}
async function wheelInPage(services, sessionId, x, y, deltaX, deltaY, modifiers = 0, options = {}) {
  assertPoint(x, y, "page.mouse.wheel");
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
    throw new TypeError("page.mouse.wheel requires finite deltaX and deltaY");
  }
  showAgentActionLabel(services, options.label);
  await dispatchWheelMotion(
    {
      dispatch: (params) => dispatchMouseEvent(services, sessionId, params),
      sleep: services.sleep
    },
    {
      x,
      y,
      modifiers,
      deltaX,
      deltaY
    }
  );
}
async function scrollElementIntoView(services, sessionId, objectId, frameId, actionName, pageSessionId, iframeSessions) {
  await resolveElementPoint(services, sessionId, objectId, {
    frameId,
    actionName,
    hitTest: false,
    stability: "none",
    pageSessionId,
    iframeSessions
  });
}
async function resolveElementPoint(services, sessionId, objectId, options = {}) {
  const {
    position,
    frameId,
    actionName = "page.click",
    hitTest = true,
    requireEnabled = false,
    stability = "strict",
    pageSessionId = sessionId,
    iframeSessions = /* @__PURE__ */ new Map()
  } = options;
  if (position !== void 0 && (!position || typeof position !== "object" || !Number.isFinite(position.x) || !Number.isFinite(position.y))) {
    throw new TypeError(
      `${actionName} position requires finite x and y offsets`
    );
  }
  const pointExpression = position ? "({x:rect.x+position.x,y:rect.y+position.y})" : "actionPointForElement(this)";
  const settleExpression = stability === "none" ? "" : `await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 100);
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
    rect = this.getBoundingClientRect();`;
  const strictStabilityExpression = stability === "strict" ? `const firstRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    ${settleExpression}
    if (
      Math.abs(rect.x - firstRect.x) > 0.25 ||
      Math.abs(rect.y - firstRect.y) > 0.25 ||
      Math.abs(rect.width - firstRect.width) > 0.25 ||
      Math.abs(rect.height - firstRect.height) > 0.25
    ) {
      return { error: "element is not stable" };
    }` : settleExpression;
  const helpers = hitTest ? HIT_TARGET_HELPERS : requireEnabled ? ENABLED_SCROLL_TARGET_HELPERS : SCROLL_TARGET_HELPERS;
  const expression = `async function(${position ? "position" : ""}) {
    ${helpers}
    if (!this.isConnected) return { error: "element is not connected" };
    let rect = this.getBoundingClientRect();
    let point = ${pointExpression};
    if (rect.width <= 0 || rect.height <= 0 || !point) {
      return { error: "element is not visible" };
    }
    if (${requireEnabled ? "true" : "false"} && isActionTargetDisabled(this)) {
      return { error: "element is disabled" };
    }
    const scroll = scrollRequestForPoint(this, point);
    if (scroll) return { scroll };
    ${strictStabilityExpression}
    point = ${pointExpression};
    if (${hitTest ? "true" : "false"}) {
      const interceptor = interceptingElementAtPoint(this, point);
      if (interceptor) {
        return { error: describeHitTarget(interceptor) + " intercepts pointer events" };
      }
    }
    return point;
  }`;
  if (frameId) {
    await ensureFrameOwnerInView(
      services,
      pageSessionId,
      frameId,
      actionName,
      iframeSessions
    );
  }
  const point = await bringIntoView(services, sessionId, objectId, {
    actionName,
    subject: "element",
    evaluate: async () => {
      const response = await services.cdp(
        "Runtime.callFunctionOn",
        {
          functionDeclaration: expression,
          objectId,
          arguments: position ? [{ value: position }] : [],
          returnByValue: true,
          awaitPromise: true
        },
        sessionId
      );
      return runtimeValue(response, expression);
    },
    wheel: async (scroll) => {
      const pageScrollPoint = await pagePointForFrame(
        services,
        sessionId,
        frameId,
        scroll,
        pageSessionId
      );
      return dispatchWheelMotion(wheelMotionServices(services, sessionId), {
        x: pageScrollPoint.x,
        y: pageScrollPoint.y,
        deltaX: scroll.deltaX,
        deltaY: scroll.deltaY
      });
    }
  });
  if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    throw new Error(`${actionName} could not resolve the element position`);
  }
  const pagePoint = await pagePointForFrame(
    services,
    sessionId,
    frameId,
    point,
    pageSessionId
  );
  return { ...pagePoint, local: point };
}
function wheelMotionServices(services, sessionId) {
  return {
    dispatch: (params) => dispatchMouseEvent(services, sessionId, params),
    sleep: services.sleep,
    exhausted: () => actionDeadlinePassed(services)
  };
}
function actionDeadlinePassed(services) {
  return services.actionDeadline !== void 0 && services.now !== void 0 && services.now() >= services.actionDeadline;
}
function sameWheelRequest(a, b) {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.deltaX - b.deltaX) < 1 && Math.abs(a.deltaY - b.deltaY) < 1;
}
async function bringIntoView(services, sessionId, objectId, input) {
  const notVisible = () => new ElementResolutionError(
    `${input.actionName} failed: ${input.subject} is not visible in the viewport`,
    "transient"
  );
  let previous;
  let fellBack = false;
  for (let attempt = 0; attempt <= AUTO_SCROLL_ATTEMPTS; attempt += 1) {
    const result = await input.evaluate();
    if (typeof result?.error === "string") {
      throw new ElementResolutionError(
        `${input.actionName} failed: ${result.error}`,
        "transient"
      );
    }
    const scroll = result?.scroll;
    if (!scroll) return result;
    if (attempt === AUTO_SCROLL_ATTEMPTS || !Number.isFinite(scroll.x) || !Number.isFinite(scroll.y) || !Number.isFinite(scroll.deltaX) || !Number.isFinite(scroll.deltaY) || actionDeadlinePassed(services)) {
      throw notVisible();
    }
    if (previous && sameWheelRequest(previous, scroll)) {
      if (fellBack) throw notVisible();
      fellBack = true;
      previous = void 0;
      try {
        await services.cdp(
          "DOM.scrollIntoViewIfNeeded",
          { objectId },
          sessionId
        );
      } catch {
        throw notVisible();
      }
      continue;
    }
    previous = scroll;
    if (!await input.wheel(scroll)) throw notVisible();
  }
  throw notVisible();
}
async function ensureFrameOwnerInView(services, pageSessionId, frameId, actionName, iframeSessions, visited = /* @__PURE__ */ new Set()) {
  if (visited.has(frameId)) return;
  visited.add(frameId);
  const parentFrameIds = iframeSessions.parentFrameIds;
  const parentFrameId = parentFrameIds?.get(frameId);
  if (parentFrameId && iframeSessions.has(parentFrameId)) {
    await ensureFrameOwnerInView(
      services,
      pageSessionId,
      parentFrameId,
      actionName,
      iframeSessions,
      visited
    );
  }
  const ownerSessionId = parentFrameId ? iframeSessions.get(parentFrameId) || pageSessionId : pageSessionId;
  const owner = await services.cdp(
    "DOM.getFrameOwner",
    { frameId },
    ownerSessionId
  );
  const backendNodeId = owner?.backendNodeId;
  if (backendNodeId === void 0 || backendNodeId === null) {
    throw new ElementResolutionError(
      `${actionName} failed: iframe is not available`,
      "transient"
    );
  }
  const resolved = await services.cdp(
    "DOM.resolveNode",
    { backendNodeId, objectGroup: "ego-browser" },
    ownerSessionId
  );
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw new ElementResolutionError(
      `${actionName} failed: iframe is not available`,
      "transient"
    );
  }
  const source = `function() {
    ${SCROLL_TARGET_HELPERS}
    if (!this.isConnected) return { error: "iframe is not connected" };
    const rect = this.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return { error: "iframe is not visible" };
    }
    const point = actionPointForElement(this);
    if (!point) return { error: "iframe is not visible" };
    return { scroll: scrollRequestForPoint(this, point) };
  }`;
  try {
    await bringIntoView(services, ownerSessionId, objectId, {
      actionName,
      subject: "iframe",
      evaluate: async () => {
        const response = await services.cdp(
          "Runtime.callFunctionOn",
          {
            functionDeclaration: source,
            objectId,
            returnByValue: true,
            awaitPromise: false
          },
          ownerSessionId
        );
        return runtimeValue(response, source);
      },
      wheel: (scroll) => dispatchWheelMotion(
        wheelMotionServices(services, ownerSessionId),
        scroll
      )
    });
  } finally {
    await releaseObject(services, ownerSessionId, objectId);
  }
}
async function pagePointForFrame(services, sessionId, frameId, point, pageSessionId = sessionId) {
  if (!point || typeof point.x !== "number" || !Number.isFinite(point.x) || typeof point.y !== "number" || !Number.isFinite(point.y) || !frameId || sessionId !== pageSessionId) {
    return point;
  }
  const owner = await services.cdp(
    "DOM.getFrameOwner",
    { frameId },
    pageSessionId
  );
  const backendNodeId = owner?.backendNodeId;
  if (backendNodeId === void 0 || backendNodeId === null) {
    throw new Error(`page action could not resolve iframe ${frameId}`);
  }
  const box = await services.cdp(
    "DOM.getBoxModel",
    { backendNodeId },
    pageSessionId
  );
  const content = box?.model?.content;
  if (!Array.isArray(content) || content.length < 2) {
    throw new Error(`page action could not resolve iframe ${frameId} position`);
  }
  return { x: point.x + content[0], y: point.y + content[1] };
}
async function cursorPointForElement(services, pageSessionId, targetSessionId, frameId, inputPoint, localPoint, iframeSessions) {
  if (!frameId || targetSessionId === pageSessionId) return inputPoint;
  const parents = new Map(
    iframeSessions.parentFrameIds
  );
  try {
    const response = await services.cdp("Page.getFrameTree", {}, pageSessionId);
    const collect = (tree, parentId) => {
      const currentFrameId = tree?.frame?.id;
      if (typeof currentFrameId !== "string") return;
      parents.set(currentFrameId, tree.frame.parentId ?? parentId);
      for (const child of tree.childFrames || []) {
        collect(child, currentFrameId);
      }
    };
    collect(response?.frameTree, void 0);
  } catch {
  }
  try {
    let point = localPoint;
    let currentFrameId = frameId;
    let currentSessionId = targetSessionId;
    const visited = /* @__PURE__ */ new Set();
    while (currentFrameId && parents.get(currentFrameId) && !visited.has(currentFrameId)) {
      visited.add(currentFrameId);
      let boundaryFrameId = currentFrameId;
      let parentFrameId = parents.get(boundaryFrameId);
      while (parentFrameId && parents.get(parentFrameId) && (iframeSessions.get(parentFrameId) || pageSessionId) === currentSessionId) {
        boundaryFrameId = parentFrameId;
        parentFrameId = parents.get(boundaryFrameId);
      }
      const parentSessionId = parentFrameId ? iframeSessions.get(parentFrameId) || pageSessionId : pageSessionId;
      point = await pagePointForFrame(
        services,
        parentSessionId,
        boundaryFrameId,
        point
      );
      currentFrameId = parentFrameId;
      currentSessionId = parentSessionId;
    }
    return point;
  } catch {
    return inputPoint;
  }
}
async function assertClickTargetActionable(services, sessionId, objectId, point, options) {
  const { hitTest, actionName = "page.click" } = options;
  const expression = `function clickTargetActionable(point) {
    ${hitTest ? HIT_TARGET_HELPERS : ACTION_TARGET_STATE_HELPERS}
    if (!this.isConnected) return { error: "element is not connected" };
    if (isActionTargetDisabled(this)) return { error: "element is disabled" };
    if (${hitTest ? "true" : "false"}) {
      const interceptor = interceptingElementAtPoint(this, point);
      if (interceptor) {
        return { error: describeHitTarget(interceptor) + " intercepts pointer events" };
      }
    }
    return { ok: true };
  }`;
  const response = await services.cdp(
    "Runtime.callFunctionOn",
    {
      functionDeclaration: expression,
      objectId,
      arguments: [{ value: point }],
      returnByValue: true,
      awaitPromise: false
    },
    sessionId
  );
  const result = runtimeValue(response, expression);
  if (typeof result?.error === "string") {
    throw new ElementResolutionError(
      `${actionName} failed: ${result.error}`,
      "transient"
    );
  }
}
async function assertElementReceivesPointerEvents(services, sessionId, objectId, point) {
  const expression = `function(point) {
    ${HIT_TARGET_HELPERS}
    if (!this.isConnected) return { error: "element is not connected" };
    const interceptor = interceptingElementAtPoint(this, point);
    return interceptor
      ? { error: describeHitTarget(interceptor) + " intercepts pointer events" }
      : { ok: true };
  }`;
  const response = await services.cdp(
    "Runtime.callFunctionOn",
    {
      functionDeclaration: expression,
      objectId,
      arguments: [{ value: point }],
      returnByValue: true,
      awaitPromise: false
    },
    sessionId
  );
  const result = runtimeValue(response, expression);
  if (typeof result?.error === "string") {
    throw new ElementResolutionError(
      `page.click failed: ${result.error}`,
      "transient"
    );
  }
}
async function assertElementEnabled(services, sessionId, objectId, actionName) {
  const expression = `function() {
    ${ACTION_TARGET_STATE_HELPERS}
    if (!this.isConnected) return { error: "element is not connected" };
    return isActionTargetDisabled(this)
      ? { error: "element is disabled" }
      : { ok: true };
  }`;
  const response = await services.cdp(
    "Runtime.callFunctionOn",
    {
      functionDeclaration: expression,
      objectId,
      returnByValue: true,
      awaitPromise: false
    },
    sessionId
  );
  const result = runtimeValue(response, expression);
  if (typeof result?.error === "string") {
    throw new ElementResolutionError(
      `${actionName} failed: ${result.error}`,
      "transient"
    );
  }
}
function fillPreparationError(message) {
  const transient = /* @__PURE__ */ new Set([
    "element is not connected",
    "element is not visible",
    "element is disabled",
    "element is read only"
  ]);
  return transient.has(message) ? new ElementResolutionError(`page.fill failed: ${message}`, "transient") : new Error(`page.fill failed: ${message}`);
}
function exceptionDescription(response) {
  return response?.exceptionDetails?.exception?.description || response?.exceptionDetails?.text || "page action evaluation failed";
}
function assertPageSelector(selector) {
  if (typeof selector !== "string" || selector.trim().length === 0) {
    throw new TypeError("Page actions require a non-empty selector string");
  }
}
function cdpAdapter(services) {
  return {
    sendRaw(method, params, sessionId) {
      return services.cdp(method, params, sessionId);
    }
  };
}
async function dispatchMouseEvent(services, sessionId, params, cursorPoint) {
  await services.cdp("Input.dispatchMouseEvent", params, sessionId);
  if (params.type !== "mouseMoved" || typeof params.x !== "number" || typeof params.y !== "number") {
    return;
  }
  showAgentCursor(services, cursorPoint || { x: params.x, y: params.y });
}
function showAgentCursor(services, point) {
  const x = point?.x;
  const y = point?.y;
  if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) {
    return;
  }
  try {
    void services.showAgentMousePosition(x, y).catch(() => {
    });
  } catch {
  }
}
function showAgentActionLabel(services, label) {
  if (!label) return;
  try {
    void services.showAgentTaskState(label).catch(() => {
    });
  } catch {
  }
}
async function releaseObject(services, sessionId, objectId) {
  void services.cdp("Runtime.releaseObject", { objectId }, sessionId).catch(() => {
  });
}
function assertPoint(x, y, operation) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError(`${operation} requires finite x and y coordinates`);
  }
}
function mouseButtonMask(button) {
  return pressedButtons(button);
}
function pressedButtons(button) {
  if (button === "left") return 1;
  if (button === "right") return 2;
  return 4;
}
export {
  clickInPage,
  clickPointInPage,
  dragAndDropInPage,
  fillInPage,
  focusInPage,
  hoverInPage,
  mouseButtonInPage,
  mouseButtonMask,
  moveMouseInPage,
  selectOptionInPage,
  wheelInPage
};
