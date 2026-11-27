import type { OutputRefusal } from "../work-board/workflow/requested-outputs.js";
import { STAGE_REQUEST_OUTPUT_TOOL, type RequestedOutputDecl } from "../shared/workflow-template-types.js";
import type { Tool } from "./base.js";

type OutputIntake = (input: unknown) => Promise<{ ok: true; id: string } | { ok: false; code: OutputRefusal }>;

export function createStageRequestOutputTool(declarations: readonly RequestedOutputDecl[], accept: OutputIntake): Tool {
  return {
    name: STAGE_REQUEST_OUTPUT_TOOL,
    source: "builtin",
    category: "read",
    version: "1.0.0",
    description: `Record an output for the human gate. Submit a prose stage result as usual. Targets: ${JSON.stringify(declarations)}`,
    toJsonSchema: () => ({
      type: "object",
      properties: {
        toolName: { type: "string" },
        owner: { enum: ["server", "plugin", "host"] },
        ownerId: { type: "string" },
        args: { type: "object" },
        files: { type: "array", items: { type: "string" }, maxItems: 5000, description: "Paths relative to the stage workspace." },
        summary: { type: "string", maxLength: 400 },
      },
      required: ["toolName", "owner", "ownerId", "args", "summary"],
      additionalProperties: false,
    }),
    isReadOnly: () => true,
    async execute(input) {
      const result = await accept(input);
      return { output: JSON.stringify(result.ok ? { id: result.id } : { reasonCode: result.code }), isError: !result.ok };
    },
  };
}
