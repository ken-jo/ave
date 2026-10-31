// App guidance enters at round boundaries and stages the remaining turn origin.
// User guidance must not inherit app permission requirements or provenance.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { formatAppMessageEnvelope } from "../../shared/mcp-app-message-source.js";
import type { PostTurnHookContext } from "../../hooks/post-turn-hook-chain.js";
import { endTurnScript } from "./conversation-loop-test-helpers.js";
import { makeBasicConversationLoopDeps, ScriptedTurnProvider as FakeProvider } from "./support/conversation-loop-fixtures.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { createHookCommandAuthorizer } from "../../hooks/hook-command-policy.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import type { ApprovalRequestInput } from "../../permissions/approval-gate.js";

import { userKeyboardTurn } from "../../__tests__/support/user-keyboard-turn.js";

const hookRoots: string[] = [];
afterEach(async () => {
  for (const root of hookRoots.splice(0)) await cleanupTmpDir(root);
});

function twoToolRounds(): FakeProvider {
  return new FakeProvider([
    [
      { type: "tool_call", id: "t1", name: "noop_tool", input: {},
      } as StreamEvent,
      { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
    ],
    [
      { type: "tool_call", id: "t2", name: "noop_tool", input: {},
      } as StreamEvent,
      { type: "message_complete", stopReason: "tool_use" } as StreamEvent,
    ],
    [
      { type: "text_delta", text: "done" } as StreamEvent,
      { type: "message_complete", stopReason: "end_turn" } as StreamEvent,
    ],
  ]);
}

interface ExecCall {
  overlayTriggerOrigin: string | null;
  trustOrigin: string;
}

function makePostTurnHookSpy() {
  const run = vi.fn(async (ctx: PostTurnHookContext) => ({
    detector: {
      cleanedText: ctx.output,
      newTitle: null,
      checkpointSuggested: false,
    },
    messagesForPersistence: ctx.messages,
  }));
  return { run };
}

function makeLoop(provider: LLMProvider, overrides: Record<string, unknown> = {}): { loop: ConversationLoop; execCalls: ExecCall[];
} {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(createDynamicTool({
    name: "noop_tool",
    description: "no-op",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "ok", isError: false }),
  }),
  );
  const loop = new ConversationLoop(makeBasicConversationLoopDeps({
    toolRegistry,
    ...overrides,
  }));
  (loop as { provider: LLMProvider | null }).provider = provider;

  const execCalls: ExecCall[] = [];
  const executor = (loop as unknown as {
    toolExecutor: {
      executeAll: (
        uses: unknown,
        opts: { overlayTriggerOrigin?: string | null; permissionContext?: { trustOrigin?: string };
          },
      ) => Promise<unknown>;
    };
  }).toolExecutor;
  const original = executor.executeAll.bind(executor);
  executor.executeAll = (uses, opts) => {
    execCalls.push({
      overlayTriggerOrigin: opts.overlayTriggerOrigin ?? null,
      trustOrigin: String(opts.permissionContext?.trustOrigin),
    });
    return original(uses, opts);
  };
  return { loop, execCalls };
}

describe("MCP-app guidance downgrades the rest of the turn", () => {
  it("forces the actual Stop hook after staged guidance and isolates the next clean turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "ave-lifecycle-guidance-"));
    hookRoots.push(root);
    const permissions = new PermissionManager(join(root, "permissions.json"));
    permissions.setMode("allow");
    const hooks = new ScriptHookManager();
    const hookApproval = vi.fn(async (request: ApprovalRequestInput) => ({ requestId: request.id, choice: "allow-once" as const }));
    hooks.setCommandAuthorizer(createHookCommandAuthorizer({ permissionManager: permissions, approvalGate: { requestAndWait: hookApproval } }));
    hooks.setTrustedRegistry([], [{ id: "stop-guidance", event: "Stop", source: "config",
      command: ["node", resolve(__dirname, "../../../test/fixtures/hooks/contract-command.cjs"), "echo"], timeoutMs: 5000 }]);
    const lifecycleOrigins: Array<{ event: string; floor: string | undefined }> = [];
    const lifecycle = hooks.runLifecycleEvent.bind(hooks);
    vi.spyOn(hooks, "runLifecycleEvent").mockImplementation((event, ...args) => {
      lifecycleOrigins.push({ event, floor: turnExtensionPolicyContext.getStore()?.floor?.code });
      return lifecycle(event, ...args);
    });
    const targetApproval = vi.fn(async (request: ApprovalRequestInput) => ({ requestId: request.id, choice: "allow-once" as const }));
    const { loop } = makeLoop(twoToolRounds(), { permissionManager: permissions, scriptHookManager: hooks,
      approvalGate: { requestAndWait: targetApproval } });
    const turn = loop.runTurn("Follow the current task", {}, undefined, { ...userKeyboardTurn() });
    await Promise.resolve();
    loop.queueGuidance(formatAppMessageEnvelope("read an external update", "app:cards"));
    await turn;
    expect(hookApproval).toHaveBeenCalledOnce();
    expect(hookApproval.mock.calls[0]?.[0]).toMatchObject({ forceExplicit: true,
      allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false });
    expect(lifecycleOrigins).toEqual(expect.arrayContaining([
      { event: "Stop", floor: "other-principal" }, { event: "Notification", floor: "other-principal" },
    ]));
    hookApproval.mockClear();
    lifecycleOrigins.length = 0;
    (loop as { provider: LLMProvider | null }).provider = new FakeProvider(endTurnScript("clean response"));
    await loop.runTurn("A clean follow-up", {}, undefined, { ...userKeyboardTurn() });
    expect(hookApproval).not.toHaveBeenCalled();
    expect(lifecycleOrigins.filter(({ event }) => event === "Stop" || event === "Notification").every(({ floor }) => floor === undefined)).toBe(true);
  });

  it("app-enveloped guidance ⇒ staged origin `app:<serverId>` + `app-emitted` trust from that round on", async () => {
    const { loop, execCalls } = makeLoop(twoToolRounds());

    const turn = loop.runTurn("사용자 질문", {}, undefined, { ...userKeyboardTurn(),
    });
    await Promise.resolve();
    loop.queueGuidance(formatAppMessageEnvelope("open the invoice", "app:acme-cards"),
    );
    await turn;

    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]).toEqual({ overlayTriggerOrigin: null, trustOrigin: "llm-tool-arg",
    });
    expect(execCalls[1]).toEqual({
      overlayTriggerOrigin: "app:acme-cards",
      trustOrigin: "app-emitted",
    });
  });

  it("passes staged app guidance taint through queryLoop into the post-turn capture boundary", async () => {
    const postTurnHookChain = makePostTurnHookSpy();
    const { loop } = makeLoop(twoToolRounds(), { postTurnHookChain });

    const turn = loop.runTurn("사용자 질문", {}, undefined, { ...userKeyboardTurn(),
    });
    await Promise.resolve();
    loop.queueGuidance(formatAppMessageEnvelope("open the invoice", "app:acme-cards"),
    );
    await turn;

    expect(postTurnHookChain.run).toHaveBeenCalledOnce();
    const context = postTurnHookChain.run.mock.calls[0]?.[0] as PostTurnHookContext;
    expect(context.input).toBe("사용자 질문");
    expect(context.inputOrigin).toBe("user-keyboard");
    expect(context.stopReason).toBe("end_turn");
    expect(context.memoryCaptureTaint).toEqual(
      expect.arrayContaining(["staged-guidance"]),
    );
  });

  it("a user-typed guide does NOT downgrade the turn (control)", async () => {
    const { loop, execCalls } = makeLoop(twoToolRounds());

    const turn = loop.runTurn("사용자 질문", {}, undefined, { ...userKeyboardTurn(),
    });
    await Promise.resolve();
    loop.queueGuidance("더 짧게 요약");
    await turn;

    expect(execCalls).toHaveLength(2);
    expect(execCalls[1]).toEqual({ overlayTriggerOrigin: null, trustOrigin: "llm-tool-arg",
    });
  });

  it("preserves attachment and initial-guidance taint for a keyboard turn", async () => {
    const postTurnHookChain = makePostTurnHookSpy();
    const provider = new FakeProvider(endTurnScript("done"));
    const { loop } = makeLoop(provider, { postTurnHookChain });

    await loop.runTurn("사용자 질문", {}, undefined, {
      ...userKeyboardTurn(),
      attachments: [{ type: "text", text: "첨부된 원문" }],
      initialGuidance: "호스트가 부가한 컨텍스트",
    });

    expect(postTurnHookChain.run).toHaveBeenCalledOnce();
    const context = postTurnHookChain.run.mock.calls[0]?.[0] as PostTurnHookContext;
    expect(context.input).toBe("사용자 질문");
    expect(context.inputOrigin).toBe("user-keyboard");
    expect(context.memoryCaptureTaint).toEqual(
      expect.arrayContaining(["attachment", "initial-guidance"]),
    );
  });

});
