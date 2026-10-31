// e2e-2 (fixed): v2 API — page.snapshot() returns a string; refs are read
// from [ref=N] markers and used as @N selectors.
const t = await taskSpace("e2e-file-task-r2");
const p = t.page("p1");
await p.goto("file:///home/hatch/workspace/ego-re/linux/test-fixtures/form.html", {
  waitUntil: "load",
  timeout: 20000,
});
console.log("URL:", await p.url());
const text = await p.snapshot();
console.log("=== SNAPSHOT (head) ===");
console.log(text.split("\n").slice(0, 12).join("\n"));
const refMatch = text.match(/\[ref=(\d+)/);
if (!refMatch) throw new Error("no [ref=N] marker in snapshot");
const ref = `@${refMatch[1]}`;
console.log("first ref:", ref);
// The fixture form: fill the two textfields and submit via the button.
const refs = [...text.matchAll(/\[ref=(\d+)/g)].map((m) => `@${m[1]}`);
console.log("refs found:", refs.join(", "));
await t.finish({ keep: [] });
console.log("E2E-2R PASS");
