import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowOnceCardAnswer } from "../../../__tests__/support/approval-card-answer.js";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { createConversationLoop } from "../../../boot/conversation.js";
import { CHANNELS, MAIN_CHAT_GROUP_ID, PERMISSIONS } from "../../../contract/app-contract.js";
import { makeSubagentLoopDeps, patchLoopProvider } from "../../../engine/__tests__/support/subagent-loop-fixtures.js";
import type { LLMProvider, StreamEvent } from "../../../engine/llm/types.js";
import { getMainWindow, getMainWindows, registerMainWindow, resetMainWindowsForTests, unregisterMainWindow } from "../../../main/app-state.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST, type ApprovalRequest } from "../../../permissions/approval-gate.js";
import { approvalSurfaceRegistry, updateApprovalSurface } from "../../../permissions/approval-surface-registry.js";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { PermissionTestResources } from "../../../permissions/__tests__/test-resources.js";
import { __resetSessionStoreForTest } from "../../../permissions/user-approval-store.js";
import { makeWriteProbeTool } from "../../../tools/__tests__/approval-memory-test-fixtures.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { registerChatHandlers } from "../chat.js";
import { registerPermissionsHandlers } from "../permissions.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
  session: { defaultSession: { resolveProxy: vi.fn(async () => "DIRECT") } },
}));

const resources = new PermissionTestResources();
const cleanup: Array<() => Promise<void>> = [];

function primarySurface(id: number) {
  const state = { closed: false };
  const cards: ApprovalRequest[] = [];
  const contents = Object.assign(new EventEmitter(), {
    id: id * 100,
    mainFrame: { url: "file:///application/index.html" },
    isDestroyed: () => state.closed,
    send: vi.fn((channel: string, payload: unknown) => {
      if (channel === IPC_APPROVAL_REQUEST) cards.push(payload as ApprovalRequest);
    }),
  });
  const window = { id, webContents: contents, isDestroyed: () => state.closed } as unknown as BrowserWindow;
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  return { state, window, contents, event, cards };
}

function callNative(channel: string, event: IpcMainInvokeEvent, ...args: unknown[]) {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Native adoption handler is missing: ${channel}`);
  return handler(event, ...args);
}

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  resetMainWindowsForTests();
  handlers.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetSessionStoreForTest();
  await resources.cleanup();
});

describe("cached primary conversation adoption", () => {
  it("delivers the next real write approval to the replacement primary and executes once", async () => {
    const root = realpathSync(resources.makeTmpDir("ave-primary-adoption-"));
    vi.stubEnv("AVE_HOME", join(root, "home"));
    const audit = new AuditLogger(join(root, "audit"));
    await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
    const original = primarySurface(31);
    registerMainWindow(original.window, "primary");
    const registry = new ToolRegistry();
    const path = join(root, "adopted-write.txt");
    const write = vi.fn(async () => {
      writeFileSync(path, "written after replacement-window consent");
      return "write completed";
    });
    registry.register(makeWriteProbeTool(write));
    const manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode("default");

    const gate = new ApprovalGate((sessionId, tabId) => approvalSurfaceRegistry.resolve(sessionId, tabId), undefined, undefined, audit);
    const memory = new MemoryManager({ aveDir: join(root, "memory") });
    memory.load();
    const rounds: StreamEvent[][] = [
      [{ type: "tool_call", id: "adopted-write", name: "write_probe", input: { path } }, { type: "message_complete", stopReason: "tool_use" }],
      [{ type: "text_delta", text: "The approved write completed." }, { type: "message_complete", stopReason: "end_turn" }],
    ];
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() {
        const round = rounds.shift();
        if (!round) throw new Error("Unexpected extra adoption model round");
        yield* round;
      },
    };
    patchLoopProvider(provider);
    const unavailableFetch = (async () => { throw new Error("No external transport is configured for this fixture"); }) as typeof fetch;
    const deps = makeSubagentLoopDeps(registry, {
      memoryManager: memory, permissionManager: manager, approvalGate: gate, auditLogger: audit,
      approvalSurface: "interactive", getAdditionalDirectories: () => [root],
      getDefaultProject: () => ({ projectRoot: root }), authorizeProject: (projectRoot) => ({ projectRoot }),
      llmFetch: unavailableFetch, networkFetch: unavailableFetch,
    });
    const loop = createConversationLoop(deps as unknown as Parameters<typeof createConversationLoop>[0]);
    const sessionId = loop.getSessionId();
    const resolveOtherLoop = vi.fn(() => { throw new Error("Adoption must reuse the cached primary loop"); });
    registerChatHandlers({
      ...deps, conversationLoop: loop, getMainWindow, getAppWindows: getMainWindows,
      resolveChatGroupLoop: resolveOtherLoop, releaseChatGroupLoop: () => undefined,
    } as unknown as Parameters<typeof registerChatHandlers>[0]);
    registerPermissionsHandlers({
      ...deps, conversationLoop: loop, approvalGate: gate, auditLogger: audit,
      toolRegistry: registry, getMainWindow, getAppWindows: getMainWindows,
    } as unknown as Parameters<typeof registerPermissionsHandlers>[0]);
    let running: Promise<unknown> | undefined;
    cleanup.push(async () => {
      gate.disposeAll();
      if (running) await Promise.allSettled([running]);
      updateApprovalSurface({ kind: "release", sessionId });
      memory.closeSearchIndex();
      await audit.close();
    });
    expect(approvalSurfaceRegistry.resolve(sessionId)).toBe(original.contents);

    original.state.closed = true;
    unregisterMainWindow(original.window);
    expect(approvalSurfaceRegistry.resolve(sessionId)).toBeNull();
    const replacement = primarySurface(32);
    registerMainWindow(replacement.window, "primary");
    expect(callNative(CHANNELS.chat.getHistory, replacement.event, MAIN_CHAT_GROUP_ID)).toMatchObject({ sessionId, messages: [] });
    expect(loop.getSessionId()).toBe(sessionId);
    expect(resolveOtherLoop).not.toHaveBeenCalled();

    running = Promise.resolve(callNative(CHANNELS.chat.send, replacement.event, {
      input: "Write the approved file once.", inputOrigin: "user-keyboard", userActivation: true,
    }, MAIN_CHAT_GROUP_ID));
    await vi.waitFor(() => expect(replacement.cards).toHaveLength(1));
    expect(original.cards).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(approvalSurfaceRegistry.resolve(sessionId)).toBe(replacement.contents);
    const [card] = replacement.cards;
    expect(card.sessionId).toBe(sessionId);
    expect(callNative(PERMISSIONS.approvalPending, replacement.event)).toHaveLength(1);
    expect(callNative(PERMISSIONS.approvalRespond, replacement.event, allowOnceCardAnswer(card))).toEqual({ ok: true });
    expect(await running).toMatchObject({
      route: "llm", stopReason: "end_turn", text: "The approved write completed.",
      toolCalls: [{ name: "write_probe", input: { path }, result: "write completed" }],
    });
    expect(write).toHaveBeenCalledOnce();
    expect(readFileSync(path, "utf8")).toBe("written after replacement-window consent");
    expect(gate.pendingCount).toBe(0);
    callNative(PERMISSIONS.approvalRespond, replacement.event, allowOnceCardAnswer(card));
    expect(write).toHaveBeenCalledOnce();
  });
});
