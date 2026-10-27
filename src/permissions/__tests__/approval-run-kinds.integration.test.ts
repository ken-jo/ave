import { allowOnceCardAnswer } from "../../__tests__/support/approval-card-answer.js";
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../audit/audit-logger.js";
import {
  createConversationLoop,
  createRoutineConversationLoop,
  createSideChatConversationLoop,
} from "../../boot/conversation.js";
import type { ConversationLoop } from "../../engine/conversation-loop.js";
import { makeSubagentLoopDeps, patchLoopProvider } from "../../engine/__tests__/support/subagent-loop-fixtures.js";
import type { LLMProvider, StreamEvent } from "../../engine/llm/types.js";
import { PARENT_ALL_TOOL_SCOPE, SubAgentRunner } from "../../engine/subagent-runner.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { CHANNELS } from "../../contract/app-contract.js";
import { registerChatHandlers } from "../../ipc/domains/chat.js";
import { registerSideChatHandlers } from "../../ipc/domains/sidechat.js";
import { registerMainWindow, resetMainWindowsForTests } from "../../main/app-state.js";
import { browserTabRegistry } from "../../main/browser/browser-tab-registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { makeWriteProbeTool } from "../../tools/__tests__/approval-memory-test-fixtures.js";
import { userPermissionContext } from "../../tools/__tests__/tool-context-fixture.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { approvalSurfaceRegistry, updateApprovalSurface } from "../approval-surface-registry.js";
import { PermissionManager } from "../permission-manager.js";
import { __resetSessionStoreForTest } from "../user-approval-store.js";
import { PermissionTestResources } from "./test-resources.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler); }) },
  session: { defaultSession: { resolveProxy: vi.fn(async () => "DIRECT") } },
}));

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const resources = new PermissionTestResources();
const closers: Array<() => Promise<void>> = [];

interface ConstructionPath {
  constructor: string;
  factory: string;
  binding: string;
}

function enclosingFunction(node: ts.Node): string {
  for (let owner: ts.Node | undefined = node.parent; owner; owner = owner.parent) {
    if ((ts.isFunctionDeclaration(owner) || ts.isMethodDeclaration(owner)) && owner.name) {
      return owner.name.getText();
    }
  }
  throw new Error("ConversationLoop construction has no named production owner");
}

function bindingFor(node: ts.CallExpression): string {
  if (node.parent && ts.isBinaryExpression(node.parent)) return node.parent.left.getText();
  if (node.parent && ts.isVariableDeclaration(node.parent)) return node.parent.name.getText();
  return node.expression.getText();
}

/** Discover construction sites and their production factory users, including imported aliases. */
function productionConstructionPaths(): ConstructionPath[] {
  const files = readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name)
      && !/\.(?:test|spec)\.tsx?$/.test(entry.name)
      && !/(?:^|[/\\])__(?:tests|probes)__(?:[/\\]|$)/.test(entry.parentPath))
    .map((entry) => join(entry.parentPath, entry.name));
  const parseRoot = resources.makeTmpDir("ave-run-construction-syntax-");
  const config = join(parseRoot, "tsconfig.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: { noResolve: true, noLib: true, types: [] }, files }));
  const api = new API({ cwd: parseRoot });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    const program = snapshot.getProjects()[0]?.program;
    if (!program) throw new Error("Production construction syntax project did not load");
    const sources = files.map((file) => {
      const source = program.getSourceFile(file);
      if (!source) throw new Error(`Production source was not parsed: ${file}`);
      return source;
    });
    const constructors = new Map<string, { file: string }>();
    const bindings = (source: ts.SourceFile): Map<string, string> => {
      const imported = new Map<string, string>();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        if (!/conversation(?:-loop)?\.js$/.test(statement.moduleSpecifier.text)) continue;
        const names = statement.importClause?.namedBindings;
        if (!names || !ts.isNamedImports(names)) continue;
        for (const name of names.elements) imported.set(name.name.text, name.propertyName?.text ?? name.name.text);
      }
      return imported;
    };
    for (const source of sources) {
      const imported = bindings(source);
      const visit = (node: ts.Node): void => {
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && imported.get(node.expression.text) === "ConversationLoop") {
          const owner = enclosingFunction(node);
          if (constructors.has(owner)) throw new Error(`Repeated ConversationLoop construction owner: ${owner}`);
          constructors.set(owner, { file: relative(sourceRoot, source.fileName) });
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
    const paths: ConstructionPath[] = [];
    for (const source of sources) {
      const imported = bindings(source);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
          const factory = imported.get(node.expression.text);
          const site = factory && constructors.get(factory);
          if (factory && site) paths.push({ constructor: `${site.file}#${factory}`, factory, binding: bindingFor(node) });
        }
        node.forEachChild(visit);
      };
      visit(source);
    }
    for (const [owner, site] of constructors) {
      if (!paths.some((path) => path.factory === owner)) {
        paths.push({ constructor: `${site.file}#${owner}`, factory: owner, binding: owner });
      }
    }
    if (paths.length === 0) throw new Error("No production ConversationLoop constructions discovered");
    return paths.sort((a, b) => `${a.constructor}:${a.binding}`.localeCompare(`${b.constructor}:${b.binding}`));
  } finally {
    api.close();
    rmSync(parseRoot, { recursive: true, force: true });
  }
}

const constructionPaths = productionConstructionPaths();

function surface(id: number) {
  return Object.assign(new EventEmitter(), { id, mainFrame: { url: "file:///application/index.html" }, isDestroyed: vi.fn(() => false), send: vi.fn() });
}


class ActionProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *streamTurn(): AsyncIterable<StreamEvent> {
    const turn = this.turns[this.index++];
    if (!turn) throw new Error("Unexpected model turn after the scripted action");
    yield* turn;
  }
}

async function setup() {
  const root = realpathSync(resources.makeTmpDir("ave-approval-run-kind-"));
  vi.stubEnv("AVE_HOME", join(root, "home"));
  const audit = new AuditLogger(join(root, "audit"));
  await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
  const auditLog = vi.spyOn(audit, "log");
  const owner = surface(1);
  const foreign = surface(2);
  const ownerWindow = { id: 101, webContents: owner, isDestroyed: () => false } as unknown as BrowserWindow;
  const foreignWindow = { id: 202, webContents: foreign, isDestroyed: () => false } as unknown as BrowserWindow;
  registerMainWindow(ownerWindow, "primary");
  registerMainWindow(foreignWindow, "secondary");
  const ownerEvent = { sender: owner, senderFrame: owner.mainFrame } as unknown as IpcMainInvokeEvent;
  const gate = new ApprovalGate(approvalSurfaceRegistry.resolve.bind(approvalSurfaceRegistry), undefined, undefined, audit);
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("default");
  manager.setInteractiveAutoApprove("off");
  const registry = new ToolRegistry();
  const execute = vi.fn(async () => "approved action executed");
  registry.register(makeWriteProbeTool(execute));
  registry.register(createDynamicTool({
    name: "read_probe", description: "Read a bounded value", source: "builtin", category: "read",
    isReadOnly: () => true, jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "read value", isError: false }),
  }));
  const memory = new MemoryManager({ aveDir: join(root, "memory") });
  memory.load();
  const deps = makeSubagentLoopDeps(registry, {
    memoryManager: memory, permissionManager: manager, approvalGate: gate, auditLogger: audit,
    approvalSurface: "interactive", getAdditionalDirectories: () => [root],
    getDefaultProject: () => ({ projectRoot: root }),
    authorizeProject: (projectRoot) => ({ projectRoot }),
  });
  const pending: Promise<unknown>[] = [];
  const sessions = new Set<string>();
  closers.push(async () => {
    gate.disposeAll();
    await Promise.allSettled(pending);
    for (const session of sessions) updateApprovalSurface({ kind: "release", sessionId: session });
    await audit.close();
  });
  const start = (loop: ConversationLoop) => {
    sessions.add(loop.sessionId);
    const running = loop.toolExecutor.executeAll([{
      id: randomUUID(), name: "write_probe", input: { path: join(root, "approved.txt") },
    }], {
      sessionId: loop.sessionId, executionCwd: root,
      permissionContext: userPermissionContext({ additionalDirectories: [root], headless: loop.deps.headless, approvalSurface: loop.deps.approvalSurface }),
    });
    pending.push(running);
    return running;
  };
  const proveOwnerApproval = async (running: Promise<unknown>) => {
    pending.push(running);
    await vi.waitFor(() => expect(owner.send.mock.calls.filter(([channel]) => channel === "ave:approval:request")).toHaveLength(1));
    const card = owner.send.mock.calls.find(([channel]) => channel === "ave:approval:request")![1] as ApprovalRequest;
    expect(foreign.send).not.toHaveBeenCalled();
    expect(gate.listPendingRendererRequests(foreign as unknown as WebContents)).toEqual([]);
    expect(gate.listPendingRendererRequests(owner as unknown as WebContents)).toHaveLength(1);
    gate.resolveFromDesktopRenderer(card.id, allowOnceCardAnswer(card), foreign as unknown as WebContents);
    expect(gate.pendingCount).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(auditLog.mock.calls.some(([entry]) => entry.type === "approval" && entry.output?.includes("surface-owner-required"))).toBe(true);
    gate.resolveFromDesktopRenderer(card.id, allowOnceCardAnswer(card), owner as unknown as WebContents);
    await running;
    expect(execute).toHaveBeenCalledOnce();
    expect(gate.pendingCount).toBe(0);
    gate.resolveFromDesktopRenderer(card.id, allowOnceCardAnswer(card), owner as unknown as WebContents);
    expect(execute).toHaveBeenCalledOnce();
  };
  const bindMainHost = (loop: ConversationLoop, grouped: boolean): void => {
    const primary = grouped ? createConversationLoop(deps as Parameters<typeof createConversationLoop>[0]) : loop;
    sessions.add(primary.sessionId);
    registerChatHandlers({
      ...deps, conversationLoop: primary, getMainWindow: () => ownerWindow,
      resolveChatGroupLoop: () => loop, releaseChatGroupLoop: () => undefined,
    } as unknown as Parameters<typeof registerChatHandlers>[0]);
    if (grouped) {
      const checkProvider = handlers.get(CHANNELS.chat.hasProvider);
      if (!checkProvider) throw new Error("Chat group ownership channel was not registered");
      checkProvider(ownerEvent, "approval-tile");
    }
    expect(approvalSurfaceRegistry.resolve(loop.sessionId)).toBe(owner);
  };
  const bindSideHost = async (loop: ConversationLoop, pane: boolean): Promise<void> => {
    const tabId = "terminal:abcdef01-1";
    const rail = pane ? createSideChatConversationLoop({ ...deps, sideChatMemoryManager: memory } as unknown as Parameters<typeof createSideChatConversationLoop>[0]) : loop;
    sessions.add(rail.sessionId);
    registerSideChatHandlers({
      ...deps, conversationLoop: loop, sideChatConversationLoop: rail,
      sideChatMemoryManager: memory, getMainWindow: () => ownerWindow,
      paneChatLoops: {
        resolve: () => loop, get: () => pane ? loop : undefined,
        release: () => undefined, inWindow: () => pane ? [{ tabId, loop }] : [],
        holding: (sessionId: string) => pane && sessionId === loop.sessionId ? { windowId: ownerWindow.id, tabId, loop } : undefined,
        all: () => pane ? [loop] : [],
      },
    } as unknown as Parameters<typeof registerSideChatHandlers>[0]);
    const channel = pane ? CHANNELS.sidechat.endPaneChat : CHANNELS.sidechat.new;
    const handler = handlers.get(channel);
    if (!handler) throw new Error("Side chat ownership channel was not registered");
    expect(await handler(ownerEvent, ...(pane ? [{ tabId, reason: "new" }] : []))).toMatchObject({ ok: true });
    expect(approvalSurfaceRegistry.resolve(loop.sessionId)).toBe(owner);
  };
  return { root, auditLog, owner, foreign, gate, registry, memory, deps, execute, pending, sessions, start, proveOwnerApproval, bindMainHost, bindSideHost };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  resetMainWindowsForTests();
  browserTabRegistry.__reset();
  handlers.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetSessionStoreForTest();
  await resources.cleanup();
});

describe("production run construction approval ownership", () => {
  it("drains a background child whose approval arrives after the gate shuts down", async () => {
    const f = await setup();
    const originSessionId = randomUUID();
    f.sessions.add(originSessionId);
    updateApprovalSurface({ kind: "attach", sessionId: originSessionId, surface: f.owner as unknown as WebContents });
    let release!: () => void;
    let started!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const streaming = new Promise<void>((resolve) => { started = resolve; });
    const provider = new ActionProvider([
      [
        { type: "tool_call", id: "late-write", name: "write_probe", input: { path: join(f.root, "late.txt") } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [{ type: "text_delta", text: "Child stopped" }, { type: "message_complete", stopReason: "end_turn" }],
    ]);
    const streamTurn = provider.streamTurn.bind(provider);
    provider.streamTurn = async function* () { started(); await paused; yield* streamTurn(); };
    patchLoopProvider(provider);
    const childMemory = new MemoryManager({ aveDir: join(f.root, "late-child") });
    childMemory.load();
    const runner = new SubAgentRunner({ parentDeps: f.deps, toolRegistry: f.registry, subAgentMemoryManager: childMemory });
    const running = runner.spawn({
      title: "Late child", instructions: "Perform the bounded action", originSessionId,
      projectRoot: f.root, background: true, toolScope: PARENT_ALL_TOOL_SCOPE, maxRounds: 3,
    }, { onLinked: ({ childSessionId }) => { f.sessions.add(childSessionId); } });
    f.pending.push(running);
    await streaming;
    f.gate.disposeAll();
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    release();
    // Detect admission before awaiting the run so a broken gate fails without its five-minute timer.
    await vi.waitFor(() => expect(settled || f.gate.pendingCount > 0).toBe(true));
    expect(f.gate.pendingCount).toBe(0);
    expect(f.owner.send).not.toHaveBeenCalled();
    await running;
    expect(f.gate.pendingCount).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(constructionPaths)("enforces registered consent for $factory / $binding", async (path) => {
    const f = await setup();
    switch (path.factory) {
      case "createConversationLoop": {
        expect(["conversationLoop", "groupLoop"]).toContain(path.binding);
        const loop = createConversationLoop(f.deps as Parameters<typeof createConversationLoop>[0]);
        f.bindMainHost(loop, path.binding === "groupLoop");
        await f.proveOwnerApproval(f.start(loop));
        break;
      }
      case "createSideChatConversationLoop": {
        expect(["sideChatConversationLoop", "paneLoop"]).toContain(path.binding);
        const loop = createSideChatConversationLoop({ ...f.deps, sideChatMemoryManager: f.memory } as unknown as Parameters<typeof createSideChatConversationLoop>[0]);
        await f.bindSideHost(loop, path.binding === "paneLoop");
        await f.proveOwnerApproval(f.start(loop));
        break;
      }
      case "createRoutineConversationLoop": {
        const loop = createRoutineConversationLoop(f.deps as Parameters<typeof createRoutineConversationLoop>[0]);
        await loop.startRoutineConversation(randomUUID(), "Scheduled approval check", new Date().toISOString());
        expect(loop.deps.headless).toBe(true);
        expect(approvalSurfaceRegistry.resolve(loop.sessionId)).toBeNull();
        const result = await f.start(loop);
        expect(result[0].is_error).toBe(true);
        expect(result[0].content).toContain("no approval surface");
        expect(f.owner.send).not.toHaveBeenCalled();
        expect(f.foreign.send).not.toHaveBeenCalled();
        expect(f.execute).not.toHaveBeenCalled();
        break;
      }
      case "runSpawnChild":
      case "runResume": {
        const originSessionId = randomUUID();
        f.sessions.add(originSessionId);
        updateApprovalSurface({ kind: "attach", sessionId: originSessionId, surface: f.owner as unknown as WebContents });
        const childMemory = new MemoryManager({ aveDir: join(f.root, "subagent") });
        childMemory.load();
        const runner = new SubAgentRunner({ parentDeps: f.deps, toolRegistry: f.registry, subAgentMemoryManager: childMemory });
        const turns: StreamEvent[][] = [];
        if (path.factory === "runResume") turns.push([
          { type: "tool_call", id: "initial-read", name: "read_probe", input: {} },
          { type: "message_complete", stopReason: "tool_use" },
        ]);
        turns.push([
          { type: "tool_call", id: "owned-write", name: "write_probe", input: { path: join(f.root, "child-approved.txt") } },
          { type: "message_complete", stopReason: "tool_use" },
        ], [
          { type: "text_delta", text: "approved child completed" },
          { type: "message_complete", stopReason: "end_turn" },
        ]);
        patchLoopProvider(new ActionProvider(turns));
        const input = { title: "Owned child", instructions: "Perform the bounded action", originSessionId, projectRoot: f.root, toolScope: PARENT_ALL_TOOL_SCOPE, maxRounds: path.factory === "runResume" ? 1 : 3 };
        let running: Promise<unknown>;
        if (path.factory === "runResume") {
          const paused = await runner.spawn(input);
          f.sessions.add(paused.childSessionId);
          expect(paused.stopReason).toBe("round-cap");
          running = runner.resume(paused.childSessionId, "Continue the approved task", input.title, undefined, originSessionId);
        } else {
          running = runner.spawn(input, { onLinked: ({ childSessionId }) => { f.sessions.add(childSessionId); } });
        }
        await f.proveOwnerApproval(running);
        break;
      }
      default:
        throw new Error(`Production run lacks a real approval scenario: ${path.constructor}:${path.binding}`);
    }
  });

  it.each([true, false])("uses the explicit parent owner for a background child, registered owner: %s", async (registered) => {
    const f = await setup();
    const originSessionId = randomUUID();
    f.sessions.add(originSessionId);
    if (registered) updateApprovalSurface({ kind: "attach", sessionId: originSessionId, surface: f.owner as unknown as WebContents });
    const childMemory = new MemoryManager({ aveDir: join(f.root, "background-child") });
    childMemory.load();
    const runner = new SubAgentRunner({ parentDeps: f.deps, toolRegistry: f.registry, subAgentMemoryManager: childMemory });
    patchLoopProvider(new ActionProvider([
      [
        { type: "tool_call", id: "background-write", name: "write_probe", input: { path: join(f.root, "background.txt") } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "text_delta", text: "background child finished" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]));
    const running = runner.spawn({
      title: "Background child", instructions: "Perform the bounded background action",
      originSessionId, projectRoot: f.root, background: true, toolScope: PARENT_ALL_TOOL_SCOPE, maxRounds: 3,
    }, { onLinked: ({ childSessionId }) => { f.sessions.add(childSessionId); } });
    f.pending.push(running);
    if (registered) {
      await f.proveOwnerApproval(running);
    } else {
      const result = await running;
      expect(JSON.stringify(result.entries)).toContain("no approval surface");
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.owner.send).not.toHaveBeenCalled();
      expect(f.foreign.send).not.toHaveBeenCalled();
      expect(f.gate.pendingCount).toBe(0);
      expect(f.auditLog.mock.calls.some(([entry]) => entry.output?.includes("no approval surface"))).toBe(true);
    }
  });
});
