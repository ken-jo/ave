import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput } from "../approval-gate.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import { endRun, registerRunSession, __resetRunGrantsForTest } from "../run-grants.js";
import { makeMockWebContents, sentApprovalCards } from "../../__tests__/test-helpers.js";

const RUN = "work-board:7#run-a";
const PROJECT = process.platform === "win32" ? "C:\\workspace\\project" : "/workspace/project";

beforeEach(() => __resetRunGrantsForTest());
afterEach(() => __resetRunGrantsForTest());

function card(id: string, sessionId: string, overrides: Partial<ApprovalRequestInput> = {}): ApprovalRequestInput {
  return {
    id, sessionId, category: "tool", kind: "tool", toolName: "status_probe", toolCategory: "write", source: "mcp", trustOrigin: "llm-tool-arg",
    args: { query: "status" }, reason: "This tool requires approval.", createdAt: Date.now(),
    reviewerVerdict: { level: "medium", reason: "bounded action" },
    evaluationContext: buildPermissionEvaluationContext({
      policyMode: "default", headless: false, source: "mcp", category: "write", trustOrigin: "llm-tool-arg",
      executionCwd: PROJECT, allowedDirectories: [PROJECT], pathFields: [], targetFilePaths: [], sensitivePathsAdjacent: [],
    }),
    ...overrides,
  };
}

function fixture() {
  const wc = makeMockWebContents();
  const gate = new ApprovalGate(wc as never);
  const sent = () => sentApprovalCards<ApprovalRequest>(wc);
  return { wc, gate, sent };
}

describe("per-stage approval lanes (one lane per stage session, nothing batched)", () => {
  it("two stage sessions' cards are open at once, each names its stage, and deciding one leaves the other pending", async () => {
    registerRunSession(RUN, "plan-session", { stageId: "plan", stageName: "Plan", lane: "attended" });
    registerRunSession(RUN, "build-session", { stageId: "build", stageName: "Build", lane: "attended" });
    const { wc, gate, sent } = fixture();
    const plan = gate.requestAndWait(card("plan-card", "plan-session"));
    const build = gate.requestAndWait(card("build-card", "build-session"));
    const [planCard, buildCard] = sent();
    expect(planCard?.runStage).toEqual({ stageId: "plan", stageName: "Plan", runAllowOffered: true });
    expect(buildCard?.runStage).toEqual({ stageId: "build", stageName: "Build", runAllowOffered: true });
    expect(gate.pendingCount).toBe(2);

    gate.resolveFromDesktopRenderer("build-card", { requestId: "build-card", choice: "allow-once", nonce: buildCard?.nonce ?? "", hmac: buildCard?.hmac ?? "" }, wc as never);
    await expect(build).resolves.toMatchObject({ requestId: "build-card", choice: "allow-once" });
    // The other stage's card was neither answered nor withdrawn, and a reloaded window still gets it with its stage.
    expect(gate.pendingCount).toBe(1);
    expect(gate.listPendingRendererRequests(wc as never).map(request => [request.id, request.runStage?.stageId])).toEqual([["plan-card", "plan"]]);
    gate.resolveFromDesktopRenderer("plan-card", { requestId: "plan-card", choice: "deny-once", nonce: planCard?.nonce ?? "", hmac: planCard?.hmac ?? "" }, wc as never);
    await expect(plan).resolves.toMatchObject({ requestId: "plan-card", choice: "deny-once" });
  });

  it("a session outside a run gets no stage, whatever the caller supplies, and a stage name is masked and bounded", async () => {
    registerRunSession(RUN, "plan-session", { stageId: "plan", stageName: `Plan ${"x".repeat(400)}`, lane: "attended" });
    const { gate, sent } = fixture();
    const forged = { ...card("chat-card", "chat-session"), runStage: { stageId: "plan", stageName: "Plan", runAllowOffered: true } } as ApprovalRequestInput;
    void gate.requestAndWait(forged);
    void gate.requestAndWait(card("plan-card", "plan-session"));
    const [chatCard, planCard] = sent();
    expect(chatCard).not.toHaveProperty("runStage");
    expect(planCard?.runStage?.stageName.length).toBe(120);
    gate.disposeAll();
  });

  it("offers Allow for this run only where the card may be remembered for the session and the run takes grants", async () => {
    registerRunSession(RUN, "plan-session", { stageId: "plan", stageName: "Plan", lane: "attended" });
    registerRunSession("work-board:9#run-s", "scheduled-session", { stageId: "report", stageName: "Report", lane: "unattended" });
    const { gate, sent } = fixture();
    const offered = (request: ApprovalRequestInput) => {
      void gate.requestAndWait(request);
      return sent().at(-1)?.runStage?.runAllowOffered;
    };
    expect(offered(card("ordinary", "plan-session"))).toBe(true);
    // A forced floor is once-only: no remembered scope of any kind.
    expect(offered(card("floor", "plan-session", { forceExplicit: true }))).toBe(false);
    expect(offered(card("one-shot", "plan-session", { allowedChoices: ["allow-once", "deny-once"] }))).toBe(false);
    expect(offered(card("not-recordable", "plan-session", { durableApprovalRecordAllowed: false }))).toBe(false);
    // A browser scope is remembered for its own session only.
    expect(offered(card("browser", "plan-session", { toolName: "browser_action", source: "builtin",
      approvalCacheKey: "browser-agent-tabs", approvalMemory: { kind: "key", key: "browser-agent-tabs", scope: { kind: "browser-agent-tabs" } } }))).toBe(false);
    // A schedule-started run never asks; a card raised for one still offers no run grant.
    expect(offered(card("scheduled", "scheduled-session"))).toBe(false);
    // A shell card saves its run allow as a rule, where it may save a session rule.
    expect(offered(card("shell", "plan-session", { toolName: "bash", toolCategory: "shell", source: "builtin", args: { command: "printf ready" } }))).toBe(true);
    expect(offered(card("shell-forced", "plan-session", { toolName: "bash", toolCategory: "shell", source: "builtin", args: { command: "printf ready" },
      forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false }))).toBe(false);
    // Once the run is over its sessions are no members: a card that outlived it names no stage.
    endRun(RUN);
    expect(offered(card("after-end", "plan-session"))).toBeUndefined();
    gate.disposeAll();
  });
});
