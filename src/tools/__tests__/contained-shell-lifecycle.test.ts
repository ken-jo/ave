import { describe, expect, it, vi } from "vitest";
import { afterQueuedCallbacks } from "../../__tests__/support/deferred.js";
import { createContainedShellLifecycle } from "../contained-shell-lifecycle.js";

function rejectable(): { promise: Promise<void>; reject: (error: unknown) => void } {
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((_resolve, fail) => { reject = fail; });
  return { promise, reject };
}

describe("contained shell lifecycle", () => {
  it("runs every disposer in reverse order and collects sync and async failures raw", async () => {
    const lifecycle = createContainedShellLifecycle();
    const order: string[] = [];
    const thrown = new Error("sync disposer failed");
    const rejected = { reason: "not an Error" };
    lifecycle.defer(() => { order.push("first"); });
    lifecycle.defer(async () => { order.push("second"); throw rejected; });
    lifecycle.defer(() => { order.push("third"); throw thrown; });
    lifecycle.defer(() => { order.push("fourth"); });
    expect(await lifecycle.dispose()).toEqual([thrown, rejected]);
    expect(order).toEqual(["fourth", "third", "second", "first"]);
  });

  it("revokes synchronously and once, and runs a revoker registered afterwards at once", () => {
    const lifecycle = createContainedShellLifecycle();
    lifecycle.jobStarted(new Promise(() => {}));
    const revoker = vi.fn();
    const disposer = vi.fn();
    lifecycle.onRevoke(revoker);
    lifecycle.defer(disposer);
    lifecycle.revoke();
    lifecycle.revoke();
    expect(lifecycle.signal.aborted).toBe(true);
    expect(revoker).toHaveBeenCalledOnce();
    expect(disposer).not.toHaveBeenCalled();
    const late = vi.fn();
    lifecycle.onRevoke(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it("begins disposal at revocation when no job has started", async () => {
    const lifecycle = createContainedShellLifecycle();
    const disposer = vi.fn();
    lifecycle.defer(disposer);
    lifecycle.revoke();
    await Promise.resolve();
    expect(disposer).toHaveBeenCalledOnce();
    expect(() => lifecycle.jobStarted(Promise.resolve())).toThrow(/after its invocation ended/);
    expect(await lifecycle.dispose()).toEqual([]);
    expect(disposer).toHaveBeenCalledOnce();
  });

  it("holds every disposer until the job exits, even when the job's exit rejects", async () => {
    const lifecycle = createContainedShellLifecycle();
    const exit = rejectable();
    const disposer = vi.fn();
    lifecycle.defer(disposer);
    lifecycle.jobStarted(exit.promise);
    const disposed = lifecycle.dispose();
    expect(lifecycle.signal.aborted).toBe(true);
    await afterQueuedCallbacks();
    expect(disposer).not.toHaveBeenCalled();
    exit.reject(new Error("job wait failed"));
    expect(await disposed).toEqual([]);
    expect(disposer).toHaveBeenCalledOnce();
  });

  it("runs a disposer registered during disposal at once and waits for it", async () => {
    const lifecycle = createContainedShellLifecycle();
    const late = rejectable();
    const failure = new Error("late disposer failed");
    lifecycle.defer(() => { lifecycle.defer(() => late.promise); });
    const disposed = lifecycle.dispose();
    let settled = false;
    void disposed.then(() => { settled = true; });
    await afterQueuedCallbacks();
    expect(settled).toBe(false);
    late.reject(failure);
    expect(await disposed).toEqual([failure]);
  });

  it("is idempotent and never rejects", async () => {
    const lifecycle = createContainedShellLifecycle();
    const failure = new Error("disposer failed");
    const disposer = vi.fn(() => { throw failure; });
    lifecycle.defer(disposer);
    const first = lifecycle.dispose();
    expect(lifecycle.dispose()).toBe(first);
    expect(await first).toEqual([failure]);
    expect(await lifecycle.dispose()).toEqual([failure]);
    expect(disposer).toHaveBeenCalledOnce();
    expect(() => lifecycle.jobStarted(Promise.resolve())).toThrow(/after its invocation ended/);
  });
});
