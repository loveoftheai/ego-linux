// Chromium process management for the Linux binding layer.
//
// One shared Chromium instance serves every ego-browser invocation, like
// the ego lite app does: the browser stays alive across short-lived CLI
// processes. The debug port is discovered through the standard
// `DevToolsActivePort` file inside the profile directory.
//
// Proxy: Chromium's network service cannot reach the sandbox egress proxy
// directly in this environment (CONNECT attempts are refused/reset while
// ordinary processes succeed). The binding layer therefore runs a small
// loopback TCP relay daemon (proxy-relay-daemon.js) and points Chromium
// at http://127.0.0.1:<relayPort>; the CONNECT protocol passes through
// the pipe untouched.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "ego-lite-linux",
);
export const PROFILE_DIR = join(DATA_DIR, "chromium-profile");
export const PROFILES_DIR = join(DATA_DIR, "profiles");
export const STATE_PATH = join(DATA_DIR, "state.json");
const RELAY_INFO_PATH = join(DATA_DIR, "relay.json");

/**
 * Stable id for a Chromium instance, used as the SDK page ledger's
 * browser-instance identity (EGO_BROWSER_INSTANCE_ID, set by the launcher).
 * Regenerated whenever a fresh Chromium is spawned so stale ledgers (which
 * reference dead targetIds) are discarded exactly like in the native app,
 * where the Node runtime is hosted inside the browser process (stable ppid)
 * while our per-invocation Node processes are not.
 *
 * One id per profile: each ego profile runs its own Chromium process with
 * its own user-data-dir, so target/ledger namespaces never mix.
 */
export async function getBrowserInstanceId(fresh, userDataDir) {
  const instanceIdPath = join(userDataDir, "ego-instance.id");
  if (fresh) {
    const id = `browser-host:${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(36)}`;
    await mkdir(userDataDir, { recursive: true });
    await writeFile(instanceIdPath, id, "utf8");
    return id;
  }
  try {
    const id = (await readFile(instanceIdPath, "utf8")).trim();
    if (id) return id;
  } catch {
    // Missing: fall through and mint one.
  }
  return getBrowserInstanceId(true, userDataDir);
}

/** user-data-dir backing an ego profile id. */
export function userDataDirForProfile(profileId) {
  if (!profileId || profileId === "Default") return PROFILE_DIR;
  return join(PROFILES_DIR, profileId);
}

const CANDIDATE_BINARIES = [
  process.env.EGO_CHROMIUM_BIN,
  join(HERE, "..", "tools", "browsers", "chrome-headless-shell-linux64", "chrome-headless-shell"),
  "/opt/meta-chromium/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
].filter(Boolean);

export function findChromiumBinary() {
  for (const candidate of CANDIDATE_BINARIES) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function upstreamProxy() {
  const raw =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return {
      host: parsed.hostname,
      port: Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80),
    };
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

async function waitForRelay(port, timeoutMs = 8000) {
  const net = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
    });
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

/**
 * Ensure the loopback relay to the upstream proxy is running.
 * Returns the relay port, or null when no upstream proxy is configured.
 */
async function ensureRelay() {
  const upstream = upstreamProxy();
  if (!upstream) return null;
  const upstreamKey = `${upstream.host}:${upstream.port}`;
  const recorded = await readJson(RELAY_INFO_PATH);
  if (
    recorded &&
    recorded.upstream === upstreamKey &&
    (await waitForRelay(recorded.port, 600))
  ) {
    // A live listener on the recorded port is sufficient proof of a working
    // relay. Do not require pidAlive: under a PID namespace (bwrap, Docker)
    // a healthy relay started outside the namespace is invisible to kill(2),
    // and insisting on it makes us respawn onto the same, already-bound port.
    return recorded.port;
  }
  const daemon = spawn(
    process.execPath,
    [
      join(HERE, "proxy-relay-daemon.js"),
      upstream.host,
      String(upstream.port),
      String(recorded && recorded.upstream === upstreamKey ? recorded.port : 0),
    ],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, EGO_DATA_DIR: DATA_DIR },
    },
  );
  daemon.unref();
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    const info = await readJson(RELAY_INFO_PATH);
    if (
      info &&
      info.upstream === upstreamKey &&
      pidAlive(info.pid) &&
      info.port !== (recorded && recorded.port)
    ) {
      if (await waitForRelay(info.port, 600)) return info.port;
    }
    if (
      info &&
      info.upstream === upstreamKey &&
      pidAlive(info.pid) &&
      (await waitForRelay(info.port, 600))
    ) {
      return info.port;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error("proxy relay daemon did not start");
}

async function readDebugPort(userDataDir) {
  try {
    const text = await readFile(join(userDataDir, "DevToolsActivePort"), "utf8");
    const port = Number(text.split("\n")[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function fetchVersion(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function closeBrowser(webSocketDebuggerUrl) {
  try {
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    ws.close();
  } catch {
    // Best effort; a respawn will fail loudly if the old browser lingers.
  }
}

/**
 * Ensure a Chromium with remote debugging is running for the given ego
 * profile and return `{ port, webSocketDebuggerUrl, version, reused,
 * instanceId, profileId }`.
 *
 * Parity note: the native app hosts one browser process whose profile
 * manager can open targets in any profile, so spaces of the same profile
 * share that profile's cookie jar. Stock Chromium exposes only one
 * user-data-dir per process over CDP, so route B runs one Chromium per ego
 * profile (each its own user-data-dir) and routes binding calls by
 * space.profileId. Spaces of the same profile share the process and the
 * cookie jar, exactly like the original.
 */
export async function ensureChromium({ profileId = "Default", headed = false } = {}) {
  const userDataDir = userDataDirForProfile(profileId);
  const browserInfoPath = join(userDataDir, "ego-browser-info.json");
  await mkdir(userDataDir, { recursive: true });
  const relayPort = await ensureRelay();
  const browserInfo = await readJson(browserInfoPath);

  const existingPort = await readDebugPort(userDataDir);
  if (existingPort) {
    try {
      const version = await fetchVersion(existingPort);
      const wantBypass = relayPort ? "127.0.0.1,localhost,::1" : "";
      if (
        browserInfo &&
        browserInfo.relayPort === relayPort &&
        browserInfo.proxyBypassList === wantBypass &&
        browserInfo.siteIsolation === true
      ) {
        return {
          port: existingPort,
          webSocketDebuggerUrl: version.webSocketDebuggerUrl,
          version,
          reused: true,
          instanceId: await getBrowserInstanceId(false, userDataDir),
          profileId,
        };
      }
      // Launched with a different proxy configuration: restart it so the
      // recorded relay applies.
      await closeBrowser(version.webSocketDebuggerUrl);
      await new Promise((resolve) => setTimeout(resolve, 600));
    } catch {
      // Stale port file or a dead browser: fall through and spawn fresh.
    }
  }

  const binary = findChromiumBinary();
  if (!binary) {
    throw new Error(
      "No Chromium binary found. Set EGO_CHROMIUM_BIN to a Chromium/Chrome executable.",
    );
  }
  const headless = !headed && !process.env.DISPLAY;
  const args = [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    // The original is a full Chromium build with site isolation on: cross-site
    // iframes run out-of-process (OOPIF) and surface as CDP "iframe" targets.
    // headless-shell leaves them in-process by default, which breaks
    // iframeTarget() discovery and diverges from the original's process model.
    "--site-per-process",
    "about:blank",
  ];
  if (relayPort) {
    args.push(`--proxy-server=http://127.0.0.1:${relayPort}`);
    // Loopback (fixture servers, debuggers) must bypass the upstream proxy:
    // sending 127.0.0.1 traffic to the egress proxy is wrong on any machine.
    // Note: the special `<-loopback>` token is NOT honored by this Chromium
    // build (verified 2026-10-21: requests still went to the proxy); use an
    // explicit host list instead.
    args.push("--proxy-bypass-list=127.0.0.1,localhost,::1");
  }
  // The sandbox egress proxy TLS-intercepts with its own CA
  // (/etc/ssl/certs/hatch-egress-ca.pem), which Chromium's root store does
  // not know. Test harnesses handle this with --ignore-certificate-errors;
  // enable it only in this sandbox (CA file present).
  if (existsSync("/etc/ssl/certs/hatch-egress-ca.pem")) {
    args.push("--ignore-certificate-errors");
  }
  if (headless && !binary.includes("headless-shell")) {
    args.splice(2, 0, "--headless=new");
  }
  const child = spawn(binary, args, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const port = await readDebugPort(userDataDir);
    if (port) {
      try {
        const version = await fetchVersion(port);
        await writeFile(
          browserInfoPath,
          JSON.stringify({
            relayPort,
            binary,
            port,
            proxyBypassList: relayPort ? "127.0.0.1,localhost,::1" : "",
            siteIsolation: true,
          }),
        );
        return {
          port,
          webSocketDebuggerUrl: version.webSocketDebuggerUrl,
          version,
          reused: false,
          instanceId: await getBrowserInstanceId(true, userDataDir),
          profileId,
        };
      } catch {
        // Browser socket not ready yet.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Chromium did not expose a DevTools endpoint in time");
}
