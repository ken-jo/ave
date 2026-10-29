// Parent adjudication must preserve decision attribution and compose correctly with reviewer and user stages.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import { IPC_APPROVAL_REQUEST } from "../../permissions/approval-gate.js";
import type { ApprovalDecision } from "../../permissions/approval-gate.js";
import type {
  ParentAdjudicationEvidence,
  ParentAdjudicationOptions,
  ParentAdjudicationResult,
  ParentAdjudicator,
} from "../../permissions/parent-adjudicator.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import { makeWriteProbeTool } from "./approval-memory-test-fixtures.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";

const CHILD_SESSION = "sub-11112222-3333-child";
const PARENT_SESSION = "conv-parent";

type SeenAdjudication = {
  evidence: ParentAdjudicationEvidence;
  options: ParentAdjudicationOptions;
};

function scriptedAdjudicator(
  answer: ParentAdjudicationResult,
  seen: SeenAdjudication[],
): ParentAdjudicator {
  return {
    adjudicate: async (evidence, options) => {
      seen.push({ evidence, options });
      return answer;
    },
    forgetChildRun: () => {},
  };
}

// Use a real tier-2 gate after a layer-3 ask and tier-1 review.
async function runChildToolCall(options: {
  answer?: ParentAdjudicationResult;
  provenance?: boolean;
  forceModal?: boolean;
  verdict?: boolean;
  layer?: number;
  // Tier-1 allow bypasses the gate.
  tier1?: "allow" | "ask";
  userAnswer?: "allow-once" | "deny-once";
}): Promise<{
  content: string;
  isError: boolean | undefined;
  events: PermissionReviewEvent[];
  requests: Record<string, unknown>[];
  docked: Record<string, unknown>[];
  decisions: ApprovalDecision[];
  // null means the gate rejected the user answer.
  resolutions: (ApprovalDecision | null)[];
  adjudications: SeenAdjudication[];
  executed: number;
}> {
  const dir = mkdtempSync(join(tmpdir(), "ave-parent-adjudication-"));
  try {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));
    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.checkDetailed = () => ({
      decision: options.tier1 === "allow" ? "allow" : "ask",
      reason: "sub-agent write",
      layer: options.layer ?? 3,
      ...(options.forceModal === true ? { forceModal: true as const } : {}),
      ...(options.verdict === false
        ? {}
        : {
            // Headless verdicts are not rerun by interactive dispatch, preserving this fixture's verdict.
            reviewer: {
              route: "headless" as const,
              outcome: "fresh" as const,
              verdict: { level: "medium" as const, reason: "writes a file" },
            },
          }),
    });

    const requests: Record<string, unknown>[] = [];
    const docked: Record<string, unknown>[] = [];
    const decisions: ApprovalDecision[] = [];
    const resolutions: (ApprovalDecision | null)[] = [];
    const adjudications: SeenAdjudication[] = [];
    const wc = makeMockWebContents();
    // Echo host-issued nonce and HMAC; inspect resolve acceptance to distinguish user denial from integrity failure.
    wc.send.mockImplementation((channel: string, sent: Record<string, unknown>) => {
      if (channel !== IPC_APPROVAL_REQUEST) return;
      docked.push(sent);
      if (options.userAnswer === undefined) return;
      queueMicrotask(() => {
        resolutions.push(
          gate.resolve(sent.id as string, {
            requestId: sent.id as string,
            choice: options.userAnswer as "allow-once" | "deny-once",
            nonce: sent.nonce as string,
            hmac: sent.hmac as string,
          }),
        );
      });
    });
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      1_000,
      undefined,
      undefined,
      {
        adjudicator: () =>
          scriptedAdjudicator(
            options.answer ?? {
              outcome: "escalate",
              cause: "parent-escalated",
              reason: "cannot tell",
            },
            adjudications,
          ),
        isEnabled: () => true,
        policy: () => ({
          maxVerdict: "medium",
          timeoutMs: 5_000,
          maxPerChildRun: 200,
          includeParentContextTurns: 0,
          // Use the dock so the user-visible escalation leg remains in the chain.
          backgroundEscalation: "modal",
          model: "reviewer",
        }),
      },
    );
    const baseRequestAndWait = gate.requestAndWait.bind(gate);
    gate.requestAndWait = async (req) => {
      requests.push(req as unknown as Record<string, unknown>);
      const decision = await baseRequestAndWait(
        options.provenance === false
          ? req
          : {
              ...req,
              childProvenance: {
                childSessionId: CHILD_SESSION,
                childTitle: "release notes",
                originSessionId: PARENT_SESSION,
                spawnTaskSummary: "write the release notes",
              },
            },
      );
      decisions.push(decision);
      return decision;
    };

    const events: PermissionReviewEvent[] = [];
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );
    const results = await executor.executeAll(
      [{ id: "tu-1", name: "write_probe", input: { path: join(dir, "notes.md") } }],
      {
        sessionId: CHILD_SESSION,
        permissionContext: {
          trustOrigin: "user-keyboard",
          additionalDirectories: [dir],
        },
        callbacks: { onPermissionReview: (event) => events.push(event) },
      },
    );

    return {
      content: String(results[0]?.content ?? ""),
      isError: results[0]?.is_error,
      events,
      requests,
      docked,
      decisions,
      resolutions,
      adjudications,
      executed: executeSpy.mock.calls.length,
    };
  } finally {
    await cleanupTmpDir(dir);
  }
}

function eligibilityCase(options: Parameters<typeof runChildToolCall>[0], eligible: boolean) {
  return async () => {
    const run = await runChildToolCall({ provenance: false, ...options });
    expect(run.requests[0]?.parentAdjudicationEligible).toBe(eligible);
  };
}

describe("the eligibility the lane asserts", () => {
  it("asserts it for a layer-3 ask that carries a tier-1 verdict", eligibilityCase({}, true));
  it("withholds it when policy already forced a modal", eligibilityCase({ forceModal: true }, false));
  it("withholds it when there is no tier-1 verdict to refine", eligibilityCase({ verdict: false }, false));
  it("withholds it below layer 3", eligibilityCase({ layer: 2 }, false));
});

describe("what happens after the parent answers", () => {
  it("runs the tool and reports the parent approved it", async () => {
    const run = await runChildToolCall({
      answer: { outcome: "allow-once", reason: "that is the task I gave it" },
    });

    expect(run.executed).toBe(1);
    expect(run.isError).toBeUndefined();
    const event = run.events.find((e) => e.status === "parent_approved");
    expect(event?.reason).toBe("that is the task I gave it");
    expect(event?.verdictLevel).toBe("medium");
  });

  it("tells the child which party refused, and why", async () => {
    const run = await runChildToolCall({
      answer: { outcome: "deny", reason: "that file is outside the task" },
    });

    expect(run.executed).toBe(0);
    expect(run.isError).toBe(true);
    expect(run.content).toContain("that file is outside the task");
    // Attribute parent refusal to the parent so the child can respond appropriately.
    expect(run.content).not.toContain("사용자가 실행을 거부");
    expect(run.events.some((e) => e.status === "parent_denied")).toBe(true);
  });

  it("emits no parent event when the ask reached the user instead", async () => {
    const run = await runChildToolCall({
      answer: {
        outcome: "escalate",
        cause: "timeout",
        reason: "the parent did not answer in time",
      },
    });

    // After dock escalation, the gate timeout resolves the request.
    expect(
      run.events.some(
        (e) => e.status === "parent_approved" || e.status === "parent_denied",
      ),
    ).toBe(false);
  });
});

describe("the chain, end to end", () => {
  it("tier 1: an automatic allow never reaches the parent or the dock", async () => {
    const run = await runChildToolCall({
      tier1: "allow",
      // A denying parent makes an unintended consultation observable.
      answer: { outcome: "deny", reason: "the parent should never see this" },
    });

    expect(run.executed).toBe(1);
    expect(run.isError).toBeUndefined();
    // Install request capture before executor construction to detect every gate entry.
    expect(run.requests).toHaveLength(0);
    expect(run.adjudications).toHaveLength(0);
    expect(run.docked).toHaveLength(0);
    expect(
      run.events.some(
        (e) => e.status === "parent_approved" || e.status === "parent_denied",
      ),
    ).toBe(false);
  });

  it("tier 2: a parent allow runs the call with no dock", async () => {
    const run = await runChildToolCall({
      answer: { outcome: "allow-once", reason: "writing the notes is the task" },
    });

    expect(run.requests).toHaveLength(1);
    expect(run.executed).toBe(1);
    expect(run.docked).toHaveLength(0);
    expect(run.decisions[0]?.choice).toBe("allow-once");
    expect(run.decisions[0]?.rememberPattern).toBeUndefined();
    expect(run.events.some((e) => e.status === "parent_approved")).toBe(true);
    // Parent review receives the parent's task, never purpose text derived from child arguments.
    expect(run.adjudications).toHaveLength(1);
    expect(run.adjudications[0]?.evidence.child.spawnTaskSummary).toBe(
      "write the release notes",
    );
    expect(run.adjudications[0]?.evidence).not.toHaveProperty("approvalPurpose");
    expect(run.adjudications[0]?.options.parentSessionId).toBe(PARENT_SESSION);
  });

  it("tier 2: a parent deny stops the call with no dock, and mints no rule", async () => {
    const run = await runChildToolCall({
      answer: { outcome: "deny", reason: "that file is outside the task" },
    });

    expect(run.executed).toBe(0);
    expect(run.isError).toBe(true);
    expect(run.docked).toHaveLength(0);
    expect(run.events.some((e) => e.status === "parent_denied")).toBe(true);
    // Parent refusal applies to one call and cannot mint persistent policy on the user's behalf.
    expect(run.decisions[0]?.choice).toBe("deny-once");
    expect(run.decisions[0]?.rememberPattern).toBeUndefined();
  });

  it("tier 3: an escalation reaches the user, notice and all, and the user decides", async () => {
    const run = await runChildToolCall({
      answer: {
        outcome: "escalate",
        cause: "parent-escalated",
        reason: "I cannot tell whether that file belongs to the task",
      },
      userAnswer: "allow-once",
    });

    expect(run.docked).toHaveLength(1);
    expect(run.docked[0]?.parentEscalation).toEqual({
      cause: "parent-escalated",
      reason: "I cannot tell whether that file belongs to the task",
      childTitle: "release notes",
    });
    // Host-only inputs stop at the gate.
    expect(run.docked[0]).not.toHaveProperty("childProvenance");
    expect(run.docked[0]).not.toHaveProperty("parentAdjudicationEligible");
    // Require gate acceptance and user attribution rather than a forced deny.
    expect(run.resolutions).toHaveLength(1);
    expect(run.resolutions[0]?.choice).toBe("allow-once");
    expect(run.executed).toBe(1);
    expect(
      run.events.some(
        (e) => e.status === "parent_approved" || e.status === "parent_denied",
      ),
    ).toBe(false);
  });

  it("tier 3: the user's refusal is what stops the call", async () => {
    const run = await runChildToolCall({
      answer: {
        outcome: "escalate",
        cause: "adjudicator-unavailable",
        reason: "no parent reviewer is configured",
      },
      userAnswer: "deny-once",
    });

    expect(run.docked[0]?.parentEscalation).toMatchObject({
      cause: "adjudicator-unavailable",
    });
    expect(run.executed).toBe(0);
    expect(run.isError).toBe(true);
    // Gate acceptance without a forced pattern distinguishes user denial from timeout or integrity rejection.
    expect(run.resolutions).toHaveLength(1);
    expect(run.resolutions[0]).not.toBeNull();
    expect(run.resolutions[0]?.choice).toBe("deny-once");
    expect(run.decisions[0]?.choice).toBe("deny-once");
    expect(run.decisions[0]?.rememberPattern).toBeUndefined();
  });
});
