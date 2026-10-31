// CDP transport over the browser-level WebSocket endpoint of a stock
// Chromium started with --remote-debugging-port.
//
// The ego-browser runtime (vendor bundle) speaks the flattened session
// protocol: every message is a JSON string with top-level `id`, `method`,
// `params` and an optional top-level `sessionId`. The browser-level
// WebSocket accepts exactly that shape, so runtime traffic is forwarded
// verbatim.
//
// The binding layer's own CDP calls use an id space starting at 2^30 so
// they can never collide with runtime message ids on the shared socket.

const BINDING_ID_BASE = 1 << 30;

export class CdpTransport {
  #ws;
  #pending = new Map();
  #nextBindingId = BINDING_ID_BASE;
  #closed = false;

  /** Callback installed by the ego bindings: (jsonString) => void */
  onRuntimeMessage = null;
  /** Callback for events the binding layer itself cares about. */
  onEvent = null;

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => this.#handleMessage(event.data));
    ws.addEventListener("close", () => {
      this.#closed = true;
      const error = new Error("CDP WebSocket closed");
      for (const { reject } of this.#pending.values()) reject(error);
      this.#pending.clear();
    });
  }

  static async connect(webSocketDebuggerUrl) {
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new CdpTransport(ws);
  }

  get closed() {
    return this.#closed;
  }

  /** Forward one runtime-originated JSON message, unchanged. */
  sendRuntimeMessage(jsonString) {
    if (process.env.EGO_DEBUG_CDP === "1") {
      try {
        const m = JSON.parse(jsonString);
        if (m.method) {
          process.stderr.write(
            `[cdp>] ${m.method} ${JSON.stringify(m.params || {}).slice(0, 160)}${m.sessionId ? ` @${m.sessionId.slice(0, 8)}` : ""}\n`,
          );
        }
      } catch {
        // Not JSON: forward anyway.
      }
    }
    this.#ws.send(jsonString);
  }

  /**
   * Binding-layer CDP call. Resolves with the `result` object, rejects with
   * an Error carrying the CDP error message when the call fails.
   */
  call(method, params = {}, sessionId = undefined) {
    if (this.#closed) {
      return Promise.reject(new Error("CDP transport is closed"));
    }
    const id = this.#nextBindingId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#ws.send(JSON.stringify(payload));
    });
  }

  #handleMessage(data) {
    const text = typeof data === "string" ? data : String(data);
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (
      typeof message.id === "number" &&
      message.id >= BINDING_ID_BASE &&
      this.#pending.has(message.id)
    ) {
      const { resolve, reject, method } = this.#pending.get(message.id);
      this.#pending.delete(message.id);
      if (message.error) {
        const error = new Error(
          `${method} failed: ${message.error.message || "CDP error"}`,
        );
        error.cdpError = message.error;
        reject(error);
      } else {
        resolve(message.result ?? {});
      }
      return;
    }
    if (
      process.env.EGO_DEBUG_CDP === "1" &&
      typeof message.id === "number" &&
      message.id < BINDING_ID_BASE
    ) {
      process.stderr.write(
        `[cdp<] id=${message.id} ${message.error ? "ERROR " + JSON.stringify(message.error).slice(0, 160) : "ok " + JSON.stringify(message.result || {}).slice(0, 200)}\n`,
      );
    }
    if (message.method && this.onEvent) {
      try {
        this.onEvent(message);
      } catch {
        // Event observers must never break transport delivery.
      }
    }
    if (this.onRuntimeMessage) {
      this.onRuntimeMessage(text);
    }
  }

  close() {
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
  }
}
