import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationLoop } from "../conversation-loop.js";
import { SubAgentRunner, exactToolScope } from "../subagent-runner.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { makeSubagentLoopDeps } from "./support/subagent-loop-fixtures.js";
import { bindRemoteControllerToSession, isRemoteControllerAuthorityCurrent } from "../../shared/chat-origin.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";

afterEach(() => vi.restoreAllMocks());

describe("delegated session controller boundary", () => {
  it.each(["spawn", "resume"] as const)("%s preserves content and attendance policy without inheriting controller revocation", async (entry) => {
    const root = mkdtempSync(join(tmpdir(), "subagent-controller-boundary-"));
    const memory = new MemoryManager({ aveDir: root });
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "read_item", description: "Read an item", source: "builtin", category: "read",
      jsonSchema: { type: "object", properties: {} }, execute: async () => ({ output: "value", isError: false }),
    }));
    const runner = new SubAgentRunner({
      parentDeps: makeSubagentLoopDeps(registry), toolRegistry: registry, subAgentMemoryManager: memory,
    });
    vi.spyOn(ConversationLoop.prototype, "hasProvider").mockReturnValue(true);
    vi.spyOn(ConversationLoop.prototype, "refreshProvider").mockImplementation(() => {});
    vi.spyOn(ConversationLoop.prototype, "loadSession").mockResolvedValue(true);
    const runTurn = vi.spyOn(ConversationLoop.prototype, "runTurn");
    const input = { title: "delegated work", instructions: "read the task", toolScope: exactToolScope(["read_item"]) };
    try {
      let resumeId: string | undefined;
      if (entry === "resume") {
        runTurn.mockResolvedValueOnce({ text: "paused", toolCalls: [], route: "default", stopReason: "round-cap" });
        resumeId = (await runner.spawn(input)).childSessionId;
      }
      for (const remote of [false, true]) {
        let current = true;
        const authority = remote ? bindRemoteControllerToSession({
          kind: "tailnet-controller", actorId: "tailnet:delegation-test",
          pairedShare: { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" },
          pairedShareGuard: { isCurrent: () => current },
        }, "parent-session") : undefined;
        const floor = { code: "other-principal" as const, reason: "External guidance" };
        const parentPolicy = { allowExternalHooks: false, headless: true, ownerUnattended: true, floor, remoteControllerAuthority: authority };
        const observe = () => {
          const childPolicy = turnExtensionPolicyContext.getStore();
          expect(childPolicy).toMatchObject({ allowExternalHooks: false, headless: true, ownerUnattended: true, floor });
          expect(childPolicy?.remoteControllerAuthority).toBeUndefined();
          expect(isRemoteControllerAuthorityCurrent(childPolicy?.remoteControllerAuthority)).toBe(true);
        };
        vi.spyOn(ConversationLoop.prototype, "fireLifecycleEvent").mockImplementation(async () => { observe(); });
        runTurn.mockImplementation(async (_text, _callbacks, signal, options) => {
          observe();
          expect(options?.inputOrigin).toBe("llm-tool-arg");
          expect(options?.remoteControllerAuthority).toBeUndefined();
          current = false;
          await Promise.resolve();
          observe();
          expect(signal?.aborted).toBe(false);
          if (authority) expect(isRemoteControllerAuthorityCurrent(authority)).toBe(false);
          return { text: "paused", toolCalls: [], route: "default", stopReason: "round-cap" };
        });
        await turnExtensionPolicyContext.run(parentPolicy, async () => {
          const result = entry === "spawn" ? await runner.spawn(input) : await runner.resume(resumeId!, "continue", input.title);
          expect(result).toMatchObject({ ok: true, stopReason: "round-cap" });
          expect(turnExtensionPolicyContext.getStore()).toBe(parentPolicy);
        });
      }
    } finally {
      memory.closeSearchIndex();
      await cleanupTmpDir(root);
    }
  });
});
