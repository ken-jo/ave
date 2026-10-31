import { describe, expect, it, vi } from "vitest";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { makeMockWebContents, sentApprovalCards } from "../../__tests__/test-helpers.js";

describe("child human approval boundaries", () => {
  it("rejects a persistent answer to a child card after verifying its signature", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const pending = gate.requestAndWait({
      id: "child", category: "tool", toolName: "write_file", source: "builtin", args: {}, createdAt: Date.now(), reason: "Child request",
      childProvenance: { childSessionId: "child", childTitle: "Child", originSessionId: "owner", spawnTaskSummary: "Write file" },
    });
    const card = sentApprovalCards<ApprovalRequest>(wc)[0]!;
    gate.resolveFromDesktopRenderer(card.id, { requestId: card.id, choice: "allow-always", nonce: card.nonce, hmac: card.hmac }, wc as never);
    await expect(pending).resolves.toMatchObject({ choice: "deny-once", rememberPattern: "approval choice not allowed" });
  });

  it("keeps background child approval pending when the owner is away", async () => {
    vi.useFakeTimers();
    try {
      const wc = makeMockWebContents();
      const gate = new ApprovalGate(wc as never, undefined, 100);
      const pending = gate.requestAndWait({
        id: "background-child", category: "tool", toolName: "write_file", source: "builtin", args: {}, createdAt: Date.now(), reason: "Child request", ownerUnattended: true,
        childProvenance: { childSessionId: "child", childTitle: "Child", originSessionId: "owner", spawnTaskSummary: "Write file", background: true },
      });
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(gate.pendingCount).toBe(1);
      gate.disposeAll();
      await expect(pending).resolves.toMatchObject({ choice: "deny-once" });
    } finally { vi.useRealTimers(); }
  });
});
