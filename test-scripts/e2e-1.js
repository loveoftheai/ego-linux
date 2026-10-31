const t = await taskSpace("e2e-form-b");
const p = t.page("p1");
await p.goto("http://127.0.0.1:8765/form.html", { waitUntil: "load", timeout: 20000 });
const snap = await p.snapshot();
console.log("=== SNAPSHOT BEGIN ===");
console.log(snap.content);
console.log("=== SNAPSHOT END ===");
console.log("REFS:", JSON.stringify(snap.refs.map(r => ({ refId: r.refId, role: r.role, name: r.name, loc: r.loc || null })), null, 1));
