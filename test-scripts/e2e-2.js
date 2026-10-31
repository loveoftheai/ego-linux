const t = await taskSpace("e2e-file-task-r");
const p = t.page("p1");
await p.goto("file:///home/hatch/workspace/ego-re/linux/test-fixtures/form.html", { waitUntil: "load", timeout: 20000 });
console.log("URL:", await p.url());
const snap = await p.snapshot();
console.log("=== SNAPSHOT ===");
console.log(snap.content);
console.log("=== REFS ===");
for (const r of snap.refs) console.log(`@${r.refId}`, r.role, JSON.stringify(r.name), r.loc || "");
