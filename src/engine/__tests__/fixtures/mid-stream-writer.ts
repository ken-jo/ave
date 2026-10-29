// Kill-test child: argv <aveDir> <sessionId> <toolRounds> <mode>.
// Reports stream snapshots only after persistence; tool-hang mode waits inside a tool.
import "../../../__tests__/vitest-model-catalog.js";
import { setTimeout as delay } from "node:timers/promises";
import { InputClassifier } from "../../../core/input-classifier.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { ConversationLoop } from "../../conversation-loop.js";
import { userKeyboardTurn } from "../../../__tests__/support/user-keyboard-turn.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../../llm/types.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createDynamicTool } from "../../../tools/base.js";
import { join } from "node:path";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";

const [aveDir, sessionId, toolRoundsArg, mode] = process.argv.slice(2);
const toolRounds = Number(toolRoundsArg);
if (!aveDir || !sessionId || !Number.isInteger(toolRounds) || (mode !== "stream" && mode !== "tool-hang")) {
  throw new Error("usage: mid-stream-writer <aveDir> <sessionId> <toolRounds> <stream|tool-hang>");
}

class KillTestProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private round = 0;

  async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const round = this.round++;
    process.stdout.write(`ROUND ${round}\n`);
    if (round < toolRounds) {
      yield { type: "text_delta", text: `round ${round} text` };
      if (round === toolRounds - 1 && mode === "tool-hang") {
        yield { type: "tool_call", id: "batch-completed", name: "work_tool", input: { round } };
      }
      yield { type: "tool_call", id: `call-${round}`, name: round === toolRounds - 1 && mode === "tool-hang" ? "hang_tool" : "work_tool", input: { round } };
      yield { type: "message_complete", stopReason: "tool_use" };
      return;
    }
    for (let chunk = 0; ; chunk += 1) {
      yield { type: "text_delta", text: `chunk-${chunk} ` };
      process.stdout.write(`STREAMED ${chunk}\n`);
      await delay(25);
    }
  }
}

const toolRegistry = new ToolRegistry();
toolRegistry.register(createDynamicTool({
  name: "work_tool",
  description: "returns immediately",
  source: "builtin",
  category: "read",
  isReadOnly: () => true,
  jsonSchema: { type: "object", properties: {} },
  execute: async (input) => ({ output: `work output ${JSON.stringify(input)}`, isError: false }),
}));
toolRegistry.register(createDynamicTool({
  name: "hang_tool",
  description: "never returns",
  source: "builtin",
  category: "read",
  isReadOnly: () => true,
  jsonSchema: { type: "object", properties: {} },
  execute: async () => {
    process.stdout.write("TOOL_RUNNING\n");
    await new Promise<never>(() => undefined);
    return { output: "unreachable", isError: false };
  },
}));

const memoryManager = new MemoryManager({ aveDir });
// Announce only persisted chunk snapshots so the parent can kill without guessing a delay.
const writeTurnPartial = memoryManager.writeTurnPartial.bind(memoryManager);
memoryManager.writeTurnPartial = async (...args) => {
  await writeTurnPartial(...args);
  if (args[2]?.content.startsWith("chunk-")) process.stdout.write("CHUNK_SNAPSHOT_SAVED\n");
};

const loop = new ConversationLoop({
  settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
  systemPromptBuilder: { build: () => "system" },
  inputClassifier: new InputClassifier(),
  routeEngine: new RouteEngine(),
  toolRegistry,
  permissionManager: new PermissionManager(join(aveDir, "permissions.json")),
  memoryManager,
} as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
(loop as unknown as { provider: LLMProvider | null }).provider = new KillTestProvider();
loop.replaceSessionIdentity(sessionId);

await loop.runTurn("kill test question", undefined, undefined, userKeyboardTurn());
process.stdout.write("TURN_ENDED\n");
