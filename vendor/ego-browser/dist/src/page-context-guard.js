const PAGE_ONLY_GLOBALS = [
  "document",
  "innerHeight",
  "innerWidth",
  "localStorage",
  "location",
  "scrollX",
  "scrollY",
  "sessionStorage",
  "window"
];
const PAGE_ONLY_GLOBAL_NAMES = new Set(PAGE_ONLY_GLOBALS);
function pageContextHint(globalName) {
  return `The heredoc runs in Node.js, not in the Page. ${globalName} is a Page global. Put browser-side code inside page.evaluate(), for example page.evaluate(() => ...); keep Node.js work outside it.`;
}
function addPageContextHint(error) {
  if (!(error instanceof ReferenceError)) return error;
  const match = /^([A-Za-z_$][\w$]*) is not defined\.?$/i.exec(
    error.message.trim()
  );
  if (!match || !PAGE_ONLY_GLOBAL_NAMES.has(match[1])) return error;
  if (error.message.includes("page.evaluate()")) return error;
  const originalMessage = error.message;
  error.message = `${originalMessage}. ${pageContextHint(match[1])}`;
  if (typeof error.stack === "string") {
    const lines = error.stack.split("\n");
    lines[0] = `${error.name}: ${error.message}`;
    error.stack = lines.join("\n");
  }
  return error;
}
function installPageContextGuard(target) {
  for (const globalName of PAGE_ONLY_GLOBALS) {
    if (globalName === "window") continue;
    if (Object.getOwnPropertyDescriptor(target, globalName)) continue;
    Object.defineProperty(target, globalName, {
      configurable: true,
      enumerable: false,
      get() {
        throw new ReferenceError(
          `${globalName} is not defined. ${pageContextHint(globalName)}`
        );
      }
    });
  }
}
export {
  addPageContextHint,
  installPageContextGuard
};
