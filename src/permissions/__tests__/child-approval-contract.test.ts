import { describe, expect, it } from "vitest";
import { makeMockWebContents, sentApprovalCards } from "../../__tests__/test-helpers.js";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput } from "../approval-gate.js";

function request(): ApprovalRequestInput {
  return {
    id: "child-request", category: "tool", toolName: "write_file", source: "builtin",
    args: { path: "/workspace/note.md", content: "Content" }, reason: "Child write", createdAt: Date.now(),
    sessionId: "owner-session",
    childProvenance: { childSessionId: "child-session", childTitle: "Child work", originSessionId: "owner-session", spawnTaskSummary: "Update the document" },
  };
}

describe("child approval provenance contract", () => {

  it("keeps host-only child identities out of the renderer card", async () => {
    const surface = makeMockWebContents();
    const gate = new ApprovalGate(surface as never);
    const pending = gate.requestAndWait(request());
    const card = sentApprovalCards<ApprovalRequest>(surface)[0]!;
    expect(card).not.toHaveProperty("childProvenance");
    expect(JSON.stringify(card)).not.toContain("child-session");
    gate.disposeAll();
    await expect(pending).resolves.toMatchObject({ choice: "deny-once" });
  });

  it("shows one human card and prevents remembered authority for the child request", async () => {
    const surface = makeMockWebContents();
    const gate = new ApprovalGate(surface as never);
    const pending = gate.requestAndWait(request());
    const cards = sentApprovalCards<ApprovalRequest>(surface);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.allowedChoices).toEqual(["allow-once", "deny-once"]);
    expect(cards[0]?.exactRecordAllowed).toBe(false);
    expect(cards[0]?.persistentAllowAllowed).toBe(false);
    gate.disposeAll();
    await expect(pending).resolves.toMatchObject({ choice: "deny-once" });
  });
});
