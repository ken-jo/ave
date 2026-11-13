import { describe, expect, it } from "vitest";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { RuntimePlugin, RuntimePluginFactory } from "../../plugins/types.js";
import type { PluginIntegrityEvidence } from "../../plugins/runtime/index.js";
import { bindPluginInstanceIntegrity, recordPluginFactoryIntegrity } from "../../plugins/runtime-integrity-evidence.js";
import { buildPermissionEvaluationContext } from "../evaluation-context.js";
import { createPluginReadjudicationBasis, matchesPluginReadjudicationBasis } from "../plugin-readjudication-evidence.js";
import { RuleBasedRiskClassifier, type ToolInvocationContext } from "../reviewer/risk-classifier.js";
import type { ReviewerDispatchOutcome } from "../permission-manager.js";
import type { SandboxCapability } from "../sandbox-capability.js";

const DIRECTORY = realpathSync(tmpdir());
const PLUGIN_ID = "fixture-artifact";
const INTEGRITY: PluginIntegrityEvidence = {
  installSource: "marketplace", signerKeyId: "fixture-signer", artifactSha256: "a".repeat(64), rung: null, sourceOrigin: null,
};
const CAPABILITY: SandboxCapability = {
  kind: "asrt", confidence: "verified", platform: process.platform, reason: "verified child confinement",
  confines: { filesystem: true, process: true, network: false },
};

function subject(overrides: Partial<ToolInvocationContext> = {}): ToolInvocationContext {
  return {
    toolName: "artifact_publish", source: "plugin", category: "write", pathFields: ["path"],
    trustOrigin: "llm-tool-arg", finalInput: { operation: "publish" }, executionCwd: DIRECTORY,
    allowedDirectories: [DIRECTORY], sensitivePathsAdjacent: [], sandboxCapability: CAPABILITY,
    ...overrides,
  };
}

function loadedInstance(integrity: PluginIntegrityEvidence | undefined, pluginId = PLUGIN_ID): RuntimePlugin {
  const instance: RuntimePlugin = { handlers: {} };
  const factory: RuntimePluginFactory = () => instance;
  recordPluginFactoryIntegrity(factory, pluginId, integrity);
  bindPluginInstanceIntegrity(instance, factory);
  return instance;
}

function candidate(input = subject(), runtimeInstance = loadedInstance(INTEGRITY)) {
  return {
    ...input, pluginId: PLUGIN_ID, runtimeInstance,
    ruleVerdict: new RuleBasedRiskClassifier().classify(input),
  };
}

function pendingRequest(input = subject()) {
  return {
    toolName: input.toolName, source: input.source, sourcePluginId: PLUGIN_ID,
    toolCategory: input.category, trustOrigin: input.trustOrigin, args: input.finalInput,
    evaluationContext: buildPermissionEvaluationContext({
      policyMode: "strict", headless: false, source: input.source, category: input.category, trustOrigin: input.trustOrigin,
      executionCwd: input.executionCwd, allowedDirectories: input.allowedDirectories, pathFields: input.pathFields,
      targetFilePaths: [], sensitivePathsAdjacent: [],
    }),
  };
}

describe("host-issued re-adjudication evidence", () => {
  it("issues a frozen exact pending-request basis from static provenance and loaded receipt evidence", async () => {
    const input = subject({ permissionReason: "The project policy requires a human decision." });
    const basis = await createPluginReadjudicationBasis(candidate(input));
    expect(basis?.evidence).toEqual({
      pluginId: PLUGIN_ID, artifactSha256: INTEGRITY.artifactSha256, signerKeyId: INTEGRITY.signerKeyId,
      staticReason: "write-path-not-declared",
    });
    if (basis === undefined) throw new Error("Expected host-issued evidence");
    expect(Object.isFrozen(basis)).toBe(true);
    expect(Object.isFrozen(basis.evidence)).toBe(true);
    expect(matchesPluginReadjudicationBasis(basis, pendingRequest(input))).toBe(true);
    expect(matchesPluginReadjudicationBasis({ ...basis }, pendingRequest(input))).toBe(false);
  });

  it("accepts a host-determined HIGH but never a fabricated HIGH display", async () => {
    const input = candidate();
    expect(await createPluginReadjudicationBasis({ ...input, reviewerVerdict: input.ruleVerdict, reviewerOutcome: "host-determined" })).toBeDefined();
    expect(await createPluginReadjudicationBasis({ ...input, ruleVerdict: { level: "high", reason: "write path not declared" } })).toBeUndefined();
    expect(await createPluginReadjudicationBasis({ ...input, reviewerVerdict: { level: "low", reason: "display" }, reviewerOutcome: "host-determined" })).toBeUndefined();
  });

  it.each<ReviewerDispatchOutcome>(["fresh", "cache", "approval-memory", "unavailable", "error", "timeout", "malformed", "sandbox-state-changed"])(
    "does not attach EA to reviewer outcome %s", async (outcome) => {
      const input = candidate();
      expect(await createPluginReadjudicationBasis({ ...input, reviewerVerdict: input.ruleVerdict, reviewerOutcome: outcome })).toBeUndefined();
    },
  );

  it.each([
    undefined,
    { ...INTEGRITY, installSource: "local-dev" as const, signerKeyId: null },
    { ...INTEGRITY, installSource: "git" as const, signerKeyId: null },
    { ...INTEGRITY, installSource: "folder" as const, signerKeyId: null },
    { ...INTEGRITY, artifactSha256: null },
    { ...INTEGRITY, artifactSha256: "unverified" },
    { ...INTEGRITY, signerKeyId: null },
    { ...INTEGRITY, signerKeyId: " " },
  ])("requires actual complete signed-marketplace receipt evidence: %j", async (integrity) => {
    const runtimeInstance = loadedInstance(integrity);
    expect(await createPluginReadjudicationBasis(candidate(subject(), runtimeInstance))).toBeUndefined();
  });

  it("rejects plugin self-report, missing runtime, and another plugin's identity", async () => {
    const input = candidate();
    expect(await createPluginReadjudicationBasis({ ...input, runtimeInstance: { handlers: {}, integrity: INTEGRITY } as RuntimePlugin })).toBeUndefined();
    expect(await createPluginReadjudicationBasis({ ...input, runtimeInstance: undefined })).toBeUndefined();
    expect(await createPluginReadjudicationBasis({ ...input, runtimeInstance: loadedInstance(INTEGRITY, "different-plugin") })).toBeUndefined();
    expect(await createPluginReadjudicationBasis({ ...input, pluginId: undefined })).toBeUndefined();
  });

  it("does not pair an issued classification with a different claimed substrate", () => {
    const input = candidate(subject({
      sandboxCapability: { kind: "none", confidence: "verified", platform: process.platform, reason: "unconfined" },
    }));
    expect(createPluginReadjudicationBasis({ ...input, sandboxCapability: CAPABILITY })).toBeUndefined();
  });

  it.each(["builtin", "mcp"] as const)("does not grant EA to %s source", async (source) => {
    expect(await createPluginReadjudicationBasis(candidate(subject({ source })))).toBeUndefined();
  });

  it.each([
    { command: "rm -rf /" },
    { url: "https://untrusted.example/upload" },
    { path: `${DIRECTORY}/outside/file.bin` },
  ])("keeps concrete effects and danger out of the evidence-gap option: %j", async (finalInput) => {
    const input = subject({ finalInput, allowedDirectories: [`${DIRECTORY}/inside`] });
    expect(await createPluginReadjudicationBasis(candidate(input))).toBeUndefined();
  });

  it.each([
    { ...CAPABILITY, confidence: "assumed" as const },
    { ...CAPABILITY, kind: "none" as const },
    { ...CAPABILITY, kind: "partial" as const },
    { ...CAPABILITY, confines: { filesystem: false, process: true, network: false } },
    { ...CAPABILITY, confines: { filesystem: true, process: false, network: false } },
  ])("requires the decision-time containment evidence: %j", async (sandboxCapability) => {
    expect(await createPluginReadjudicationBasis(candidate(subject({ sandboxCapability })))).toBeUndefined();
  });

  it.each([
    { toolName: "artifact_remove" },
    { sourcePluginId: "different-plugin" },
    { source: "mcp" },
    { toolCategory: "shell" },
    { args: { operation: "remove" } },
    { trustOrigin: "plugin-emitted" },
    { approvalCacheKey: "different-key" },
  ])("binds the issued basis to its exact pending request: %j", async (change) => {
    const basis = await createPluginReadjudicationBasis(candidate());
    expect(matchesPluginReadjudicationBasis(basis, { ...pendingRequest(), ...change })).toBe(false);
  });

  it("does not read replacement evidence when matching an already issued pending basis", async () => {
    const input = candidate();
    const basis = await createPluginReadjudicationBasis(input);
    const differentFactory: RuntimePluginFactory = () => input.runtimeInstance;
    bindPluginInstanceIntegrity(input.runtimeInstance, differentFactory);
    expect(matchesPluginReadjudicationBasis(basis, pendingRequest())).toBe(true);
  });
});
