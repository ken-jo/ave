import { describe, expect, it, vi } from "vitest";
import { answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";
import { ApprovalGate } from "../approval-gate.js";
import { buildSingleFlightAgentActionApprover } from "../agent-action-approver.js";

const REQUEST = {
  toolName: "a2a.send-message",
  args: { profile: "worker", secret: "must-not-enter-diagnostics" },
  reason: "Allow the external agent to start work?",
  trustOrigin: "local-api",
} as const;

function gate(requestAndWait: ReturnType<typeof vi.fn>): Pick<ApprovalGate, "requestAndWait"> {
  return { requestAndWait } as unknown as Pick<ApprovalGate, "requestAndWait">;
}

describe("single-flight agent-action approver", () => {
  it("returns undefined without an ApprovalGate", () => {
    expect(buildSingleFlightAgentActionApprover(undefined)).toBeUndefined();
  });

  it("builds a host-constrained one-shot request for an external action", async () => {
    const requestAndWait = answeringRequestAndWait(() => ({
      choice: "allow-once",
      rememberPattern: "ignored",
    }));
    const approve = buildSingleFlightAgentActionApprover(gate(requestAndWait))!;

    const first = await approve(REQUEST);
    const second = await approve(REQUEST);
    expect(first).toMatchObject({ approved: true, decisionId: requestAndWait.mock.calls[0]?.[0].id, decidedAt: expect.any(String) });
    expect(second).toMatchObject({ approved: true, decisionId: requestAndWait.mock.calls[1]?.[0].id, decidedAt: expect.any(String) });

    expect(requestAndWait).toHaveBeenCalledTimes(2);
    expect(requestAndWait).toHaveBeenNthCalledWith(1, expect.objectContaining({
      category: "agent-action",
      kind: "agent-action",
      allowedChoices: ["allow-once", "deny-once"],
      durableApprovalRecordAllowed: false,
      toolName: REQUEST.toolName,
      toolCategory: "meta",
      args: REQUEST.args,
      reason: REQUEST.reason,
      source: "builtin",
      trustOrigin: REQUEST.trustOrigin,
      id: expect.any(String),
      createdAt: expect.any(Number),
    }));
    expect(requestAndWait.mock.calls[0]![0]).not.toHaveProperty("requireExplicit");
  });

  it.each(["denied", "rejected", "expired", "unavailable", "cancelled"] as const)("preserves the %s approval outcome", async (outcome) => {
    const surface = { isDestroyed: () => false, send: vi.fn() };
    const realGate = new ApprovalGate(outcome === "unavailable" ? null : surface as never, undefined, 10);
    const requestAndWait = outcome === "denied" ? answeringRequestAndWait(() => ({ choice: "deny-once" }))
      : outcome === "rejected" ? vi.fn(async ({ id }: { id: string }) => ({ requestId: id, choice: "deny-once" as const }))
      : undefined;
    const approve = buildSingleFlightAgentActionApprover(requestAndWait ? gate(requestAndWait) : realGate);
    const pending = approve?.(REQUEST);
    if (outcome === "cancelled") {
      await vi.waitFor(() => expect(realGate.pendingCount).toBe(1));
      realGate.disposeAll();
    }
    await expect(pending).resolves.toMatchObject({ approved: false, outcome });
  });

  it("refuses an allow without a receipt bound to its request", async () => {
    const raw = vi.fn(async ({ id }: { id: string }) => ({ requestId: id, choice: "allow-once" as const }));
    const replay = answeringRequestAndWait(() => ({ requestId: "another-request", choice: "allow-once" }));
    for (const requestAndWait of [raw, replay]) {
      const approve = buildSingleFlightAgentActionApprover(gate(requestAndWait));
      await expect(approve?.(REQUEST)).resolves.toMatchObject({ approved: false, outcome: "rejected" });
    }
  });

  it.each([
    ["local-api", "allow-session"],
    ["cli", "allow-always"],
    ["a2a-remote-wire", "allow-session"],
    ["platform-bridge", "allow-always"],
  ] as const)("fails closed when %s receives a non-one-shot %s response", async (trustOrigin, choice) => {
    const requestAndWait = answeringRequestAndWait(() => ({ choice }));
    const approve = buildSingleFlightAgentActionApprover(gate(requestAndWait))!;

    await expect(approve({ ...REQUEST, trustOrigin })).resolves.toEqual({ approved: false, outcome: "rejected" });
  });

  it("single-flights attention prompts and exposes only safe diagnostic identity", async () => {
    let release!: () => void;
    const decision = new Promise<{ choice: "allow-once" }>((resolve) => {
      release = () => resolve({ choice: "allow-once" });
    });
    const requestAndWait = answeringRequestAndWait(() => decision);
    const onConcurrent = vi.fn(() => {
      throw new Error("diagnostic failed");
    });
    const approve = buildSingleFlightAgentActionApprover(
      gate(requestAndWait),
      { onConcurrent },
    )!;

    const first = approve(REQUEST);
    await Promise.resolve();
    await expect(approve({ ...REQUEST, args: { secret: "second-secret" } }))
      .resolves.toEqual({ approved: false, outcome: "concurrent" });

    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(onConcurrent).toHaveBeenCalledWith({
      toolName: REQUEST.toolName,
      trustOrigin: REQUEST.trustOrigin,
    });
    expect(JSON.stringify(onConcurrent.mock.calls)).not.toContain("secret");

    release();
    await expect(first).resolves.toMatchObject({ approved: true, decisionId: requestAndWait.mock.calls[0]?.[0].id, decidedAt: expect.any(String) });
  });

  it("fails closed on a gate error and releases the single-flight guard", async () => {
    const requestAndWait = answeringRequestAndWait(() => ({ choice: "allow-once" }))
      .mockRejectedValueOnce(new Error("must-not-enter-diagnostics"));
    const onError = vi.fn(() => {
      throw new Error("diagnostic failed");
    });
    const approve = buildSingleFlightAgentActionApprover(
      gate(requestAndWait),
      { onError },
    )!;

    await expect(approve(REQUEST)).resolves.toEqual({ approved: false, outcome: "rejected" });
    const next = await approve(REQUEST);
    expect(next).toMatchObject({ approved: true, decisionId: requestAndWait.mock.calls[1]?.[0].id, decidedAt: expect.any(String) });

    expect(requestAndWait).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith({
      toolName: REQUEST.toolName,
      trustOrigin: REQUEST.trustOrigin,
    });
  });
});
