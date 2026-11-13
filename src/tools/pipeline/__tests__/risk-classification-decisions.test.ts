import { describe, expect, it } from "vitest";
import { CLASSIFIER_WIDENING_FIXTURES } from "../../../permissions/__tests__/fixtures/classifier-widening.js";
import { decidePermission } from "../../../permissions/decision-pipeline.js";
import { createDynamicTool } from "../../base.js";
import { resolvePluginOperation } from "../../plugin-operation-governance.js";
import { resolveEnforcedCategory } from "../risk-classification.js";

describe("registered risk floor decisions", () => {
  it("preserves governed plugin decisions across the command fixtures", () => {
    const operationPolicy = {
      discriminant: "operation",
      operations: { status: { kind: "read", minimumRisk: "read", appVisible: true } },
    } as const;
    const tool = createDynamicTool({
      name: "domain_read", source: "plugin", category: "write", pluginId: "sampleportal",
      description: "Read domain state", jsonSchema: { type: "object" },
      operationPolicy,
      execute: async () => ({ output: "state", isError: false }),
    });
    const decisions = CLASSIFIER_WIDENING_FIXTURES.map(({ command }) => {
      const finalInput = { operation: "status", command };
      const operation = resolvePluginOperation(operationPolicy, finalInput, "model");
      const category = resolveEnforcedCategory({
        tool, registeredCategoryFloor: tool.category, finalInput,
        sandboxFsContained: true,
        operationFloor: operation.rule.minimumRisk,
      });
      return { command, category, decision: decidePermission({
        tool: { name: tool.name, source: tool.source, kind: category }, mode: "strict", headless: false,
      }) };
    });
    expect(decisions).toHaveLength(59);
    expect(decisions).toMatchSnapshot();
  });
});
