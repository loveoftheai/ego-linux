import { parse } from "acorn";
import { browserCdp } from "./browser-runtime.js";
import { state } from "./state.js";
let hasWarnedAboutFunctionJs = false;
async function cdp(method, params = {}, sessionId = void 0) {
  assertNoSessionIdInParams(
    "cdp",
    method,
    params,
    "Pass it as the third argument: cdp(method, params, sessionId)."
  );
  const result = state.cdpOverride ? await state.cdpOverride(method, params, sessionId) : (await browserCdp(method, params, sessionId)).result || {};
  if (!sessionId && (method === "Network.enable" || method === "Network.disable")) {
    state.networkDomainEnabled = method === "Network.enable";
  }
  return result;
}
const COMMANDS_WITH_SESSION_ID_PARAM = /* @__PURE__ */ new Set([
  "Target.detachFromTarget",
  "Target.sendMessageToTarget"
]);
function assertNoSessionIdInParams(apiName, method, params, remedy) {
  if (params?.sessionId === void 0 || COMMANDS_WITH_SESSION_ID_PARAM.has(method)) {
    return;
  }
  throw new TypeError(
    `${apiName}: ${method} does not take sessionId in params; it would be ignored and the command would run in the wrong session. ${remedy}`
  );
}
async function js(expression, targetId = void 0) {
  if (typeof expression === "function") {
    const source = expression.toString();
    if (!hasWarnedAboutFunctionJs) {
      hasWarnedAboutFunctionJs = true;
      process.stderr.write(
        `[ego-browser] js() received a function and auto-wrapped it (${jsSnippet(source, 80)}).
  js() is a thin wrapper over CDP Runtime.evaluate; it takes a string expression,
  not a Puppeteer/Playwright-style callable. Auto-wrap does NOT capture closure
  variables and has NO args channel.
  Prefer:
    js(\`<expression>\`)  // pure expression or explicit IIFE
`
      );
    }
    expression = `(${source})()`;
  } else if (typeof expression !== "string") {
    throw new TypeError(
      `js() expects a string expression or function, got ${expression === null ? "null" : typeof expression}`
    );
  }
  const sessionId = targetId ? (await cdp("Target.attachToTarget", { targetId, flatten: true })).sessionId : void 0;
  let finalExpression = expression;
  if (hasReturnStatement(expression)) {
    finalExpression = `(async function(){
${expression}
})()`;
  }
  return runtimeEvaluate(finalExpression, sessionId, true);
}
async function runtimeEvaluate(expression, sessionId = void 0, awaitPromise = false) {
  try {
    const response = await cdp(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise
      },
      sessionId
    );
    return runtimeValue(response, expression);
  } catch (error) {
    if (/timed out/i.test(error?.message || "")) {
      throw new Error(
        `Runtime.evaluate timed out; expression: ${jsSnippet(expression)}`
      );
    }
    throw error;
  }
}
function runtimeValue(response, expression) {
  const result = response.result || {};
  const details = response.exceptionDetails;
  if (details || result.subtype === "error") {
    const desc = jsExceptionDescription(result, details);
    const loc = details?.lineNumber !== void 0 && details?.columnNumber !== void 0 ? ` at line ${details.lineNumber}, column ${details.columnNumber}` : "";
    throw new Error(
      `JavaScript evaluation failed${loc}: ${desc}; expression: ${jsSnippet(expression)}`
    );
  }
  if (Object.hasOwn(result, "value")) {
    return result.value;
  }
  if (Object.hasOwn(result, "unserializableValue")) {
    return decodeUnserializableJsValue(result.unserializableValue);
  }
  return null;
}
function jsExceptionDescription(result, details) {
  let desc = result.description;
  const exception = details?.exception;
  if (!desc && exception && typeof exception === "object") {
    desc = exception.description;
    if (desc === void 0 && Object.hasOwn(exception, "value")) {
      desc = String(exception.value);
    }
    if (desc === void 0) {
      desc = exception.className;
    }
  }
  return desc || details?.text || "JavaScript evaluation failed";
}
function decodeUnserializableJsValue(value) {
  if (value === "NaN") {
    return Number.NaN;
  }
  if (value === "Infinity") {
    return Number.POSITIVE_INFINITY;
  }
  if (value === "-Infinity") {
    return Number.NEGATIVE_INFINITY;
  }
  if (value === "-0") {
    return -0;
  }
  if (value.endsWith("n")) {
    return BigInt(value.slice(0, -1));
  }
  return value;
}
function jsSnippet(expression, limit = 160) {
  const snippet = expression.trim().replace(/\n/g, "\\n");
  return snippet.length > limit ? `${snippet.slice(0, limit - 3)}...` : snippet;
}
function hasReturnStatement(expression) {
  try {
    return containsOuterReturn(
      parse(expression, {
        ecmaVersion: "latest",
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true
      })
    );
  } catch {
    return false;
  }
}
function containsOuterReturn(node) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "ReturnStatement") return true;
  if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") {
    return false;
  }
  return Object.values(node).some(
    (child) => Array.isArray(child) ? child.some(containsOuterReturn) : containsOuterReturn(child)
  );
}
export {
  assertNoSessionIdInParams,
  cdp,
  decodeUnserializableJsValue,
  hasReturnStatement,
  js,
  runtimeValue
};
