import { InputClassifier } from "../../../core/input-classifier.js";
import { RouteEngine } from "../../../core/route-engine.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { fakeLlmSettings } from "../../../shared/__tests__/fake-llm-settings.js";
import type { ConversationLoopDeps } from "../../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../../llm/types.js";
import { afterEach } from "vitest";
import { join } from "node:path";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../../permissions/approval-gate.js";
import { PermissionTestResources } from "../../../permissions/__tests__/test-resources.js";
import { allowOnceCardAnswer } from "../../../__tests__/support/approval-card-answer.js";

const permissionResources = new PermissionTestResources();
const approvalGates = new Set<ApprovalGate>();

afterEach(async () => {
  for (const gate of approvalGates) gate.disposeAll();
  approvalGates.clear();
  await permissionResources.cleanup();
});

/** Exercise tool execution through real permission decisions and native one-shot approval. */
export function makeConversationPermissionDeps(choice: "allow-once" | "deny-once" = "allow-once"): Pick<ConversationLoopDeps, "permissionManager" | "approvalGate"> {
  const directory = permissionResources.makeTmpDir("ave-conversation-permissions-");
  const permissionManager = new PermissionManager(join(directory, "permissions.json"));
  permissionManager.setMode("allow");
  const contents = {
    isDestroyed: () => false,
    send: (channel: string, card: ApprovalRequest) => {
      if (channel === IPC_APPROVAL_REQUEST) queueMicrotask(() => {
        approvalGate.resolveFromDesktopRenderer(card.id, { ...allowOnceCardAnswer(card), choice }, contents as never);
      });
    },
  };
  const approvalGate = new ApprovalGate(contents as never);
  approvalGates.add(approvalGate);
  return { permissionManager, approvalGate };
}

export class ScriptedTurnProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

export function makeBasicConversationLoopDeps(
  overrides: Record<string, unknown> = {},
): ConversationLoopDeps {
  return {
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system" },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry: new ToolRegistry(),
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
    ...makeConversationPermissionDeps(),
    ...overrides,
  } as unknown as ConversationLoopDeps;
}
