import {
  stdin as processStdin,
  stdout as processStdout,
  stderr as processStderr
} from "node:process";
import { parse } from "acorn";
import { formatCliLogValue } from "./format.js";
import * as helpers from "./helpers.js";
import { addPageContextHint } from "./page-context-guard.js";
import {
  bufferOutput,
  createRoundConsole,
  flushSink,
  resetSink
} from "./output-sink.js";
const HELP = `ego-browser

Read the ego-browser skill for the default workflow and examples.

Typical usage:
  ego-browser <<'JS'
  const task = await taskSpace('demo')
  const page = task.page('p1')
  await page.goto('https://example.com')
  console.log(await page.snapshot())
  JS

Helpers are pre-imported and the browser connection is prepared automatically.
`;
const USAGE = `Usage:
  ego-browser <<'JS'
  const task = await taskSpace('demo')
  const page = task.page('p1')
  await page.goto('https://example.com')
  console.log(await page.snapshot())
  JS
`;
async function runMain(options = {}) {
  const argv = options.argv || process.argv.slice(2);
  const stdout = options.stdout || processStdout;
  const stderr = options.stderr || processStderr;
  if (argv[0] === "-h" || argv[0] === "--help") {
    write(stdout, HELP);
    return 0;
  }
  if (argv.length > 0) {
    write(stderr, USAGE);
    return 2;
  }
  const code = options.stdinText !== void 0 ? options.stdinText : await readAll(options.stdin || processStdin);
  if (!code.trim()) {
    write(stderr, USAGE);
    return 2;
  }
  await execute(code, stdout);
  return 0;
}
async function execute(code, stdout) {
  resetSink();
  const context = await executionContext();
  const globalHelpers = { ...context };
  delete globalHelpers.console;
  Object.assign(globalThis, globalHelpers);
  const AsyncFunction = Object.getPrototypeOf(async function() {
  }).constructor;
  const names = Object.keys(context);
  const values = Object.values(context);
  let fn;
  try {
    fn = new AsyncFunction(...names, `"use strict";
${code}`);
  } catch (error) {
    flushSink(stdout, true);
    throw userScriptSyntaxError(code, error);
  }
  try {
    await fn(...values);
  } catch (error) {
    flushSink(stdout, true);
    throw addPageContextHint(error);
  }
  flushSink(stdout, false);
}
function userScriptSyntaxError(code, original) {
  const originalMessage = original instanceof Error ? original.message : String(original);
  try {
    parse(`async function __egoBrowserUserScript__() {
${code}
}`, {
      ecmaVersion: "latest",
      sourceType: "script"
    });
  } catch (parseError) {
    const location = parseError.loc;
    if (location && location.line >= 2) {
      const userLineNumber = location.line - 1;
      const sourceLine = code.split(/\r?\n/)[userLineNumber - 1] ?? "";
      const columnNumber = location.column + 1;
      const error = new SyntaxError(
        `Browser script syntax error at line ${userLineNumber}, column ${columnNumber}: ${originalMessage}
${userLineNumber} | ${sourceLine}
${" ".repeat(String(userLineNumber).length + 3 + location.column)}^`
      );
      error.cause = original;
      return error;
    }
  }
  return original instanceof SyntaxError ? original : new SyntaxError(originalMessage);
}
async function executionContext() {
  const agentHelpers = await helpers.loadAgentHelpers();
  const context = helpers.helperContext(agentHelpers);
  context.cliLog = (...args) => {
    bufferOutput(`${args.map(formatCliLogValue).join(" ")}
`);
  };
  context.console = createRoundConsole();
  return context;
}
function readAll(stream) {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}
function write(stream, text) {
  stream.write(text);
}
export {
  HELP,
  USAGE,
  executionContext,
  runMain
};
