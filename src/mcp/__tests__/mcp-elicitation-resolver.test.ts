/** Routes elicitation through host approval; unsupported sampling and roots requests throw. */
import { describe, it, expect, vi } from "vitest";
import { answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";
import {
  createElicitationResolverFactory,
  type ElicitationApprovalGate,
} from "../mcp-elicitation-resolver.js";
import { ApprovalGate, type ApprovalChoice, type ApprovalDecision, type ApprovalRequestInput } from "../../permissions/approval-gate.js";

function gateReturning(
  choice: ApprovalChoice,
  extras: Partial<ApprovalDecision> = {},
): {
  gate: ElicitationApprovalGate;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const gate: ElicitationApprovalGate = {
    requestAndWait: answeringRequestAndWait((req: ApprovalRequestInput) => {
      calls.push(req as unknown as Record<string, unknown>);
      return { choice, ...extras };
    }),
  };
  return { gate, calls };
}

describe("createElicitationResolverFactory", () => {
  it("routes a form elicitation to the approval gate and maps allow content → accept", async () => {
    const { gate, calls } = gateReturning("allow-once", {
      elicitationContent: { date: "2026-07-01" },
    });
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("hr-server");

    const result = await resolve("q1", {
      method: "elicitation/create",
      mode: "form",
      message: "Pick a date",
      requestedSchema: { type: "object", properties: { date: { type: "string" } } },
    });

    expect(result).toEqual({ action: "accept", content: { date: "2026-07-01" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      category: "agent-action",
      kind: "agent-action",
      allowedChoices: ["allow-once", "deny-once"],
      durableApprovalRecordAllowed: false,
      toolName: "mcp:hr-server:elicitation",
      toolCategory: "meta",
      source: "mcp",
      trustOrigin: "plugin-emitted",
      reason: "Pick a date",
    });
    expect((calls[0].args as { requestedSchema?: unknown }).requestedSchema).toBeDefined();
  });

  it("maps a deny decision → decline", async () => {
    const { gate } = gateReturning("deny-once");
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("s");
    const result = await resolve("q", { method: "elicitation/create", message: "ok?" });
    expect(result).toEqual({ action: "decline" });
  });

  it("cancels on a recordless refusal", async () => {
    const gate = { requestAndWait: async (request: ApprovalRequestInput) => ({ requestId: request.id, choice: "deny-once" as const }) };
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("s");
    await expect(resolve("q", { method: "elicitation/create", message: "ok?" })).resolves.toEqual({ action: "cancel" });
  });

  it.each(["cancelled", "expired"] as const)("cancels when the gate marks the prompt %s", async (reason) => {
    const window = { isDestroyed: () => false, send: vi.fn() };
    const gate = new ApprovalGate(window as never, undefined, reason === "expired" ? 1 : 1_000);
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("s");
    const pending = resolve("q", { method: "elicitation/create", message: "ok?" });
    expect(window.send).toHaveBeenCalledWith("ave:approval:request", expect.anything());
    if (reason === "cancelled") gate.disposeAll();
    await expect(pending).resolves.toEqual({ action: "cancel" });
  });

  it("cancels durable approvals because elicitation is one-shot only", async () => {
    const { gate } = gateReturning("allow-session", {
      elicitationContent: { date: "2026-07-01" },
    });
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("hr-server");

    const result = await resolve("q1", {
      method: "elicitation/create",
      mode: "form",
      message: "Pick a date",
      requestedSchema: { type: "object", properties: { date: { type: "string" } } },
    });

    expect(result).toEqual({ action: "cancel" });
  });

  it("cancels accepted form content that is missing a required schema field", async () => {
    const { gate } = gateReturning("allow-once", {
      elicitationContent: { date: "2026-07-01" },
    });
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("hr-server");

    const result = await resolve("q1", {
      method: "elicitation/create",
      mode: "form",
      message: "Pick a date",
      requestedSchema: {
        type: "object",
        required: ["date", "count"],
        properties: { date: { type: "string" }, count: { type: "integer" } },
      },
    });

    expect(result).toEqual({ action: "cancel" });
  });

  it("cancels unsupported requestedSchema instead of accepting partial content", async () => {
    const { gate } = gateReturning("allow-once", {
      elicitationContent: { tags: ["prod"] },
    });
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("hr-server");

    const result = await resolve("q1", {
      method: "elicitation/create",
      mode: "form",
      message: "Pick tags",
      requestedSchema: { type: "object", properties: { tags: { type: "array" } } },
    });

    expect(result).toEqual({ action: "cancel" });
  });

  it("url-mode elicitation forwards the url to the gate args", async () => {
    const { gate, calls } = gateReturning("allow-once");
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("auth");
    const result = await resolve("q", {
      method: "elicitation/create",
      mode: "url",
      message: "Authorize",
      url: "https://example.com/oauth",
      elicitationId: "e1",
    });
    expect(calls[0].args).toMatchObject({ url: "https://example.com/oauth", elicitationId: "e1" });
    expect(result).toEqual({ action: "accept", content: {} });
  });

  it("throws (No-Fallback) for sampling/createMessage — deprecated upstream, not fabricated", async () => {
    const { gate } = gateReturning("allow-once");
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("s");
    await expect(
      resolve("q", { method: "sampling/createMessage", messages: [] }),
    ).rejects.toThrow(/only 'elicitation\/create' is supported/);
  });

  it("throws for roots/list (deprecated)", async () => {
    const { gate } = gateReturning("allow-once");
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("s");
    await expect(resolve("q", { method: "roots/list" })).rejects.toThrow(/No-Fallback/);
  });
});
