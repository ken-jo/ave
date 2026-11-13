import { describe, expect, it } from "vitest";
import type { AuditLogger } from "../../audit/audit-logger.js";
import { createDynamicTool } from "../../tools/base.js";
import { resolvePluginOperation } from "../../tools/plugin-operation-governance.js";
import { resolveEnforcedCategory } from "../../tools/pipeline/risk-classification.js";
import { decidePermission } from "../decision-pipeline.js";
import { RuleBasedRiskClassifier } from "../reviewer/risk-classifier.js";
import { CLASSIFIER_WIDENING_FIXTURES } from "./fixtures/classifier-widening.js";
import { MODES } from "./fixtures/mode-matrix.js";

const OPERATION_POLICY = { discriminant: "operation", operations: { inspect: { kind: "read", minimumRisk: "read", appVisible: true } } } as const;
const tool = createDynamicTool({
  name: "bounded_inspect", description: "Inspect bounded state", source: "plugin", category: "read", pluginId: "fixture-plugin",
  operationPolicy: OPERATION_POLICY,
  jsonSchema: { type: "object", properties: { operation: { type: "string" }, command: { type: "string" } } },
  execute: async () => ({ output: "state", isError: false }),
});
const auditLogger = { logShadow: () => undefined } as unknown as AuditLogger;
const classifier = new RuleBasedRiskClassifier();

describe("existing plugin invocation decisions", () => {
  it("preserves full category, rule verdict and mode decisions for the command corpus", () => {
    const decisions = CLASSIFIER_WIDENING_FIXTURES.map(({ command }) => {
      const finalInput = { operation: "inspect", command };
      const operation = resolvePluginOperation(OPERATION_POLICY, finalInput, "model");
      const classificationInput = {
        tool, declaredCategory: tool.category, registeredCategoryFloor: tool.category, finalInput, correlationId: "command-corpus",
        hostClassifiesRisk: true, sandboxFsContained: true, auditLogger, operationFloor: operation.rule.minimumRisk,
      };
      const category = resolveEnforcedCategory(classificationInput);
      const verdict = classifier.classify({
        toolName: tool.name, source: tool.source, category, pathFields: [], trustOrigin: "llm-tool-arg", finalInput,
        executionCwd: "/workspace/project", allowedDirectories: ["/workspace/project"], sensitivePathsAdjacent: [],
        sandboxCapability: { kind: "none", confidence: "verified", platform: "darwin", reason: "no isolation", confines: { filesystem: false, process: false, network: false } },
      });
      return {
        command, category, verdict,
        decisions: MODES.flatMap(mode => [false, true].map(headless => ({
          mode, headless,
          decision: decidePermission({
            tool: { name: tool.name, source: tool.source, kind: category }, mode, headless,
            reviewer: { status: "success", level: verdict.level },
          }),
        }))),
      };
    });
    expect(decisions).toHaveLength(CLASSIFIER_WIDENING_FIXTURES.length);
    expect(decisions).toMatchSnapshot();
  });
});
