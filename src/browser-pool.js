// Browser pool: one Chromium instance per ego profile.
//
// The native ego lite app hosts a single browser process whose profile
// manager opens targets in any profile. Stock Chromium binds one
// user-data-dir per process, so route B keeps one Chromium per ego profile
// (see ensureChromium in chromium.js) and this pool routes each binding
// call to the transport of the selected space's profile.

import { ensureChromium } from "./chromium.js";
import { CdpTransport } from "./cdp-transport.js";

export class BrowserPool {
  #entries = new Map(); // profileId -> { chromium, transport }
  #reconciled = new Set(); // profileIds whose spaces were target-reconciled

  /** (jsonString, profileId) => void — installed by the ego bindings. */
  onRuntimeMessage = null;
  /** (cdpEventMessage, profileId) => void — installed by the ego bindings. */
  onEvent = null;
  /** Called with (profileId) the first time a profile's browser connects. */
  onFirstConnect = null;

  async forProfile(profileId) {
    const key = profileId || "Default";
    let entry = this.#entries.get(key);
    if (entry && !entry.transport.closed) return entry.transport;
    const chromium = await ensureChromium({ profileId: key });
    const transport = await CdpTransport.connect(chromium.webSocketDebuggerUrl);
    transport.onRuntimeMessage = (text) => {
      if (typeof this.onRuntimeMessage === "function") {
        const cb = this.onRuntimeMessage;
        queueMicrotask(() => {
          try {
            cb(text, key);
          } catch {
            // The runtime guards its own callbacks; never break transport.
          }
        });
      }
    };
    transport.onEvent = (message) => {
      if (typeof this.onEvent === "function") {
        try {
          this.onEvent(message, key);
        } catch {
          // Event handling must not break the transport.
        }
      }
    };
    this.#entries.set(key, { chromium, transport });
    if (!this.#reconciled.has(key)) {
      this.#reconciled.add(key);
      if (typeof this.onFirstConnect === "function") {
        await this.onFirstConnect(key);
      }
    }
    return transport;
  }

  /** Cached transport only; never spawns a browser (for sync call paths). */
  cachedTransport(profileId) {
    const entry = this.#entries.get(profileId || "Default");
    return entry && !entry.transport.closed ? entry.transport : null;
  }

  instanceId(profileId) {
    const entry = this.#entries.get(profileId || "Default");
    return entry ? entry.chromium.instanceId : null;
  }

  closeAll() {
    for (const entry of this.#entries.values()) {
      try {
        entry.transport.close();
      } catch {
        // Best effort.
      }
    }
    this.#entries.clear();
    this.#reconciled.clear();
  }
}
