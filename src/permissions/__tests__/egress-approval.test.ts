/**
 * The egress ask on the approval dock: the `egress-host` request shape the
 * gate accepts, the answers it honours (desktop window, allow-once, a scope
 * the card offered) and how the requester maps them back (egress-approval.ts).
 */
import { describe, expect, it, vi } from "vitest";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput } from "../approval-gate.js";
import { createApprovalGateEgressRequester, EGRESS_APPROVAL_DENY_REASONS } from "../egress-approval.js";
import type { EgressApprovalRequest } from "../egress-ask.js";
import { sentApprovalCards } from "../../__tests__/test-helpers.js";

function makeWebContents() {
  return { send: vi.fn(), isDestroyed: vi.fn(() => false) };
}

function makeGate() {
  const wc = makeWebContents();
  const auditLogger = { log: vi.fn() };
  const gate = new ApprovalGate(wc as never, undefined, 5_000, auditLogger as never);
  return { wc, gate, auditLogger };
}

const egressRequest = (overrides: Partial<EgressApprovalRequest> = {}): EgressApprovalRequest => ({
  sessionId: "session-1",
  toolName: "bash",
  toolUseId: "toolu_1",
  destination: { host: "github.com", port: 443 },
  scopes: ["once", "conversation", "workspace", "always"],
  abortSignal: undefined,
  ...overrides,
});

function lastCard(wc: ReturnType<typeof makeWebContents>): ApprovalRequest {
  const cards = sentApprovalCards<ApprovalRequest>(wc);
  const card = cards.at(-1);
  if (card === undefined) throw new Error("no approval card was sent");
  return card;
}

async function cardSent(wc: ReturnType<typeof makeWebContents>): Promise<ApprovalRequest> {
  await vi.waitFor(() => expect(sentApprovalCards(wc).length).toBeGreaterThan(0));
  return lastCard(wc);
}

describe("egress-host approval requests", () => {
  it("sends the card with the destination and the offered scopes, as the gate's egress-host card", async () => {
    const { wc, gate } = makeGate();
    const answer = createApprovalGateEgressRequester(gate)(egressRequest());
    const card = await cardSent(wc);
    expect(card).toMatchObject({
      kind: "egress-host",
      category: "tool",
      toolName: "bash",
      args: { host: "github.com", port: 443 },
      allowedChoices: ["allow-once", "deny-once"],
      egressHost: { host: "github.com", port: 443, scopes: ["once", "conversation", "workspace", "always"] },
      sessionId: "session-1",
    });
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-once", egressScope: "workspace", nonce: card.nonce, hmac: card.hmac,
    });
    await expect(answer).resolves.toEqual({ allow: true, scope: "workspace" });
  });

  it("denies when the person denies", async () => {
    const { wc, gate } = makeGate();
    const answer = createApprovalGateEgressRequester(gate)(egressRequest());
    const card = await cardSent(wc);
    gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac });
    await expect(answer).resolves.toEqual({ allow: false, reason: EGRESS_APPROVAL_DENY_REASONS.denied });
  });

  it("refuses an allow with a scope the card did not offer, without one, or from outside the desktop window", async () => {
    for (const [scope, fromDesktop] of [["always", true], [undefined, true], ["once", false]] as const) {
      const { wc, gate, auditLogger } = makeGate();
      const answer = createApprovalGateEgressRequester(gate)(egressRequest({ scopes: ["once", "conversation"] }));
      const card = await cardSent(wc);
      const decision = {
        requestId: card.id,
        choice: "allow-once" as const,
        ...(scope === undefined ? {} : { egressScope: scope }),
        nonce: card.nonce,
        hmac: card.hmac,
      };
      if (fromDesktop) gate.resolveFromDesktopRenderer(card.id, decision);
      else gate.resolve(card.id, decision);
      await expect(answer).resolves.toEqual({ allow: false, reason: EGRESS_APPROVAL_DENY_REASONS.rejected });
      const rows = auditLogger.log.mock.calls.map(([row]) => String((row as { output?: string }).output ?? ""));
      expect(rows.some((row) => row.startsWith(`[approval:egress-scope-rejected] ${card.id}`))).toBe(true);
    }
  });

  it("refuses allow-session even with an offered scope", async () => {
    const { wc, gate } = makeGate();
    const answer = createApprovalGateEgressRequester(gate)(egressRequest());
    const card = await cardSent(wc);
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, choice: "allow-session", egressScope: "conversation", nonce: card.nonce, hmac: card.hmac,
    });
    await expect(answer).resolves.toMatchObject({ allow: false });
  });

  it("ends the ask when the call is aborted", async () => {
    const { wc, gate } = makeGate();
    const controller = new AbortController();
    const answer = createApprovalGateEgressRequester(gate)(egressRequest({ abortSignal: controller.signal }));
    await cardSent(wc);
    controller.abort();
    await expect(answer).resolves.toMatchObject({ allow: false });
  });

  it("rejects a malformed egress-host request outright", async () => {
    const { gate } = makeGate();
    const base: ApprovalRequestInput = {
      id: "egress-bad",
      category: "tool",
      kind: "egress-host",
      toolName: "bash",
      args: { host: "github.com", port: 443 },
      reason: "test",
      createdAt: Date.now(),
      allowedChoices: ["allow-once", "deny-once"],
      durableApprovalRecordAllowed: false,
      forceExplicit: true,
      isReadOnly: false,
      egressHost: { host: "github.com", port: 443, scopes: ["once"] },
    };
    await expect(gate.requestAndWait({ ...base, egressHost: undefined })).rejects.toThrow(/needs egressHost/u);
    await expect(gate.requestAndWait({ ...base, egressHost: { host: "github.com", port: 443, scopes: [] } }))
      .rejects.toThrow(/needs egressHost/u);
    await expect(gate.requestAndWait({ ...base, allowedChoices: ["allow-once", "allow-always", "deny-once"] }))
      .rejects.toThrow(/exactly allow-once and deny-once/u);
    await expect(gate.requestAndWait({ ...base, durableApprovalRecordAllowed: true }))
      .rejects.toThrow(/never recorded/u);
    await expect(gate.requestAndWait({ ...base, kind: undefined }))
      .rejects.toThrow(/only valid on an egress-host request/u);
  });
});
