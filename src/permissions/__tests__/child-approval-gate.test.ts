import { describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput } from "../approval-gate.js";
import { makeMockWebContents, sentApprovalCards } from "../../__tests__/test-helpers.js";

describe("child escalation human approval", () => {
  it("requires a one-shot human answer for a host-tracked child invocation", async () => {
    const wc = makeMockWebContents();
    const gate = new ApprovalGate(wc as never);
    const request: ApprovalRequestInput = {
      id: "child-approval", toolName: "write_file", category: "tool", source: "builtin",
      args: { path: "/workspace/project/file.txt", content: "content" }, reason: "Child write", createdAt: Date.now(),
      childProvenance: { childSessionId: "child", childTitle: "Work", originSessionId: "owner", spawnTaskSummary: "Edit file" },
      durableApprovalRecordAllowed: true,
    };
    const pending = gate.requestAndWait(request);
    const card = sentApprovalCards<ApprovalRequest>(wc)[0]!;
    expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(card.exactRecordAllowed).toBe(false);
    expect(card).not.toHaveProperty("childProvenance");
    expect(gate.pendingCount).toBe(1);
    gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: card.nonce, hmac: card.hmac }, wc as never);
    await expect(pending).resolves.toMatchObject({ choice: "allow-once" });
  });
});
