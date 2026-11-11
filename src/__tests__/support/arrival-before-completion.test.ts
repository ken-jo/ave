import { describe, expect, it } from "vitest";
import { arrivalBeforeCompletion } from "./arrival-before-completion.js";
import { deferred } from "./deferred.js";

describe("arrival before operation completion", () => {
  it("keeps an early failure observed while the caller drives another gate", async () => {
    const release = deferred<void>();
    const failure = new Error("Startup failed");
    const operation = release.promise.then(() => { throw failure; });
    const waiting = arrivalBeforeCompletion(deferred<void>().promise, operation);
    release.resolve();
    // Let rejection reporting run before attaching the assertion, as a gate-driving caller would.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(waiting).rejects.toBe(failure);
  });

  it("still observes operation failure after the arrival won the race", async () => {
    const arrived = deferred<string>();
    const release = deferred<void>();
    const failure = new Error("Operation failed after arrival");
    const operation = release.promise.then(() => { throw failure; });
    const waiting = arrivalBeforeCompletion(arrived.promise, operation);
    arrived.resolve("ready");
    await expect(waiting).resolves.toBe("ready");
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(operation).rejects.toBe(failure);
  });

  it("rejects successful completion that precedes the expected arrival", async () => {
    await expect(arrivalBeforeCompletion(deferred<void>().promise, Promise.resolve()))
      .rejects.toThrow("Operation completed before the expected arrival");
  });
});
