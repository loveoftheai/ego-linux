import { writeSync } from "node:fs";
import { formatCliLogValue } from "./format.js";
import {
  consumeUnhandledPageNotices,
  resetPageNotices
} from "./page-discovery.js";
import {
  formatRoundStatus,
  refreshRoundStatus,
  resetRoundStatus,
  roundStatusNeedsRefresh
} from "./round-status.js";
let buffer = [];
let hardStopMessage = null;
let flushed = false;
let lifecycleHooked = false;
let finalizing = false;
let hardStopsSuppressed = 0;
function bufferOutput(chunk) {
  buffer.push(chunk);
}
function createRoundConsole(writeLine = bufferOutput) {
  const append = (prefix, args) => {
    const body = args.map(formatCliLogValue).join(" ");
    writeLine(`${prefix}${body}
`);
  };
  return Object.freeze({
    log: (...args) => append("", args),
    info: (...args) => append("", args),
    warn: (...args) => append("[warn] ", args),
    error: (...args) => append("[error] ", args)
  });
}
function markHardStop(message) {
  if (hardStopsSuppressed > 0) return;
  if (hardStopMessage === null) {
    hardStopMessage = message;
  }
}
function flushSink(stream, thrown) {
  if (flushed) return;
  flushed = true;
  const pageNotices = consumeUnhandledPageNotices();
  if (hardStopMessage !== null) {
    if (!thrown) {
      stream.write(
        hardStopMessage.endsWith("\n") ? hardStopMessage : `${hardStopMessage}
`
      );
    }
  } else {
    for (const chunk of buffer) stream.write(chunk);
    const status = formatRoundStatus(pageNotices);
    if (status.remainingNotices.length > 0) {
      stream.write(formatPageNotices(status.remainingNotices));
    }
    if (status.line) stream.write(status.line);
  }
  buffer = [];
}
async function finalizeRoundStatus() {
  if (hardStopMessage !== null) return;
  hardStopsSuppressed += 1;
  try {
    await refreshRoundStatus();
  } finally {
    hardStopsSuppressed -= 1;
  }
}
function resetSink() {
  buffer = [];
  hardStopMessage = null;
  flushed = false;
  finalizing = false;
  resetPageNotices();
  resetRoundStatus();
}
function formatPageNotices(notices) {
  const lines = notices.map((notice) => {
    const source = notice.openerLabel ? ` from ${notice.openerLabel}` : "";
    const url = oneLine(notice.url || "about:blank");
    return `Unhandled page ${notice.label}${source}: ${url}`;
  });
  return `[ego-browser:pages]
${lines.join("\n")}
`;
}
function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}
function installLifecycleFlush(stream, lifecycle = process) {
  if (lifecycleHooked) return;
  lifecycleHooked = true;
  const writer = Number.isInteger(stream.fd) ? {
    write(chunk) {
      writeSync(stream.fd, chunk);
    }
  } : stream;
  lifecycle.on("beforeExit", () => {
    if (flushed || finalizing) return;
    if (hardStopMessage !== null || !roundStatusNeedsRefresh()) {
      flushSink(writer, false);
      return;
    }
    finalizing = true;
    void finalizeRoundStatus().then(() => flushSink(writer, false));
  });
  lifecycle.on("exit", () => flushSink(writer, true));
}
export {
  bufferOutput,
  createRoundConsole,
  finalizeRoundStatus,
  flushSink,
  installLifecycleFlush,
  markHardStop,
  resetSink
};
