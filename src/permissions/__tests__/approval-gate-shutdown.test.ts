import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalGate, isHostApprovalRejectedDecision, type ApprovalRequestInput } from "../approval-gate.js";

const gates: ApprovalGate[] = [];
afterEach(() => { for (const gate of gates.splice(0)) gate.disposeAll(); });

describe("approval gate shutdown", () => {
  it("does not send a card when an admission observer shuts down the gate", async () => {
    const surface = { send: vi.fn(), isDestroyed: () => false };
    const gate = new ApprovalGate(() => surface as never);
    gates.push(gate);
    gate.observePendingApprovals({ onPending: () => gate.disposeAll(), onSettled: () => {} });
    const decision = await gate.requestAndWait({
      id: "observer-shutdown", category: "tool", toolName: "agent_spawn", args: {},
      reason: "State change", source: "builtin", createdAt: Date.now(),
    });
    expect(decision.choice).toBe("deny-once");
    expect(surface.send.mock.calls.filter(([channel]) => channel === "ave:approval:request")).toEqual([]);
    expect(gate.pendingCount).toBe(0);
  });

  it("rejects an approval that reaches the gate after shutdown has drained it", async () => {
    const surface = { send: vi.fn(), isDestroyed: () => false };
    const gate = new ApprovalGate(() => surface as never);
    gates.push(gate);
    const request: ApprovalRequestInput = {
      id: "late-background-approval", category: "tool", toolName: "agent_spawn",
      args: { title: "Child", instructions: "Perform the action" },
      reason: "State change", source: "builtin", createdAt: Date.now(),
    };
    // The background work was admitted before shutdown but reaches approval on its next continuation.
    const running = Promise.resolve().then(() => gate.requestAndWait(request));
    gate.disposeAll();
    await Promise.resolve();
    expect(gate.pendingCount).toBe(0);
    expect(surface.send).not.toHaveBeenCalled();
    const decision = await running;
    expect(decision.choice).toBe("deny-once");
    expect(isHostApprovalRejectedDecision(decision)).toBe(true);
  });
});
