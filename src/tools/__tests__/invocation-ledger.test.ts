import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TerminalDenial, TerminalRowWriter } from "../invocation-ledger.js";

const { logError, logInfo } = vi.hoisted(() => ({ logError: vi.fn(), logInfo: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ error: logError, info: logInfo }) }));
const events = () => logInfo.mock.calls.map(([entry]) => entry);
const ENTRY = { decision: "deny", ts: "2026-11-24T00:00:00.000Z", auditId: "row", tool: "probe", source: "builtin",
  category: "meta", trustOrigin: "unknown", toolUseId: "tu-probe", denyReasons: [{ reason: "probe", source: "host" }] } as const;
// The writer is called before the first await, as the audit writer does.
const rowOf = <T>(value?: T) => async (row: TerminalRowWriter) => { await row({ entry: ENTRY, kind: "denied" }); return value; };
const hostRow = async (_cause: string, _detail: string, _selected: unknown, row: TerminalRowWriter) => { await row({ entry: ENTRY, kind: "cancelled" }); };
const NO_DENIAL = { governed: () => false, fire: async () => {} };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  logError.mockClear();
  logInfo.mockReset();
});

afterEach(() => {
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it("aborts current and later admissions and joins work admitted during the drain", async () => {
  const ledger = await import("../invocation-ledger.js");
  const { isHostExitAbort } = await import("../../shared/host-exit-abort.js");
  const parent = new AbortController();
  const first = ledger.admitToolInvocation("first", parent.signal);
  const stopped = ledger.admitToolInvocation("stopped", parent.signal);
  const stop = new Error("owner stopped");
  parent.abort(stop);
  expect(stopped.signal.reason).toBe(stop);
  stopped.settle();

  const tracked = ledger.admitToolInvocation("tracked");
  ledger.sealToolInvocations();
  expect(isHostExitAbort(tracked.signal.reason)).toBe(true);
  const shutdown = tracked.signal.reason;
  ledger.sealToolInvocations();
  expect(tracked.signal.reason).toBe(shutdown);

  const join = ledger.closeToolInvocations();
  expect(ledger.closeToolInvocations()).toBe(join);
  const later = ledger.admitToolInvocation("later");
  expect(later.signal.reason).toBe(shutdown);
  first.settle();
  tracked.settle();
  expect(ledger.pendingToolInvocationCount()).toBe(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  later.settle();
  expect(await join).toBe(3);
  expect(ledger.pendingToolInvocationCount()).toBe(0);
});

it("settles ordinary rejected invocations without treating them as audit failures", async () => {
  const ledger = await import("../invocation-ledger.js");
  const admission = ledger.admitToolInvocation("ordinary");
  const failed = Promise.reject(new Error("handler failure")).finally(admission.settle);
  ledger.sealToolInvocations();
  const joining = ledger.closeToolInvocations();
  await expect(failed).rejects.toThrow("handler failure");
  expect(await joining).toBe(1);
});

it("finishes draining a rejected settlement and surfaces its failure", async () => {
  const ledger = await import("../invocation-ledger.js");
  let reject!: (error: Error) => void;
  const late = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
  ledger.trackToolInvocationSettlement(late);
  ledger.sealToolInvocations();
  const joining = expect(ledger.closeToolInvocations()).rejects.toThrow("shutdown invocation drain failed");
  reject(new Error("audit unavailable"));
  await joining;
  expect(ledger.pendingToolInvocationCount()).toBe(0);
});

it("registers nothing when the linked signal cannot be built", async () => {
  const ledger = await import("../invocation-ledger.js");
  expect(() => ledger.admitToolInvocation("invalid", {} as AbortSignal)).toThrow(TypeError);
  expect(ledger.pendingToolInvocationCount()).toBe(0);
});

it("keeps other admissions pending when one settles repeatedly", async () => {
  const ledger = await import("../invocation-ledger.js");
  const first = ledger.admitToolInvocation("first");
  const second = ledger.admitToolInvocation("second");
  first.settle();
  first.settle();
  expect(ledger.pendingToolInvocationCount()).toBe(1);
  second.settle();
  second.settle();
  expect(ledger.pendingToolInvocationCount()).toBe(0);
});

it("fences late admissions after shutdown drains", async () => {
  const ledger = await import("../invocation-ledger.js");
  ledger.sealToolInvocations();
  await expect(ledger.closeToolInvocations()).resolves.toBe(0);
  expect(ledger.admitToolInvocationWhileOpen("late")).toBeUndefined();
  expect(ledger.pendingToolInvocationCount()).toBe(0);
});

it("commits a detached settlement that lands before the seal and joins it", async () => {
  const ledger = await import("../invocation-ledger.js");
  const settled = vi.fn(async () => {});
  const hostShutdown = vi.fn(async () => {});
  ledger.trackDetachedToolInvocation(Promise.resolve(), settled, hostShutdown);
  await Promise.resolve();
  ledger.sealToolInvocations();
  await ledger.closeToolInvocations();
  expect(settled).toHaveBeenCalledOnce();
  expect(hostShutdown).not.toHaveBeenCalled();
});

it.each(["before", "after"] as const)("closes work detached %s the seal once and refuses its late commit", async (when) => {
  const ledger = await import("../invocation-ledger.js");
  let finish!: () => void;
  const settlement = new Promise<void>((resolve) => { finish = resolve; });
  const settled = vi.fn(async () => {});
  const hostShutdown = vi.fn(async () => {});
  if (when === "after") ledger.sealToolInvocations();
  ledger.trackDetachedToolInvocation(settlement, settled, hostShutdown);
  expect(ledger.pendingToolInvocationCount()).toBe(1);
  ledger.sealToolInvocations();
  ledger.sealToolInvocations();
  expect(hostShutdown).toHaveBeenCalledOnce();
  await ledger.closeToolInvocations();
  expect(ledger.pendingToolInvocationCount()).toBe(0);
  finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).not.toHaveBeenCalled();
  expect(hostShutdown).toHaveBeenCalledOnce();
});

it("fails the shutdown when the host-shutdown row of detached work cannot be written", async () => {
  const ledger = await import("../invocation-ledger.js");
  ledger.trackDetachedToolInvocation(new Promise<void>(() => {}), async () => {}, async () => { throw new Error("audit unavailable"); });
  ledger.sealToolInvocations();
  await expect(ledger.closeToolInvocations()).rejects.toThrow("shutdown invocation drain failed");
  expect(logError).toHaveBeenCalled();
});

it("claims an attempt's terminal row exactly once and refuses a second claim as an error", async () => {
  const ledger = await import("../invocation-ledger.js");
  const admission = ledger.admitToolInvocation("once");
  const first = vi.fn(rowOf("row"));
  const second = vi.fn(rowOf("row"));
  const written = admission.terminal.commit(first);
  // The claim is the synchronous enqueue: the state moved before any await.
  expect(admission.terminal.state).toBe("enqueued");
  expect(first).toHaveBeenCalledOnce();
  await expect(written).resolves.toBe("row");
  expect(admission.terminal.state).toBe("committed");
  await expect(admission.terminal.commit(second)).resolves.toBeUndefined();
  expect(second).not.toHaveBeenCalled();
  expect(logError).toHaveBeenCalledWith("%s", "terminal row of once claimed twice");
  admission.settle();
});

it("records a deny committed after the invocation's abort as a cancellation, unless a person answered it", async () => {
  const ledger = await import("../invocation-ledger.js");
  const { HostExitAbortError } = await import("../../shared/host-exit-abort.js");
  const fired: TerminalDenial[] = [];
  const lifecycle = { governed: () => false, fire: async (denial: TerminalDenial) => { fired.push(denial); } };
  const hostDenial = async (_cause: string, _detail: string, _selected: unknown, row: TerminalRowWriter) => {
    await row({ entry: ENTRY, kind: "denied" });
  };
  // An AbortError the invocation let escape reaches settle(failure), whose host row is the host's denial.
  const stop = new AbortController();
  const stopped = ledger.admitToolInvocation("stopped", stop.signal);
  stopped.terminal.hostTerminal(hostDenial, lifecycle);
  stop.abort();
  stopped.settle(new DOMException("This operation was aborted", "AbortError"));
  const quit = new AbortController();
  const quitting = ledger.admitToolInvocation("quitting", quit.signal);
  quitting.terminal.hostTerminal(hostDenial, lifecycle);
  quit.abort(new HostExitAbortError());
  quitting.settle(new DOMException("This operation was aborted", "AbortError"));
  await vi.waitFor(() => expect(events()).toHaveLength(2));
  expect(events()[0]).toMatchObject({ terminalKind: "cancelled" });
  expect(events()[1]).toMatchObject({ terminalKind: "cancelled" });
  expect(fired).toEqual([]);
  // A person's settled deny committed after the abort stays theirs: a denial, and its one event.
  const answered = new AbortController();
  const human = ledger.admitToolInvocation("human", answered.signal);
  human.terminal.hostTerminal(hostDenial, lifecycle);
  answered.abort();
  await human.terminal.commit(async (row) => { await row({ entry: ENTRY, kind: "denied", humanAnswered: true }); });
  human.settle();
  expect(events()[2]).toMatchObject({ terminalKind: "denied" });
  expect(fired.map((denial) => denial.reason)).toEqual(["probe"]);
});

it.each([
  [undefined, false], ["refused", false], [undefined, true],
] as const)("refuses a deny row whose kind is %s (aborted %s) as an integrity failure; the host writes the one denial", async (kind, aborted) => {
  const ledger = await import("../invocation-ledger.js");
  const fired: TerminalDenial[] = [];
  const write = vi.fn(async (_cause: string, _detail: string, _selected: unknown, row: TerminalRowWriter) => {
    await row({ entry: ENTRY, kind: "denied" });
  });
  // An abort before the refusal leaves the host's integrity row a denial: it is the host's own refusal, not the abort's.
  const stop = new AbortController();
  if (aborted) stop.abort();
  const admission = ledger.admitToolInvocation("kindless", stop.signal);
  admission.terminal.hostTerminal(write, { governed: () => false, fire: async (denial) => { fired.push(denial); } });
  const written = admission.terminal.commit(async (row) => {
    await row({ entry: ENTRY, kind } as never);
  });
  await expect(written).rejects.toThrow("deny row of kindless names no terminal kind");
  admission.settle(new Error("late"));
  await vi.waitFor(() => expect(admission.terminal.state).toBe("failed"));
  expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith("error", "the terminal row failed its integrity check: deny row of kindless names no terminal kind", undefined, expect.any(Function));
  expect(events()).toHaveLength(1);
  expect(events()[0]).toMatchObject({ terminalKind: "denied" });
  expect(fired).toHaveLength(1);
});

it("records a pre-enqueue writer failure after Stop as one host integrity denial", async () => {
  const ledger = await import("../invocation-ledger.js");
  const fire = vi.fn(async (_denial: TerminalDenial) => {});
  const stop = new AbortController();
  const admission = ledger.admitToolInvocation("integrity", stop.signal);
  const write = vi.fn((_cause: string, detail: string, _selected: unknown, row: TerminalRowWriter) =>
    row({ entry: { ...ENTRY, denyReasons: [{ reason: detail, source: "tool-executor" }] }, kind: "denied" }));
  admission.terminal.hostTerminal(write, { governed: () => false, fire });
  admission.terminal.select("selected outcome");
  stop.abort();

  const failure = new Error("terminal audit metadata unavailable");
  await expect(admission.terminal.commit(() => { throw failure; })).rejects.toBe(failure);
  admission.settle(failure);
  await vi.waitFor(() => expect(admission.terminal.state).toBe("failed"));
  const reason = "the terminal row failed its integrity check: terminal audit metadata unavailable";
  expect(write).toHaveBeenCalledExactlyOnceWith("error", reason, undefined, expect.any(Function));
  expect(events()).toEqual([expect.objectContaining({ terminalKind: "denied" })]);
  expect(fire.mock.calls.map(([denial]) => denial.reason)).toEqual([reason]);
});

it("gives an attempt the host's row only while it is unclaimed, keeping a selected outcome", async () => {
  const ledger = await import("../invocation-ledger.js");
  const write = vi.fn(hostRow);
  const unclaimed = ledger.admitToolInvocation("unclaimed");
  unclaimed.terminal.hostTerminal(write, NO_DENIAL);
  unclaimed.terminal.select("accepted deny");
  const claimed = ledger.admitToolInvocation("claimed");
  claimed.terminal.hostTerminal(write, NO_DENIAL);
  await claimed.terminal.commit(rowOf());
  unclaimed.settle(new Error("boom"));
  claimed.settle(new Error("boom"));
  expect(write).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledWith("error", "the invocation failed: boom", "accepted deny", expect.any(Function));
});

it("moves ownership to a suspended rationale card and back at its sealed start", async () => {
  const ledger = await import("../invocation-ledger.js");
  const write = vi.fn(hostRow);
  const first = ledger.admitToolInvocation("held");
  first.terminal.hostTerminal(write, NO_DENIAL);
  first.suspend("tu-held");
  first.settle();
  expect(write).not.toHaveBeenCalled();
  expect(first.terminal.owner).toBe("rationale");
  const resumed = ledger.admitToolInvocation("held", undefined, "tu-held");
  expect(resumed.terminal.owner).toBe("invocation");
  expect(resumed.terminal.state).toBe("open");
  await resumed.terminal.commit(rowOf());
  resumed.settle();
  expect(write).not.toHaveBeenCalled();
});

it("ends a suspended attempt with the host's row when its card is stopped or the host quits", async () => {
  const ledger = await import("../invocation-ledger.js");
  const parent = new AbortController();
  const write = vi.fn(hostRow);
  const stopped = ledger.admitToolInvocation("stopped", parent.signal);
  stopped.terminal.hostTerminal(write, NO_DENIAL);
  stopped.suspend("tu-stopped");
  stopped.settle();
  const quit = ledger.admitToolInvocation("quit");
  quit.terminal.hostTerminal(write, NO_DENIAL);
  quit.suspend("tu-quit");
  quit.settle();
  parent.abort();
  ledger.sealToolInvocations();
  await expect(ledger.closeToolInvocations()).resolves.toBe(0);
  expect(write.mock.calls.map(([cause]) => cause)).toEqual(["user-abort", "host-shutdown"]);
  // The late sealed start adopts an attempt whose row is already written.
  expect(stopped.terminal.state).toBe("committed");
});

it("gives a sandbox retry its own attempt only after the first attempt's row", async () => {
  const ledger = await import("../invocation-ledger.js");
  const admission = ledger.admitToolInvocation("retry");
  expect(() => admission.terminal.nextAttempt()).toThrow("attempt 1 of retry has no terminal row yet");
  await admission.terminal.commit(rowOf());
  const retry = admission.terminal.nextAttempt();
  expect(retry.attempt).toBe(2);
  expect(retry.state).toBe("open");
  await retry.commit(rowOf());
  admission.settle();
});

it("drains the parked terminal decision and fences late claims", async () => {
  const ledger = await import("../invocation-ledger.js");
  const parked = ledger.admitToolInvocation("parked");
  parked.terminal.hostTerminal(hostRow, NO_DENIAL);
  ledger.sealToolInvocations();
  await expect(ledger.drainToolInvocationsForExit(50)).resolves.toBe("committed");
  expect(events()).toEqual([expect.objectContaining({ event: "permission_decision", terminalKind: "cancelled" })]);
  const late = vi.fn(async () => {});
  await expect(parked.terminal.commit(late)).resolves.toBeUndefined();
  expect(late).not.toHaveBeenCalled();
  parked.settle();
});

it("leaves the claim open when a writer fails before its row, so the host writes the one row and the attempt ends failed", async () => {
  const ledger = await import("../invocation-ledger.js");
  ledger.beginToolInvocationShutdown();
  const admission = ledger.admitToolInvocation("integrity");
  const host = vi.fn((_cause: string, detail: string, _selected: unknown, row: TerminalRowWriter) =>
    row({ entry: { ...ENTRY, auditId: "host", denyReasons: [{ reason: detail, source: "tool-executor" }] }, kind: "denied" }));
  admission.terminal.hostTerminal(host, NO_DENIAL);
  const integrity = new Error("answer belongs to another invocation");
  await expect(admission.terminal.commit(async () => { throw integrity; })).rejects.toBe(integrity);
  await vi.waitFor(() => expect(admission.terminal.state).toBe("failed"));
  admission.settle(integrity);
  expect(host).toHaveBeenCalledOnce();
  expect(host).toHaveBeenCalledWith("error", "the terminal row failed its integrity check: answer belongs to another invocation", undefined, expect.any(Function));
  expect(events()).toEqual([expect.objectContaining({ terminalKind: "denied" })]);
  expect(logError).toHaveBeenCalledWith("terminal row of %s failed before it was enqueued: %s", "integrity", "answer belongs to another invocation");
  await expect(ledger.drainToolInvocationsForExit(50)).resolves.toBe("failed");
});

it("commits a forced terminal row while the denial hook is still pending", async () => {
  const ledger = await import("../invocation-ledger.js");
  const parked = ledger.admitToolInvocation("holding");
  const fire = vi.fn(() => new Promise(() => {}));
  parked.terminal.hostTerminal(async (_cause, _detail, _selected, row) => {
    await row({ entry: ENTRY, kind: "denied", humanAnswered: true });
  }, { governed: () => false, fire });
  const outcome = ledger.drainToolInvocationsForExit(50);
  await vi.advanceTimersByTimeAsync(50);
  await expect(outcome).resolves.toBe("committed");
  expect(fire).toHaveBeenCalledOnce();
  expect(events()).toEqual([expect.objectContaining({ event: "permission_decision", terminalKind: "denied" })]);
});

it("reports a drain whose host row failed to commit", async () => {
  const ledger = await import("../invocation-ledger.js");
  ledger.beginToolInvocationShutdown();
  const parked = ledger.admitToolInvocation("failing");
  parked.terminal.hostTerminal(async () => { throw new Error("append refused"); }, NO_DENIAL);
  await expect(ledger.drainToolInvocationsForExit(50)).resolves.toBe("failed");
  parked.settle();
});

it.each([false, true])("fires one denial for every denied row it commits, from any source, none for a cancellation, none if governed (governed: %s)", async (governed) => {
  const ledger = await import("../invocation-ledger.js");
  const fired: string[] = [];
  const lifecycle = { governed: () => governed, fire: async (denial: TerminalDenial) => { fired.push(`${denial.event}:${denial.reason}`); } };
  const deny = (auditId: string) => ({ ...ENTRY, auditId, denyReasons: [{ reason: auditId, source: "tool-executor" }] });
  const { denyReasons: _reasons, ...base } = ENTRY;
  const admit = (tool: string) => {
    const admission = ledger.admitToolInvocation(tool);
    // The host's error is its denial; its quit or a user abort is a cancellation.
    admission.terminal.hostTerminal((cause, _detail, _selected, row) => row({ entry: deny(`host:${cause}`),
      kind: cause === "error" ? "denied" : "cancelled" }), lifecycle);
    return admission;
  };
  for (const [source, kind] of [["rule", "denied"], ["human", "denied"], ["hook-mutation", "denied"], ["user-abort", "cancelled"]] as const) {
    const admission = admit(source);
    await admission.terminal.commit(async (row) => { await row({ entry: deny(source), kind }); });
    admission.settle();
  }
  const allowed = admit("allowed");
  await allowed.terminal.commit(async (row) => { await row({ entry: { ...base, decision: "allow", auditId: "allow" } }); });
  allowed.settle();
  admit("host").settle(new Error("boom"));
  const integrity = admit("integrity");
  await integrity.terminal.commit(async () => { throw new Error("record of another invocation"); }).catch(() => undefined);
  integrity.settle();
  const parked = admit("deadline");
  await expect(ledger.drainToolInvocationsForExit(50)).resolves.toBe("committed");
  await expect(parked.terminal.commit(async (row) => { await row({ entry: deny("late"), kind: "denied" }); })).resolves.toBeUndefined();
  parked.settle();
  expect(events().map((entry) => entry.terminalKind ?? entry.decision)).toEqual(["denied", "denied", "denied", "cancelled", "allow", "denied", "denied", "cancelled"]);
  expect(fired).toEqual(governed ? [] : ["rule", "human", "hook-mutation", "host:error", "host:error"].map((reason) => `PermissionDenied:${reason}`));
});
