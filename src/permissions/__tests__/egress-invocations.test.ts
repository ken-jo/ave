import { afterEach, describe, expect, it } from "vitest";
import {
  egressInvocationAbortSignal,
  onEgressInvocationReleased,
  openEgressInvocation,
  releaseEgressInvocation,
  type EgressInvocationOwner,
} from "../egress-invocations.js";

const SHELL: EgressInvocationOwner = {
  kind: "shell", toolName: "powershell", toolUseId: undefined, requiresListener: true,
  context: { sessionId: undefined, workspaceRoot: undefined, approvalSurface: "unavailable" },
};
const unsubscribes: Array<() => void> = [];
afterEach(() => { for (const unsubscribe of unsubscribes.splice(0)) unsubscribe(); });

function observe(observer: (token: string) => void): void {
  unsubscribes.push(onEgressInvocationReleased((token) => observer(token)));
}

describe("egress invocation release", () => {
  it("runs every observer when earlier ones throw, then throws the one failure raw", () => {
    const invocation = openEgressInvocation(SHELL);
    const seen: string[] = [];
    const failure = new Error("first observer failed");
    observe((token) => { if (token === invocation.token) { seen.push("first"); throw failure; } });
    observe((token) => { if (token === invocation.token) seen.push("second"); });
    expect(() => invocation.release()).toThrow(failure);
    expect(seen).toEqual(["first", "second"]);
    // Released once: a second release is a no-op.
    expect(() => releaseEgressInvocation(invocation.token)).not.toThrow();
    expect(seen).toEqual(["first", "second"]);
  });

  it("throws every observer failure together", () => {
    const invocation = openEgressInvocation(SHELL);
    const failures = [new Error("first observer failed"), { reason: "second observer failed" }];
    for (const failure of failures) observe((token) => { if (token === invocation.token) throw failure; });
    let thrown: unknown;
    try { invocation.release(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual(failures);
  });

  it("aborts the invocation's signal at release, before any observer runs, whether or not it was opened with one", () => {
    const opener = new AbortController();
    for (const options of [{}, { abortSignal: opener.signal }]) {
      const invocation = openEgressInvocation(SHELL, options);
      const signal = egressInvocationAbortSignal(invocation.token);
      expect(signal?.aborted).toBe(false);
      const abortedWhenObserved: boolean[] = [];
      observe((token) => { if (token === invocation.token) abortedWhenObserved.push(signal?.aborted === true); });
      invocation.release();
      expect(abortedWhenObserved).toEqual([true]);
      expect(egressInvocationAbortSignal(invocation.token)).toBeUndefined();
    }
    expect(opener.signal.aborted).toBe(false);
  });

  it("follows the signal it was opened with", () => {
    const opener = new AbortController();
    const invocation = openEgressInvocation(SHELL, { abortSignal: opener.signal });
    const signal = egressInvocationAbortSignal(invocation.token);
    opener.abort();
    expect(signal?.aborted).toBe(true);
    invocation.release();
  });
});
