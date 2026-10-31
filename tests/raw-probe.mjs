// Direct binding-layer test (no SDK): dump ego.snapshot raw output and the
// ground-truth AX tree for the same page.
import { ensureChromium, STATE_PATH } from "../src/chromium.js";
import { CdpTransport } from "../src/cdp-transport.js";
import { EgoBindings } from "../src/ego-bindings.js";

const chromium = await ensureChromium({});
const transport = await CdpTransport.connect(chromium.webSocketDebuggerUrl);
const ego = await EgoBindings.create(transport, STATE_PATH);
globalThis.ego = ego;

const task = await ego.createTaskSpace("raw-probe");
ego.useTaskSpace(task.id);
const tab = await ego.createTab("https://example.com/");
console.log("tab:", JSON.stringify(tab));
await new Promise((r) => setTimeout(r, 3500));

const raw = await ego.snapshot({ includeStableLocator: true });
console.log("=== RAW ego.snapshot content ===");
console.log(raw.content);
console.log("=== RAW refs ===");
console.log(JSON.stringify(raw.refs, null, 1));

// Ground truth: raw AX tree on a binding-owned session via transport call
// through a fresh attach, mirroring what snapshot.js does.
const { targetInfos } = await transport.call("Target.getTargets");
const page = targetInfos.find((t) => t.type === "page" && t.url.includes("example.com"));
const { sessionId } = await transport.call("Target.attachToTarget", { targetId: page.targetId, flatten: true });
await transport.call("Accessibility.enable", {}, sessionId).catch(() => {});
const ax = await transport.call("Accessibility.getFullAXTree", {}, sessionId);
console.log("=== AX nodes (role | name | backendDOMNodeId | ignored) ===");
for (const n of ax.nodes) {
  console.log(`${n.role?.value} | ${JSON.stringify(n.name?.value || "")} | ${n.backendDOMNodeId} | ignored=${n.ignored}`);
}
transport.close();
process.exit(0);
