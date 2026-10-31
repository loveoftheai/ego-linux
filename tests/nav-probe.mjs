const fs = await import("node:fs");
const portFile = "/home/hatch/.local/share/ego-lite-linux/chromium-profile/DevToolsActivePort";
const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const call = (method, params = {}, sessionId) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { targetId } = (await call("Target.createTarget", { url: "about:blank" })).result;
const { sessionId } = (await call("Target.attachToTarget", { targetId, flatten: true })).result;
await call("Page.enable", {}, sessionId);
await call("Network.enable", {}, sessionId);
const nav = await call("Page.navigate", { url: "https://example.com/" }, sessionId);
console.log("navigate:", JSON.stringify(nav.result || nav.error));
await new Promise((r) => setTimeout(r, 5000));
const text = await call("Runtime.evaluate", { expression: "document.body ? document.body.innerText.slice(0,300) : '(no body)'", returnByValue: true }, sessionId);
console.log("body:", JSON.stringify(text.result?.result?.value));
process.exit(0);
