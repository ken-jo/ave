/**
 * A real conversation turn in its own process, for the kill test
 * (`conversation-loop-kill-durability.test.ts`): the parent SIGKILLs this
 * process mid-turn and then reads what it left on disk.
 *
 * argv: <aveDir> <sessionId> <toolRounds> <mode>
 *   mode "stream":    after the tool rounds, stream text forever, one chunk
 *                     every 25 ms, printing `STREAMED <n>` after each chunk
 *                     and `CHUNK_SNAPSHOT_SAVED` each time a snapshot of
 *                     that text has reached the disk.
 *   mode "tool-hang": the last tool round's tool never returns; prints
 *                     `TOOL_RUNNING` once it has started.
 * Prints `ROUND <i>` as each provider round starts.
 */
// The same process setup the test runner gives a test file: the bundled model
// catalog the turn resolves its model against.
import "../../../__tests__/vitest-model-catalog.js";
import { setTimeout as delay } from "node:timers/promises";
import { InputClassifier } from "../../../core/input-classifier.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { ConversationLoop } from "../../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../../llm/types.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createDynamicTool } from "../../../tools/base.js";
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
// Announce each snapshot of the chunk stream only after it is on disk, so the
// parent can kill at a point where recovery is guaranteed to find one instead
// of guessing a delay. The tool rounds' own text snapshots are not announced.
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
  memoryManager,
} as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
(loop as unknown as { provider: LLMProvider | null }).provider = new KillTestProvider();
(loop as unknown as { sessionId: string }).sessionId = sessionId;

await loop.runTurn("kill test question", undefined, undefined, { inputOrigin: "user-keyboard" });
process.stdout.write("TURN_ENDED\n");
