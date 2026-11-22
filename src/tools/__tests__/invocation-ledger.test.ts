import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }));
vi.mock("../../lib/logger.js", () => ({ createLogger: () => ({ error: logError }) }));

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

  const join = ledger.joinToolInvocations();
  expect(ledger.joinToolInvocations()).toBe(join);
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
  const joining = ledger.joinToolInvocations();
  await expect(failed).rejects.toThrow("handler failure");
  expect(await joining).toBe(1);
});

it("finishes draining a rejected settlement and surfaces its failure", async () => {
  const ledger = await import("../invocation-ledger.js");
  let reject!: (error: Error) => void;
  const late = new Promise<void>((_resolve, rejectPromise) => { reject = rejectPromise; });
  ledger.trackToolInvocationSettlement(late);
  ledger.sealToolInvocations();
  const joining = expect(ledger.joinToolInvocations()).rejects.toThrow("shutdown invocation audit failed");
  reject(new Error("audit unavailable"));
  await joining;
  expect(ledger.pendingToolInvocationCount()).toBe(0);
});

it("diagnoses an invocation admitted after the audit logger closed", async () => {
  const ledger = await import("../invocation-ledger.js");
  ledger.sealToolInvocations();
  await ledger.joinToolInvocations();
  ledger.markToolInvocationAuditClosed();
  const late = ledger.admitToolInvocation("late");
  expect(late.signal.aborted).toBe(true);
  expect(logError).toHaveBeenCalledWith("tool invocation admitted after audit close: %s", "late");
  late.settle();
});
