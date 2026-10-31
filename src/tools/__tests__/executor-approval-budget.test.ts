import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { makeMockWebContents, sentApprovalCards } from "../../__tests__/test-helpers.js";
import { captureToolApprovalWait, runWithCeiling, type ToolApprovalWait } from "../executor-ceiling.js";

describe("human approval inside executing tools", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
  afterEach(() => vi.useRealTimers());

  it("rejects an unissued waiter before it can manufacture an approval", async () => {
    const surface = makeMockWebContents();
    const gate = new ApprovalGate(surface as never);
    const forgedWaiter = vi.fn(async () => ({ requestId: "forged", choice: "allow-once" }));
    const decision = await gate.requestAndWait({
      id: "forged", category: "tool", toolName: "write_file", args: {}, reason: "Approve effect",
      createdAt: Date.now(), ownerUnattended: true, toolApprovalWait: forgedWaiter as unknown as ToolApprovalWait,
    });
    expect(decision.choice).toBe("deny-once");
    expect(forgedWaiter).not.toHaveBeenCalled();
    expect(surface.send).not.toHaveBeenCalled();
    expect(gate.pendingCount).toBe(0);
  });

  it("keeps an owner-away effect card pending beyond the execution ceiling and executes once after approval", async () => {
    const surface = makeMockWebContents();
    const gate = new ApprovalGate(surface as never);
    const effect = vi.fn();
    const handler = vi.fn(async (signal: AbortSignal) => {
      const decision = await gate.requestAndWait({
        id: "effect-card", category: "tool", toolName: "write_file", args: {}, reason: "Approve effect",
        createdAt: Date.now(), ownerUnattended: true, abortSignal: signal,
      });
      if (decision.choice === "allow-once") effect();
      return decision.choice;
    });
    let completed = false;
    const running = runWithCeiling(handler, TOOL_TIMEOUT_POLICY.globalCeilingMs, undefined, "effect-tool");
    void running.then(() => { completed = true; });
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs * 2);
    expect(completed).toBe(false);
    expect(gate.pendingCount).toBe(1);
    expect(effect).not.toHaveBeenCalled();
    const card = sentApprovalCards<ApprovalRequest>(surface)[0]!;
    gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, surface as never);
    expect(await running).toEqual({ ok: true, value: "allow-once" });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a host-captured waiter for an external transport card without serializing it", async () => {
    const surface = makeMockWebContents();
    const gate = new ApprovalGate(surface as never);
    const handlerFinished = deferred<string>();
    let waiter: ToolApprovalWait | undefined;
    const running = runWithCeiling(async () => {
      waiter = captureToolApprovalWait();
      return handlerFinished.promise;
    }, 1_000, undefined, "socket-tool");
    await vi.advanceTimersByTimeAsync(100);
    const approval = gate.requestAndWait({
      id: "socket-card", category: "tool", toolName: "bash", args: {}, reason: "Approve connection",
      createdAt: Date.now(), ownerUnattended: true, toolApprovalWait: waiter,
    });
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs * 2);
    expect(gate.pendingCount).toBe(1);
    const card = sentApprovalCards<ApprovalRequest>(surface)[0]!;
    expect(card).not.toHaveProperty("toolApprovalWait");
    gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, surface as never);
    await approval;
    handlerFinished.resolve("connection authorized");
    expect(await running).toEqual({ ok: true, value: "connection authorized" });
  });

  it("immediately aborts and removes an owner-away card when the parent stops", async () => {
    const surface = makeMockWebContents();
    const gate = new ApprovalGate(surface as never);
    const parent = new AbortController();
    const running = runWithCeiling((signal) => gate.requestAndWait({
      id: "cancelled-effect", category: "tool", toolName: "write_file", args: {}, reason: "Approve effect",
      createdAt: Date.now(), ownerUnattended: true, abortSignal: signal,
    }), 1_000, parent.signal, "cancelled-effect-tool");
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.globalCeilingMs * 2);
    expect(gate.pendingCount).toBe(1);
    parent.abort(new Error("owner stopped"));
    expect(await running).toMatchObject({ ok: false, reason: "user-abort" });
    expect(gate.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
