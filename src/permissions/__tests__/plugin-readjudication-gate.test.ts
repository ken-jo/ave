import { describe, expect, it, vi } from "vitest";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { ApprovalGate, type ApprovalRequest, type ApprovalRequestInput } from "../approval-gate.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import { createPluginReadjudicationBasis, type PluginReadjudicationBasis } from "../plugin-readjudication-evidence.js";
import { RuleBasedRiskClassifier, type ToolInvocationContext } from "../reviewer/risk-classifier.js";
import { issueApprovalRuleBasis } from "../approval-rule-evidence.js";
import { bindPluginInstanceIntegrity, recordPluginFactoryIntegrity } from "../../plugins/runtime-integrity-evidence.js";
import type { RuntimePlugin, RuntimePluginFactory } from "../../plugins/types.js";
import { sentApprovalCards } from "../../__tests__/test-helpers.js";

type EligibleRequest = ApprovalRequestInput & {
  readjudicationBasis: PluginReadjudicationBasis;
  evaluationContext: NonNullable<ApprovalRequestInput["evaluationContext"]>;
};

async function request(): Promise<EligibleRequest> {
  const cwd = realpathSync(homedir());
  const runtime: RuntimePlugin = { handlers: {} };
  const factory: RuntimePluginFactory = () => runtime;
  recordPluginFactoryIntegrity(factory, "document-tools", {
    installSource: "marketplace", artifactSha256: "a".repeat(64), signerKeyId: "receipt-signer",
    rung: null, sourceOrigin: null,
  });
  bindPluginInstanceIntegrity(runtime, factory);
  const context: ToolInvocationContext = {
    toolName: "document_update", source: "plugin", category: "write", pathFields: ["path"],
    trustOrigin: "llm-tool-arg", finalInput: { operation: "update" }, executionCwd: cwd,
    allowedDirectories: [cwd], sensitivePathsAdjacent: [],
    sandboxCapability: { kind: "asrt", confidence: "verified", platform: process.platform,
      reason: "Host-created process", confines: { filesystem: true, process: true, network: true } },
  };
  const ruleVerdict = new RuleBasedRiskClassifier().classify(context);
  const basis = await createPluginReadjudicationBasis({ ...context, pluginId: "document-tools",
    runtimeInstance: runtime, ruleVerdict });
  if (basis === undefined) throw new Error("Host evidence fixture is unavailable");
  return {
    id: "human-readjudication", category: "tool", kind: "tool", toolName: context.toolName,
    source: "plugin", sourcePluginId: "document-tools", toolCategory: "write",
    args: context.finalInput, trustOrigin: context.trustOrigin, reason: "Missing write path", createdAt: 0,
    sessionId: "conversation", ruleVerdict, approvalRuleBasis: issueApprovalRuleBasis(context, ruleVerdict),
    readjudicationBasis: basis,
    evaluationContext: buildPermissionEvaluationContext({ ...context, policyMode: "strict", headless: false,
      trustOrigin: "llm-tool-arg", targetFilePaths: [] }),
  };
}

async function inspect(overrides: (input: EligibleRequest) => ApprovalRequestInput, onPending?: (input: ApprovalRequestInput) => void) {
  const input = overrides(await request());
  const surface = { send: vi.fn(), isDestroyed: () => false };
  const gate = new ApprovalGate(() => surface as never);
  const pending = gate.requestAndWait(input);
  try {
    onPending?.(input);
    return { cards: sentApprovalCards<ApprovalRequest>(surface), snapshot: gate.getRequestSnapshot(input.id) };
  } finally {
    gate.disposeAll();
    await pending;
  }
}

describe("host-owned human re-adjudication card admission", () => {
  it("publishes only the issued evidence and keeps the original HIGH", async () => {
    const { cards, snapshot } = await inspect(input => input);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.readjudication).toMatchObject({ pluginId: "document-tools", staticReason: "write-path-not-declared" });
    expect(cards[0]).not.toHaveProperty("readjudicationBasis");
    expect(snapshot).toMatchObject({ verdictAtApproval: "high", readjudication: cards[0]?.readjudication });
  });

  it("detaches pending exact input from a caller's mutable argument object", async () => {
    const { cards, snapshot } = await inspect(input => input, input => {
      (input.args as Record<string, unknown>).operation = "remove";
    });
    expect(cards[0]?.args).toEqual({ operation: "update" });
    expect(snapshot?.args).toEqual({ operation: "update" });
  });

  it.each([
    ["missing evidence", (input: EligibleRequest) => ({ ...input, readjudicationBasis: undefined })],
    ["copied evidence receipt", (input: EligibleRequest) => ({ ...input, readjudicationBasis: { ...input.readjudicationBasis } })],
    ["changed input", (input: EligibleRequest) => ({ ...input, args: { operation: "remove" } })],
    ["different plugin", (input: EligibleRequest) => ({ ...input, sourcePluginId: "other-plugin" })],
    ["forced floor", (input: EligibleRequest) => ({ ...input, forceExplicit: true as const })],
    ["one-shot choices", (input: EligibleRequest) => ({ ...input, allowedChoices: ["allow-once", "deny-once"] as const })],
    ["non-recordable request", (input: EligibleRequest) => ({ ...input, durableApprovalRecordAllowed: false })],
    ["headless creation", (input: EligibleRequest) => ({ ...input, evaluationContext: { ...input.evaluationContext, headless: true } })],
    ["missing human availability", (input: EligibleRequest) => ({ ...input, evaluationContext: undefined })],
    ...(["unavailable", "error", "timeout", "malformed"] as const).map(outcome => [
      `reviewer ${outcome}`, (input: EligibleRequest) => ({ ...input, reviewerOutcome: outcome }),
    ] as const),
  ] as const)("does not issue EA for %s", async (_name, change) => {
    const { cards, snapshot } = await inspect(change);
    expect(cards[0]?.readjudication).toBeUndefined();
    expect(snapshot?.readjudication).toBeUndefined();
  });

  it("strips a caller-supplied display projection without a host receipt", async () => {
    const { cards, snapshot } = await inspect(input => ({ ...input, readjudicationBasis: undefined,
      readjudication: input.readjudicationBasis?.evidence,
    }) as ApprovalRequestInput);
    expect(cards[0]?.readjudication).toBeUndefined();
    expect(snapshot?.readjudication).toBeUndefined();
  });
});
