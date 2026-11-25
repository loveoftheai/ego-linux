import { AsyncLocalStorage } from "node:async_hooks";
import { browserEgo, ensureSession } from "./browser-runtime.js";
import { invokeEgo } from "./ego-errors.js";
class NativeOperationGate {
  #services;
  #ownership = new AsyncLocalStorage();
  #lease = null;
  #queue = [];
  constructor(services) {
    if (!services || typeof services.selectSpace !== "function") {
      throw new TypeError("NativeOperationGate requires selectSpace");
    }
    if (typeof services.ensureSession !== "function") {
      throw new TypeError("NativeOperationGate requires ensureSession");
    }
    this.#services = services;
  }
  withSpace(spaceId, operation, options = {}) {
    assertSpaceId(spaceId);
    if (typeof operation !== "function") {
      throw new TypeError("withSpace requires an operation function");
    }
    const nested = this.#nested(spaceId);
    if (nested) return nested.then(() => operation({ spaceId }));
    return this.#runInSpace(
      spaceId,
      void 0,
      options,
      () => operation({ spaceId })
    );
  }
  withPage(page, operation, options = {}) {
    if (!page || typeof page !== "object") {
      throw new TypeError("withPage requires a page target");
    }
    assertSpaceId(page.spaceId);
    if (typeof page.targetId !== "string" || page.targetId.length === 0) {
      throw new TypeError("withPage requires a non-empty targetId");
    }
    if (typeof operation !== "function") {
      throw new TypeError("withPage requires an operation function");
    }
    const inPage = async () => {
      const sessionId = await this.#services.ensureSession(
        page.targetId,
        options.sessionTimeoutMs
      );
      return operation({
        spaceId: page.spaceId,
        targetId: page.targetId,
        sessionId
      });
    };
    const nested = this.#nested(page.spaceId);
    if (nested) return nested.then(inPage);
    return this.#runInSpace(page.spaceId, page.targetId, options, inPage);
  }
  /**
   * Re-entry deliberately bypasses the queue because the outer operation owns
   * the lease. Nested callers must await same-space work in order; Promise.all
   * here would issue concurrent native requests on purpose.
   */
  #nested(spaceId) {
    const ownership = this.#ownership.getStore();
    if (!ownership?.active) return void 0;
    if (ownership.spaceId !== spaceId) {
      return Promise.reject(
        new Error(
          `cannot select space ${spaceId} while space ${ownership.spaceId} is active`
        )
      );
    }
    return Promise.resolve();
  }
  async #runInSpace(spaceId, targetId, options, operation) {
    const lease = await this.#acquire(
      spaceId,
      options.mode ?? "exclusive",
      targetId,
      options.signal
    );
    try {
      await lease.ready;
      const acquired = { spaceId, active: true };
      return await this.#ownership.run(acquired, async () => {
        try {
          return await operation();
        } finally {
          acquired.active = false;
        }
      });
    } finally {
      this.#release(lease, targetId);
    }
  }
  #acquire(spaceId, mode, targetId, signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#queue.length === 0 && this.#admits(spaceId, mode, targetId)) {
      return Promise.resolve(this.#join(spaceId, mode, targetId));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        spaceId,
        mode,
        targetId,
        signal,
        admit: resolve,
        reject
      };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#queue.indexOf(waiter);
          if (index >= 0) this.#queue.splice(index, 1);
          reject(signal.reason);
          this.#drain();
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#queue.push(waiter);
    });
  }
  /** Whether a request can hold the current lease (or start a new one). */
  #admits(spaceId, mode, targetId) {
    const lease = this.#lease;
    if (!lease) return true;
    return mode === "shared" && lease.mode === "shared" && lease.spaceId === spaceId && (targetId === void 0 || !lease.busyPages.has(targetId));
  }
  #join(spaceId, mode, targetId) {
    if (!this.#lease) {
      const ready = Promise.resolve().then(
        () => this.#services.selectSpace(spaceId)
      );
      ready.catch(() => {
      });
      this.#lease = { spaceId, mode, holders: 0, busyPages: /* @__PURE__ */ new Map(), ready };
    }
    const lease = this.#lease;
    lease.holders += 1;
    if (targetId !== void 0) {
      lease.busyPages.set(targetId, (lease.busyPages.get(targetId) ?? 0) + 1);
    }
    return lease;
  }
  #release(lease, targetId) {
    lease.holders -= 1;
    if (targetId !== void 0) {
      const busy = (lease.busyPages.get(targetId) ?? 1) - 1;
      if (busy > 0) lease.busyPages.set(targetId, busy);
      else lease.busyPages.delete(targetId);
    }
    if (lease.holders === 0 && this.#lease === lease) this.#lease = null;
    this.#drain();
  }
  /** Admit waiters in arrival order while they fit the current lease. */
  #drain() {
    while (this.#queue.length > 0) {
      const head = this.#queue[0];
      if (!this.#admits(head.spaceId, head.mode, head.targetId)) return;
      this.#queue.shift();
      if (head.onAbort) head.signal?.removeEventListener("abort", head.onAbort);
      head.admit(this.#join(head.spaceId, head.mode, head.targetId));
      if (head.mode === "exclusive") return;
    }
  }
}
function assertSpaceId(spaceId) {
  if (!Number.isInteger(spaceId) || spaceId < 0) {
    throw new TypeError("spaceId must be a non-negative integer");
  }
}
const defaultGate = new NativeOperationGate({
  async selectSpace(spaceId) {
    const ego = browserEgo();
    if (typeof ego.useTaskSpace !== "function") {
      throw new Error("withSpace requires ego.useTaskSpace");
    }
    await invokeEgo("withSpace", () => ego.useTaskSpace(spaceId));
  },
  ensureSession
});
function withSpace(spaceId, operation, options = {}) {
  return defaultGate.withSpace(spaceId, operation, options);
}
function withPage(page, operation, options = {}) {
  return defaultGate.withPage(page, operation, options);
}
export {
  NativeOperationGate,
  withPage,
  withSpace
};
