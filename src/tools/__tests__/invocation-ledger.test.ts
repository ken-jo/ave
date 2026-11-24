import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TerminalDenial, TerminalRowWriter } from "../invocation-ledger.js";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ error: logError }) }));
const close = vi.fn(async () => {});
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

  const join = ledger.closeToolInvocationAudit(close);
  expect(ledger.closeToolInvocationAudit(close)).toBe(join);
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
  const joining = ledger.closeToolInvocationAudit(close);
  await expect(failed).rejects.toThrow("handler failure");
  expect(await joining).toBe(1);
});

it("finishes draining a rejected settlement and surfaces its failure", async () => {
  const ledger = await import("../invocation-ledger.js");
  let reject!: (error: Error) => void;
  const late = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
  ledger.trackToolInvocationSettlement(late);
  ledger.sealToolInvocations();
  const joining = expect(ledger.closeToolInvocationAudit(close)).rejects.toThrow("shutdown invocation audit failed");
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

it("refuses an invocation admitted while the audit logger closes and fails the shutdown", async () => {
  const ledger = await import("../invocation-ledger.js");
  ledger.sealToolInvocations();
  let late: ReturnType<typeof ledger.admitToolInvocation> | undefined;
  const closing = ledger.closeToolInvocationAudit(async () => {
    late = ledger.admitToolInvocation("late");
  });
  await expect(closing).rejects.toThrow("shutdown invocation audit failed");
  expect(late?.signal.aborted).toBe(true);
  expect(ledger.pendingToolInvocationCount()).toBe(0);
  expect(logError).toHaveBeenCalledWith("tool invocation admitted after audit close: %s", "late");
  late?.settle();
});

it("commits a detached settlement that lands before the seal and joins it", async () => {
  const ledger = await import("../invocation-ledger.js");
  const settled = vi.fn(async () => {});
  const hostShutdown = vi.fn(async () => {});
  ledger.trackDetachedToolInvocation(Promise.resolve(), settled, hostShutdown);
  await Promise.resolve();
  ledger.sealToolInvocations();
  await ledger.closeToolInvocationAudit(close);
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
  await ledger.closeToolInvocationAudit(close);
  expect(close).toHaveBeenCalled();
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
  await expect(ledger.closeToolInvocationAudit(close)).rejects.toThrow("shutdown invocation audit failed");
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
  const appended: Array<Record<string, unknown>> = [];
  const logger = { appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => { appended.push(entry); return entry; }) };
  const fired: TerminalDenial[] = [];
  const lifecycle = { governed: () => false, fire: async (denial: TerminalDenial) => { fired.push(denial); } };
  const hostDenial = async (_cause: string, _detail: string, _selected: unknown, row: TerminalRowWriter) => {
    await row({ logger: logger as never, entry: ENTRY, kind: "denied" });
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
  await vi.waitFor(() => expect(appended).toHaveLength(2));
  expect(appended[0]).toMatchObject({ denyReasons: [{ reason: "user aborted turn" }, { reason: "probe" }] });
  expect(appended[1]).toMatchObject({ denyReasons: [{ reason: "host-shutdown" }, { reason: "probe" }] });
  expect(fired).toEqual([]);
  // A person's settled deny committed after the abort stays theirs: a denial, and its one event.
  const answered = new AbortController();
  const human = ledger.admitToolInvocation("human", answered.signal);
  human.terminal.hostTerminal(hostDenial, lifecycle);
  answered.abort();
  await human.terminal.commit(async (row) => { await row({ logger: logger as never, entry: ENTRY, kind: "denied", answered: true }); });
  human.settle();
  expect(appended[2]).toMatchObject({ denyReasons: [{ reason: "probe" }] });
  expect(fired.map((denial) => denial.reason)).toEqual(["probe"]);
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
  await expect(ledger.closeToolInvocationAudit(close)).resolves.toBe(0);
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

it("drains enqueued rows before the sink closes, then fences late claims", async () => {
  const ledger = await import("../invocation-ledger.js");
  const order: string[] = [];
  const parked = ledger.admitToolInvocation("parked");
  parked.terminal.hostTerminal((cause, _detail, _selected, row) => row({ entry: ENTRY, kind: "cancelled",
    logger: { appendPermissionAuditEntry: async () => { await Promise.resolve(); order.push(`row:${cause}`); return {} as never; } } }), NO_DENIAL);
  ledger.sealToolInvocations();
  const outcome = ledger.drainToolInvocationAuditForExit(async () => { await Promise.resolve(); await Promise.resolve(); order.push("close"); }, 50);
  await expect(outcome).resolves.toBe("committed");
  expect(order).toEqual(["row:host-shutdown", "close"]);
  const late = vi.fn(async () => {});
  await expect(parked.terminal.commit(late)).resolves.toBeUndefined();
  expect(late).not.toHaveBeenCalled();
  parked.settle();
});

it("leaves the claim open when a writer fails before its row, so the host writes the one row and the attempt ends failed", async () => {
  const ledger = await import("../invocation-ledger.js");
  const appended: unknown[] = [];
  const logger = { appendPermissionAuditEntry: async (entry: unknown) => { appended.push(entry); return {} as never; } };
  ledger.beginToolInvocationAuditShutdown();
  const admission = ledger.admitToolInvocation("integrity");
  const host = vi.fn((_cause: string, detail: string, _selected: unknown, row: TerminalRowWriter) =>
    row({ logger, entry: { ...ENTRY, auditId: "host", denyReasons: [{ reason: detail, source: "tool-executor" }] }, kind: "denied" }));
  admission.terminal.hostTerminal(host, NO_DENIAL);
  const integrity = new Error("answer belongs to another invocation");
  await expect(admission.terminal.commit(async () => { throw integrity; })).rejects.toBe(integrity);
  await vi.waitFor(() => expect(admission.terminal.state).toBe("failed"));
  admission.settle(integrity);
  expect(host).toHaveBeenCalledOnce();
  expect(host).toHaveBeenCalledWith("error", "the terminal row failed its integrity check: answer belongs to another invocation", undefined, expect.any(Function));
  expect(appended).toEqual([expect.objectContaining({ auditId: "host" })]);
  expect(logError).toHaveBeenCalledWith("terminal row of %s failed before it was enqueued: %s", "integrity", "answer belongs to another invocation");
  await expect(ledger.drainToolInvocationAuditForExit(close, 50)).resolves.toBe("failed");
});

it("refuses an invocation's outcome row outside its ledger and keeps the records beside it", async () => {
  const ledger = await import("../invocation-ledger.js");
  const appended: unknown[] = [];
  const logger = { appendPermissionAuditEntry: async (entry: unknown) => { appended.push(entry); return {} as never; } };
  await expect(ledger.appendToolInvocationAudit(logger, ENTRY)).rejects.toThrow("terminal row of probe must be written through its invocation's ledger");
  await ledger.appendToolInvocationAudit(logger, { ...ENTRY, decision: "ask", reason: "asked" });
  // A deny with no tool-use id is still no side record unless it is a plugin operation's.
  const { toolUseId: _id, ...untracked } = ENTRY;
  await expect(ledger.appendToolInvocationAudit(logger, untracked)).rejects.toThrow("deny row of probe is no plugin operation record");
  await ledger.appendToolInvocationAudit(logger, { ...untracked, pluginOperation: { pluginId: "probe-plugin", operation: "status", outcome: "denied" } });
  // The quit's refusal of a mode change belongs to no invocation and has its own writer.
  await ledger.appendModeChangeRefusal(logger, untracked);
  await expect(ledger.appendModeChangeRefusal(logger, ENTRY as never)).rejects.toThrow("mode change refusal of probe must belong to no invocation");
  const { denyReasons: _reasons, ...base } = ENTRY;
  const grant = { ...base, decision: "allow", directory: "/home/alice/work", directoryAllowed: true } as const;
  // An allow naming a folder is still the invocation's outcome unless it goes through the directory grant writer.
  await expect(ledger.appendToolInvocationAudit(logger, grant)).rejects.toThrow("terminal row of probe must be written through its invocation's ledger");
  await ledger.appendDirectoryGrantRecord(logger, { ...grant, grantLifetime: "session" });
  await ledger.appendDirectoryGrantRecord(logger, { ...grant, policyRule: "workspace-root" });
  await expect(ledger.appendDirectoryGrantRecord(logger, grant)).rejects.toThrow("directory grant of probe must name its folder and exactly one lifetime or policy rule");
  await expect(ledger.appendDirectoryGrantRecord(logger, { ...grant, grantLifetime: "session", policyRule: "workspace-root" })).rejects.toThrow("exactly one lifetime");
  await expect(ledger.appendDirectoryGrantRecord(logger, { ...ENTRY, directory: "/home/alice/work", directoryAllowed: true } as never)).rejects.toThrow("exactly one lifetime");
  expect(appended).toHaveLength(5);
});

it("reports a drain the sink cannot finish before the deadline", async () => {
  const ledger = await import("../invocation-ledger.js");
  const outcome = ledger.drainToolInvocationAuditForExit(() => new Promise<void>(() => {}), 50);
  await vi.advanceTimersByTimeAsync(50);
  await expect(outcome).resolves.toBe("timed-out");
});

it("reports a drain whose host row failed to commit", async () => {
  const ledger = await import("../invocation-ledger.js");
  ledger.beginToolInvocationAuditShutdown();
  const parked = ledger.admitToolInvocation("failing");
  parked.terminal.hostTerminal(async () => { throw new Error("append refused"); }, NO_DENIAL);
  await expect(ledger.drainToolInvocationAuditForExit(async () => {}, 50)).resolves.toBe("failed");
  parked.settle();
});

it.each([false, true])("fires one denial for every denied row it commits, from any source, none for a cancellation, none if governed (governed: %s)", async (governed) => {
  const ledger = await import("../invocation-ledger.js");
  const fired: string[] = [];
  const lifecycle = { governed: () => governed, fire: async (denial: TerminalDenial) => { fired.push(`${denial.event}:${denial.reason}`); } };
  const appended: string[] = [];
  const logger = { appendPermissionAuditEntry: async (entry: { auditId: string }) => { appended.push(entry.auditId); return {} as never; } };
  const deny = (auditId: string) => ({ ...ENTRY, auditId, denyReasons: [{ reason: auditId, source: "tool-executor" }] });
  const { denyReasons: _reasons, ...base } = ENTRY;
  const admit = (tool: string) => {
    const admission = ledger.admitToolInvocation(tool);
    // The host's error is its denial; its quit or a user abort is a cancellation.
    admission.terminal.hostTerminal((cause, _detail, _selected, row) => row({ logger, entry: deny(`host:${cause}`),
      kind: cause === "error" ? "denied" : "cancelled" }), lifecycle);
    return admission;
  };
  for (const [source, kind] of [["rule", "denied"], ["human", "denied"], ["hook-mutation", "denied"], ["user-abort", "cancelled"]] as const) {
    const admission = admit(source);
    await admission.terminal.commit(async (row) => { await row({ logger, entry: deny(source), kind }); });
    admission.settle();
  }
  const allowed = admit("allowed");
  await allowed.terminal.commit(async (row) => { await row({ logger, entry: { ...base, decision: "allow", auditId: "allow" } }); });
  allowed.settle();
  admit("host").settle(new Error("boom"));
  const integrity = admit("integrity");
  await integrity.terminal.commit(async () => { throw new Error("record of another invocation"); }).catch(() => undefined);
  integrity.settle();
  const parked = admit("deadline");
  await expect(ledger.drainToolInvocationAuditForExit(close, 50)).resolves.toBe("committed");
  await expect(parked.terminal.commit(async (row) => { await row({ logger, entry: deny("late"), kind: "denied" }); })).resolves.toBeUndefined();
  parked.settle();
  expect(appended).toEqual(["rule", "human", "hook-mutation", "user-abort", "allow", "host:error", "host:error", "host:host-shutdown"]);
  expect(fired).toEqual(governed ? [] : ["rule", "human", "hook-mutation", "host:error", "host:error"].map((reason) => `PermissionDenied:${reason}`));
});
