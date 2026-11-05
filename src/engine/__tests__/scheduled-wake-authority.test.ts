// A scheduled wake turn runs without the woken chat's session authority (permission tree: delegated work). That must hold inside the
// real ConversationLoop.runTurn, and for a background child the woken turn spawns, after the wake itself has ended.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ConversationLoop } from "../conversation-loop.js";
import { SubAgentRunner, exactToolScope } from "../subagent-runner.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { EgressGrantStore } from "../../permissions/egress-grants.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { inScheduledWake } from "../../__tests__/support/scheduled-wake.js";
import { makeSubagentLoopDeps, patchLoopProvider } from "./support/subagent-loop-fixtures.js";
import { sessionAuthorityWithheld, turnExtensionPolicyContext, withholdSessionAuthorityFor } from "../../shared/turn-extension-policy.js";

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  constructor(private readonly turns: StreamEvent[][], private readonly gate: Promise<void> = Promise.resolve()) {}
  async *streamTurn(): AsyncIterable<StreamEvent> {
    await this.gate;
    const turn = this.turns[this.index++];
    if (!turn) throw new Error("unexpected model turn");
    yield* turn;
  }
}

const probeTurns = (): StreamEvent[][] => [
  [{ type: "tool_call", id: randomUUID(), name: "probe", input: {} }, { type: "message_complete", stopReason: "tool_use" }],
  [{ type: "text_delta", text: "done" }, { type: "message_complete", stopReason: "end_turn" }],
];

let root: string;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await cleanupTmpDir(root);
});

async function fixture() {
  root = mkdtempSync(join(tmpdir(), "ave-wake-authority-"));
  const projectRoot = join(root, "project");
  mkdirSync(projectRoot);
  // A session egress grant of the woken chat: the probe asks whether it applies from inside the turn.
  const CHAT = randomUUID();
  const store = new EgressGrantStore(join(root, "shell-egress-hosts.json"));
  const scopes = ["once", "session", "project", "always"] as const;
  const github = { host: "github.com", port: 443 };
  const subject = { token: "3".repeat(32), sessionId: CHAT, tabId: undefined, projectRoot, origin: "shell" as const };
  await store.grant("session", scopes, subject, github);
  const seen: Array<{ withheld: boolean; grant: string | undefined }> = [];
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: "probe", description: "Probe the policy", source: "builtin", category: "read", isReadOnly: () => true,
    jsonSchema: { type: "object", properties: {} },
    execute: async () => {
      seen.push({ withheld: sessionAuthorityWithheld(), grant: await store.matchingScope(subject, github, scopes) });
      return { output: "ok", isError: false };
    },
  }));
  const memory = new MemoryManager({ aveDir: join(root, "memory") });
  memory.load();
  const permissionManager = new PermissionManager(join(root, "permissions.json"));
  permissionManager.setMode("default");
  const deps = makeSubagentLoopDeps(registry, { memoryManager: memory, permissionManager });
  return { CHAT, registry, memory, seen, projectRoot, deps };
}

describe("scheduled wake authority", () => {
  it("reaches the tool calls of the real runTurn", async () => {
    const f = await fixture();
    patchLoopProvider(new ScriptedProvider(probeTurns()));
    const loop = new ConversationLoop(f.deps);
    await inScheduledWake(() => loop.runTurn("check", undefined, undefined, { inputOrigin: "plugin-emitted" }));
    expect(f.seen).toEqual([{ withheld: true, grant: undefined }]);
    f.memory.closeSearchIndex();
  });

  it("stays on a background child the woken turn spawned, after the wake has ended", async () => {
    const f = await fixture();
    let open!: () => void;
    patchLoopProvider(new ScriptedProvider(probeTurns(), new Promise<void>((resolve) => { open = resolve; })));
    const runner = new SubAgentRunner({ parentDeps: f.deps, toolRegistry: f.registry, subAgentMemoryManager: f.memory });
    let childSessionId: string | undefined;
    const release = withholdSessionAuthorityFor(f.CHAT);
    const running = inScheduledWake(() => runner.spawn({
      title: "Background check", instructions: "probe", originSessionId: f.CHAT, projectRoot: f.projectRoot,
      background: true, toolScope: exactToolScope(["probe"]), maxRounds: 3,
    }, { onLinked: ({ childSessionId: id }) => { childSessionId = id; } }));
    // The wake ends: its finally releases the chat's id, and nothing after this runs in the wake's context.
    release();
    await turnExtensionPolicyContext.exit(async () => {
      open();
      await running;
      expect(f.seen).toEqual([{ withheld: true, grant: undefined }]);
      expect(childSessionId).toBeDefined();
      // The child itself carries the withhold for its lifetime, not only while its async chain lasts.
      expect(sessionAuthorityWithheld(childSessionId)).toBe(true);
      expect(sessionAuthorityWithheld(f.CHAT)).toBe(false);
    });
    f.memory.closeSearchIndex();
  });
});
