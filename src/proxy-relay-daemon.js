// Detached TCP relay daemon: Chromium (sandboxed network service) cannot
// reach the sandbox egress proxy directly in this environment, while
// ordinary processes can. The browser therefore points at this loopback
// relay, which pipes bytes to the real upstream proxy unchanged (the
// HTTP CONNECT protocol runs end-to-end through the pipe).
//
// Usage: node proxy-relay-daemon.js <upstreamHost> <upstreamPort> <port>
// Writes { pid, port, upstream } to $EGO_DATA_DIR/relay.json once bound.

import net from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [upstreamHost, upstreamPortArg, listenPortArg] = process.argv.slice(2);
const upstreamPort = Number(upstreamPortArg);
const dataDir = process.env.EGO_DATA_DIR;
if (!upstreamHost || !upstreamPort || !dataDir) {
  console.error("usage: proxy-relay-daemon <host> <port> <listenPort> (EGO_DATA_DIR required)");
  process.exit(2);
}

const server = net.createServer((client) => {
  const upstream = net.connect(upstreamPort, upstreamHost);
  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };
  // A hung upstream (e.g. the sandbox proxy stalling a request) must not
  // leak sockets: close the pair on either side's error OR clean close.
  client.on("error", closeBoth);
  upstream.on("error", closeBoth);
  client.on("close", closeBoth);
  upstream.on("close", closeBoth);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.listen(Number(listenPortArg) || 0, "127.0.0.1", async () => {
  const { port } = server.address();
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, "relay.json"),
    JSON.stringify({ pid: process.pid, port, upstream: `${upstreamHost}:${upstreamPort}` }),
  );
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
