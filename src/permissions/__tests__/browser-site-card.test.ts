import { afterEach, describe, expect, it } from "vitest";
import { makeMockWebContents, sentApprovalCards } from "../../__tests__/test-helpers.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";

const gates: ApprovalGate[] = [];
afterEach(() => { for (const gate of gates.splice(0)) gate.disposeAll(); });
function subject() {
  const contents = makeMockWebContents();
  const gate = new ApprovalGate(contents as never);
  gates.push(gate);
  const pending = gate.requestAndWait({ id: "site", category: "tool", source: "builtin", toolName: "browser_navigate", toolCategory: "network", browserSite: "https://example.test:443", args: { url: "https://example.test" }, reason: "Open site", sessionId: "conversation", createdAt: 1, forceExplicit: true, durableApprovalRecordAllowed: false, allowedChoices: ["allow-once", "deny-once"] });
  const card = sentApprovalCards<ApprovalRequest>(contents)[0];
  return { contents, gate, pending, card };
}
describe("authenticated site choices", () => {
  it.each(["this-site", "any-site"] as const)("issues one-use native receipts for %s", async (choice) => {
    const f = subject();
    expect(f.card).toMatchObject({ exactRecordAllowed: false, persistentAllowAllowed: false, requireExplicit: true });
    f.gate.resolveFromDesktopRenderer("site", { requestId: "site", choice: "allow-once", browserSiteChoice: choice, nonce: f.card.nonce, hmac: f.card.hmac }, f.contents as never);
    const decision = await f.pending;
    expect(f.gate.consumeBrowserSiteChoice({ ...decision }, "conversation", "https://example.test:443")).toBeUndefined();
    expect(f.gate.consumeBrowserSiteChoice(decision, "conversation", "https://example.test:443")).toBe(choice);
    expect(f.gate.consumeBrowserSiteChoice(decision, "conversation", "https://example.test:443")).toBeUndefined();
  });
  it("denies a missing choice instead of guessing a grant", async () => {
    const f = subject();
    f.gate.resolveFromDesktopRenderer("site", { requestId: "site", choice: "allow-once", nonce: f.card.nonce, hmac: f.card.hmac }, f.contents as never);
    expect((await f.pending).choice).toBe("deny-once");
  });
  it("ignores non-native answers and preserves the pending desktop card", async () => {
    const f = subject();
    const answer = { requestId: "site", choice: "allow-once" as const, browserSiteChoice: "any-site" as const, nonce: f.card.nonce, hmac: f.card.hmac };
    expect(f.gate.resolve("site", answer, "platform-bridge")).toBeNull();
    f.gate.resolveFromDesktopRenderer("site", { ...answer, choice: "deny-once", browserSiteChoice: undefined }, f.contents as never);
    expect((await f.pending).choice).toBe("deny-once");
  });
});
