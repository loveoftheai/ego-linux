import { AsyncLocalStorage } from "node:async_hooks";
import { browserEgo, ensureSession } from "./browser-runtime.js";
import { invokeEgo } from "./ego-errors.js";
class NativeOperationGate {
  #services;
  #ownership = new AsyncLocalStorage();
  #tail = Promise.resolve();
  constructor(services) {
    if (!services || typeof services.selectSpace !== "function") {
      throw new TypeError("NativeOperationGate requires selectSpace");
    }
    if (typeof services.ensureSession !== "function") {
      throw new TypeError("NativeOperationGate requires ensureSession");
    }
    this.#services = services;
  }
  withSpace(spaceId, operation) {
    assertSpaceId(spaceId);
    if (typeof operation !== "function") {
      throw new TypeError("withSpace requires an operation function");
    }
    const ownership = this.#ownership.getStore();
    if (ownership?.active) {
      if (ownership.spaceId !== spaceId) {
        return Promise.reject(
          new Error(
            `cannot select space ${spaceId} while space ${ownership.spaceId} is active`
          )
        );
      }
      return Promise.resolve().then(() => operation({ spaceId }));
    }
    const run = async () => {
      await this.#services.selectSpace(spaceId);
      const acquired = { spaceId, active: true };
      return this.#ownership.run(acquired, async () => {
        try {
          return await operation({ spaceId });
        } finally {
          acquired.active = false;
        }
      });
    };
    const result = this.#tail.then(run);
    this.#tail = result.then(
      () => void 0,
      () => void 0
    );
    return result;
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
    return this.withSpace(page.spaceId, async () => {
      const sessionId = await this.#services.ensureSession(
        page.targetId,
        options.sessionTimeoutMs
      );
      return operation({
        spaceId: page.spaceId,
        targetId: page.targetId,
        sessionId
      });
    });
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
function withSpace(spaceId, operation) {
  return defaultGate.withSpace(spaceId, operation);
}
function withPage(page, operation, options = {}) {
  return defaultGate.withPage(page, operation, options);
}
export {
  NativeOperationGate,
  withPage,
  withSpace
};
