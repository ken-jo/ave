import { afterEach, describe, expect, it, vi } from "vitest";
import { makeMockWebContents, sentApprovalCards } from "../../__tests__/test-helpers.js";
import { ApprovalGate, type ApprovalDecision, type ApprovalRequest, type ApprovalRequestInput } from "../approval-gate.js";
import { NO_APPROVER_MESSAGE } from "../decision-pipeline.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import type { UserOwnedSurface, UserOwnedSurfaceChoice } from "../../shared/permissions-events.js";

const gates: ApprovalGate[] = [];
afterEach(() => { for (const gate of gates.splice(0)) gate.disposeAll(); });

function subject(surface: UserOwnedSurface = "browser", overrides: Partial<ApprovalRequestInput> = {}) {
  const contents = makeMockWebContents();
  const gate = new ApprovalGate(contents as never);
  gates.push(gate);
  const request: ApprovalRequestInput = {
    id: "surface-action", category: "tool", toolName: "surface_action", toolCategory: "write", source: "builtin",
    sessionId: "conversation", args: { action: "one action" }, reason: "Continue the requested task", createdAt: Date.now(),
    userOwnedSurface: surface, ...overrides,
  };
  const observer = vi.fn();
  gate.observePendingApprovals({ onPending: observer, onSettled: vi.fn() });
  const pending = gate.requestAndWait(request);
  const card = sentApprovalCards<ApprovalRequest>(contents)[0];
  const answer = (extra: Partial<ApprovalDecision> = {}) => ({ requestId: request.id, choice: "allow-once" as const, nonce: card?.nonce, hmac: card?.hmac, userOwnedSurfaceChoice: "ask" as const, ...extra });
  return { gate, contents, request, pending, card, observer, answer };
}

describe("authenticated user-owned surface choices", () => {
  it.each(["browser", "host-terminal"] as const)("issues one-use native receipts for every %s choice", async (surface) => {
    for (const choice of ["allow", "auto", "ask"] as const) {
      const f = subject(surface);
      expect(f.card).toMatchObject({ userOwnedSurface: surface, requireExplicit: true, exactRecordAllowed: false, persistentAllowAllowed: false, allowedChoices: ["allow-once", "deny-once"] });
      expect(f.card?.shellRule).toBeUndefined();
      expect(f.observer).not.toHaveBeenCalled();
      f.gate.resolveFromDesktopRenderer(f.request.id, f.answer({ userOwnedSurfaceChoice: choice, rememberPattern: "injected remembered grant" }), f.contents as never);
      const decision = await f.pending;
      expect(decision.rememberPattern).toBeUndefined();
      expect(f.gate.consumeUserOwnedSurfaceChoice({ ...decision }, "conversation", surface)).toBeUndefined();
      expect(f.gate.consumeUserOwnedSurfaceChoice(decision, "conversation", surface)).toBe(choice);
      expect(f.gate.consumeUserOwnedSurfaceChoice(decision, "conversation", surface)).toBeUndefined();
    }
  });

  it.each(["wrong session", "wrong surface"] as const)("rejects and consumes a receipt for %s", async (mismatch) => {
    const f = subject();
    f.gate.resolveFromDesktopRenderer(f.request.id, f.answer(), f.contents as never);
    const decision = await f.pending;
    expect(f.gate.consumeUserOwnedSurfaceChoice(decision, mismatch === "wrong session" ? "other" : "conversation", mismatch === "wrong surface" ? "host-terminal" : "browser")).toBeUndefined();
    expect(f.gate.consumeUserOwnedSurfaceChoice(decision, "conversation", "browser")).toBeUndefined();
  });

  it("refuses non-native and foreign-window answers without settling the live card", async () => {
    const f = subject();
    expect(f.gate.resolve(f.request.id, f.answer(), "platform-bridge")).toBeNull();
    expect(f.gate.resolveFromDesktopRenderer(f.request.id, f.answer(), makeMockWebContents() as never)).toBeNull();
    expect(f.gate.pendingCount).toBe(1);
    f.gate.resolveFromDesktopRenderer(f.request.id, f.answer(), f.contents as never);
    expect(f.gate.consumeUserOwnedSurfaceChoice(await f.pending, "conversation", "browser")).toBe("ask");
  });

  it.each([undefined, "always", "ALLOW", null, {}, 1])("denies a missing or malformed selector choice %j", async (choice) => {
    const f = subject();
    f.gate.resolveFromDesktopRenderer(f.request.id, f.answer({ userOwnedSurfaceChoice: choice as unknown as UserOwnedSurfaceChoice }), f.contents as never);
    const decision = await f.pending;
    expect(decision.choice).toBe("deny-once");
    expect(f.gate.consumeUserOwnedSurfaceChoice(decision, "conversation", "browser")).toBeUndefined();
  });

  it("rejects a valid choice injected into an ordinary card", async () => {
    const f = subject("browser", { userOwnedSurface: undefined });
    f.gate.resolveFromDesktopRenderer(f.request.id, f.answer({ userOwnedSurfaceChoice: "allow" }), f.contents as never);
    expect((await f.pending).choice).toBe("deny-once");
  });

  it("dismisses without issuing a session choice", async () => {
    const f = subject();
    f.gate.resolveFromDesktopRenderer(f.request.id, f.answer({ choice: "deny-once", userOwnedSurfaceChoice: undefined }), f.contents as never);
    const decision = await f.pending;
    expect(decision.choice).toBe("deny-once");
    expect(f.gate.consumeUserOwnedSurfaceChoice(decision, "conversation", "browser")).toBeUndefined();
  });

  it("requires a valid signature before issuing any choice receipt", async () => {
    const f = subject();
    f.gate.resolveFromDesktopRenderer(f.request.id, f.answer({ hmac: "forged", userOwnedSurfaceChoice: "allow" }), f.contents as never);
    const decision = await f.pending;
    expect(decision.choice).toBe("deny-once");
    expect(f.gate.consumeUserOwnedSurfaceChoice(decision, "conversation", "browser")).toBeUndefined();
  });

  it.each(["browser", "host-terminal"] as const)("denies headless %s actions despite a live desktop", async (surface) => {
    const f = subject(surface, { evaluationContext: buildPermissionEvaluationContext({ policyMode: "allow", headless: true, source: "builtin", category: "write", trustOrigin: "user-keyboard", executionCwd: "/workspace", allowedDirectories: ["/workspace"], pathFields: [], targetFilePaths: [], sensitivePathsAdjacent: [] }) });
    expect(await f.pending).toMatchObject({ choice: "deny-once", rememberPattern: NO_APPROVER_MESSAGE });
    expect(f.card).toBeUndefined();
  });

  it("keeps a forced floor outside the selector", async () => {
    const f = subject("browser", { forceExplicit: true });
    expect(f.card?.userOwnedSurface).toBeUndefined();
    f.gate.resolveFromDesktopRenderer(f.request.id, f.answer({ userOwnedSurfaceChoice: undefined }), f.contents as never);
    expect(f.gate.consumeUserOwnedSurfaceChoice(await f.pending, "conversation", "browser")).toBeUndefined();
  });

  it("retains the selector and native receipt for an outside-directory card", async () => {
    const f = subject("host-terminal", { kind: "out-of-allowed-dir", outOfAllowedDir: { candidatePath: "/outside", suggestedParent: "/", currentAllowed: [], adjacencyWarnings: [] } });
    expect(f.card).toMatchObject({ kind: "out-of-allowed-dir", userOwnedSurface: "host-terminal", exactRecordAllowed: false });
    f.gate.resolveFromDesktopRenderer(f.request.id, f.answer({ userOwnedSurfaceChoice: "allow" }), f.contents as never);
    expect(f.gate.consumeUserOwnedSurfaceChoice(await f.pending, "conversation", "host-terminal")).toBe("allow");
  });

  it("retains exact host command binding validation before rendering a selector", async () => {
    const f = subject("host-terminal", { toolName: "terminal_run", toolCategory: "shell", durableApprovalRecordAllowed: false,
      args: { command: "printf displayed" }, hostTerminal: { tabId: "terminal:example", terminalSessionId: "host", sessionId: "conversation", shell: "zsh", physicalCwd: "/workspace", command: "printf other" } });
    await expect(f.pending).rejects.toThrow("host terminal binding");
    expect(f.card).toBeUndefined();
  });

  it("keeps failed automatic review on a native normal once card without a selector receipt", async () => {
    const f = subject("browser", { userOwnedSurfaceReviewFallback: true });
    expect(f.card).toMatchObject({ userOwnedSurface: "browser", userOwnedSurfaceReviewFallback: true, exactRecordAllowed: false });
    expect(f.gate.resolve(f.request.id, f.answer({ userOwnedSurfaceChoice: undefined }), "platform-bridge")).toBeNull();
    f.gate.resolveFromDesktopRenderer(f.request.id, f.answer({ userOwnedSurfaceChoice: undefined }), f.contents as never);
    expect(f.gate.consumeUserOwnedSurfaceChoice(await f.pending, "conversation", "browser")).toBeUndefined();
  });

  it("refuses session selection on a review fallback card", async () => {
    const f = subject("browser", { userOwnedSurfaceReviewFallback: true });
    f.gate.resolveFromDesktopRenderer(f.request.id, f.answer({ userOwnedSurfaceChoice: "allow" }), f.contents as never);
    expect((await f.pending).choice).toBe("deny-once");
  });

  it.each([
    { userOwnedSurface: "terminal" },
    { sessionId: undefined },
    { userOwnedSurfaceReviewFallback: false },
    { userOwnedSurface: undefined, userOwnedSurfaceReviewFallback: true },
  ])("rejects malformed host surface card metadata %j", async (fields) => {
    const f = subject("browser", fields as unknown as Partial<ApprovalRequestInput>);
    expect((await f.pending).choice).toBe("deny-once");
    expect(f.card).toBeUndefined();
  });
});
