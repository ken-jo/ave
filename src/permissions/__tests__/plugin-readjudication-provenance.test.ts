import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import {
  matchesStaticMissingWritePathVerdict,
  RuleBasedRiskClassifier,
  type ToolInvocationContext,
} from "../reviewer/risk-classifier.js";

const DIRECTORY = realpathSync(tmpdir());

function invocation(overrides: Partial<ToolInvocationContext> = {}): ToolInvocationContext {
  return {
    toolName: "artifact_publish", source: "plugin", category: "write",
    pathFields: ["path"], trustOrigin: "llm-tool-arg", finalInput: { operation: "publish" },
    executionCwd: DIRECTORY, allowedDirectories: [DIRECTORY], sensitivePathsAdjacent: [],
    sandboxCapability: { kind: "none", confidence: "verified", platform: process.platform, reason: "no process confinement" },
    ownerPluginSandboxRoot: `${DIRECTORY}/fixture-artifact-data`,
    ...overrides,
  };
}

describe("static missing-path provenance", () => {
  it("keeps an opaque classification receipt without changing the enumerable verdict", () => {
    const input = invocation();
    const verdict = new RuleBasedRiskClassifier().classify(input);
    expect(verdict).toEqual({ level: "high", reason: "write path not declared" });
    expect(matchesStaticMissingWritePathVerdict(verdict, input)).toBe(true);
    expect(Object.keys(verdict).sort()).toEqual(["level", "reason"]);
    expect(matchesStaticMissingWritePathVerdict({ ...verdict }, input)).toBe(false);
  });

  it("retains the actual static reason when display wording is replaced", () => {
    const input = invocation({ permissionReason: "The project policy requires a human decision." });
    const verdict = new RuleBasedRiskClassifier().classify(input);
    expect(verdict).toEqual({ level: "high", reason: input.permissionReason });
    expect(matchesStaticMissingWritePathVerdict(verdict, input)).toBe(true);
  });

  it("does not turn another HIGH into missing-path evidence through display text", () => {
    const input = invocation({
      source: "builtin", ownerPluginSandboxRoot: undefined,
      finalInput: { path: `${DIRECTORY}/outside-proof/file.bin` }, allowedDirectories: [`${DIRECTORY}/inside-proof`],
      permissionReason: "write path not declared",
    });
    const verdict = new RuleBasedRiskClassifier().classify(input);
    expect(verdict).toEqual({ level: "high", reason: "write path not declared" });
    expect(matchesStaticMissingWritePathVerdict(verdict, input)).toBe(false);
  });

  it.each([
    { toolName: "artifact_remove" },
    { source: "mcp" },
    { category: "shell" },
    { trustOrigin: "plugin-emitted" },
    { finalInput: { operation: "remove" } },
    { executionCwd: `${DIRECTORY}/different-project` },
  ])("binds provenance to the exact classified subject: %j", (change) => {
    const input = invocation();
    const verdict = new RuleBasedRiskClassifier().classify(input);
    expect(matchesStaticMissingWritePathVerdict(verdict, { ...input, ...change })).toBe(false);
  });

  it("rejects mutation after classification", () => {
    const input = invocation();
    const verdict = new RuleBasedRiskClassifier().classify(input);
    input.finalInput.operation = "remove";
    expect(matchesStaticMissingWritePathVerdict(verdict, input)).toBe(false);
  });

  it.each(["cyclic", "bigint"])("preserves the HIGH decision without issuing evidence for %s input", (kind) => {
    const finalInput: Record<string, unknown> = kind === "bigint" ? { value: 1n } : {};
    if (kind === "cyclic") finalInput.self = finalInput;
    const input = invocation({ finalInput });
    const verdict = new RuleBasedRiskClassifier().classify(input);
    expect(verdict).toEqual({ level: "high", reason: "write path not declared" });
    expect(matchesStaticMissingWritePathVerdict(verdict, input)).toBe(false);
  });

  it("retains HIGH without issuing colliding consent identities beyond the exact nesting bound", () => {
    const inputAtDepth = (leaf: string) => {
      let nested: Record<string, unknown> = { leaf };
      for (let depth = 0; depth < 105; depth += 1) nested = { nested };
      return invocation({ finalInput: nested });
    };
    const first = inputAtDepth("publish");
    const second = inputAtDepth("remove");
    const classifier = new RuleBasedRiskClassifier();
    const firstVerdict = classifier.classify(first);
    const secondVerdict = classifier.classify(second);
    expect(firstVerdict).toEqual({ level: "high", reason: "write path not declared" });
    expect(secondVerdict).toEqual(firstVerdict);
    expect(matchesStaticMissingWritePathVerdict(firstVerdict, first)).toBe(false);
    expect(matchesStaticMissingWritePathVerdict(firstVerdict, second)).toBe(false);
    expect(matchesStaticMissingWritePathVerdict(secondVerdict, second)).toBe(false);
  });
});
