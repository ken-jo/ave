import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WebContents } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../audit/audit-logger.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { SubAgentRunner } from "../../engine/subagent-runner.js";
import type { LLMProvider, StreamEvent } from "../../engine/llm/types.js";
import { makeSubagentLoopDeps, patchLoopProvider } from "../../engine/__tests__/support/subagent-loop-fixtures.js";
import { HookRunner } from "../../hooks/hook-runner.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { WorkBoardStore } from "../../main/work-board-store.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { approvalSurfaceRegistry } from "../../permissions/approval-surface-registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { workBoardOriginSessionId } from "../../shared/work-board-types.js";
import { createDynamicTool } from "../../tools/base.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createWorkBoardEngine } from "../work-board-engine.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function surface(id: number) {
  const cards: ApprovalRequest[] = [];
  const waiting: Array<{ index: number; resolve: (card: ApprovalRequest) => void }> = [];
  const contents = {
    id, isDestroyed: () => false,
    send: (channel: string, request: ApprovalRequest) => {
      if (channel === "ave:approval:request") {
        cards.push(request);
        for (let index = waiting.length - 1; index >= 0; index -= 1) {
          const waiter = waiting[index];
          const card = cards[waiter.index];
          if (card !== undefined) {
            waiting.splice(index, 1);
            waiter.resolve(card);
          }
        }
      }
    },
  } as unknown as WebContents;
  const waitForCard = (index: number): Promise<ApprovalRequest> => {
    const card = cards[index];
    return card === undefined
      ? new Promise((resolve) => { waiting.push({ index, resolve }); })
      : Promise.resolve(card);
  };
  return { contents, cards, waitForCard };
}

async function boardRun() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-board-owner-")));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  vi.stubEnv("AVE_HOME", join(root, "state"));
  cleanup.push(() => cleanupTmpDir(root));
  const audit = new AuditLogger(join(root, "audit"));
  await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
  cleanup.push(() => audit.close());
  const auditLog = vi.spyOn(audit, "log");
  const gate = new ApprovalGate((sessionId, terminalTabId) => approvalSurfaceRegistry.resolve(sessionId, terminalTabId), undefined, undefined, audit);
  cleanup.push(async () => { gate.disposeAll(); });
  const owner = surface(101);
  const foreign = surface(202);
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({
    name: "board_read", description: "Read the work item", source: "builtin", category: "read",
    jsonSchema: { type: "object", properties: {} },
    execute: async () => ({ output: "work item", isError: false }),
  }));
  const path = join(workspace, "delivered.txt");
  const execute = vi.fn(async () => {
    await writeFile(path, "approved board execution");
    return { output: "wrote the work item", isError: false };
  });
  registry.register(createDynamicTool({
    name: "board_write", description: "Write the work item", source: "builtin", category: "write",
    pathFields: ["path"], jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute,
  }));
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("default");
  const memory = new MemoryManager({ aveDir: join(root, "subagent") });
  memory.load();
  cleanup.push(async () => { memory.closeSearchIndex(); });
  const scripts: StreamEvent[][] = [
    [{ type: "text_delta", text: "Write the approved work item once." }, { type: "message_complete", stopReason: "end_turn" }],
    [{ type: "tool_call", id: "board-write", name: "board_write", input: { path } }, { type: "message_complete", stopReason: "tool_use" }],
    [{ type: "text_delta", text: "Completed the approved work item." }, { type: "message_complete", stopReason: "end_turn" }],
  ];
  const provider: LLMProvider = {
    vendor: "openai",
    async *streamTurn() {
      const events = scripts.shift();
      if (!events) throw new Error("Unexpected model turn");
      yield* events;
    },
  };
  patchLoopProvider(provider);
  const runner = new SubAgentRunner({
    parentDeps: makeSubagentLoopDeps(registry, {
      permissionManager: manager, approvalGate: gate, approvalSurface: "interactive", hookRunner: new HookRunner(), auditLogger: audit,
      getAdditionalDirectories: () => [workspace], getDefaultProject: () => ({ projectRoot: workspace }),
      authorizeProject: (projectRoot) => projectRoot === workspace ? { projectRoot } : null,
    }),
    toolRegistry: registry, subAgentMemoryManager: memory,
  });
  const store = new WorkBoardStore(join(root, "board.json"));
  const created = await store.create({ title: "Deliver the work item", projectRoot: workspace });
  if (created.status !== "created") throw new Error("Unable to create board item");
  const engine = createWorkBoardEngine({ store, getRunner: () => runner, approvalGate: gate, emitProgress: () => undefined });
  const approve = (request: ApprovalRequest, contents: WebContents) => gate.resolveFromDesktopRenderer(request.id, {
    requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac,
  }, contents);
  return { owner, foreign, execute, gate, engine, itemId: created.itemId, auditLog, approve, path, scripts };
}

describe("Work Board registered approval owner", () => {
  it("delivers plan and execution-child cards through the real runner, loop, executor and gate", async () => {
    const f = await boardRun();
    const running = f.engine.runItem(f.itemId, { approvalSurface: f.owner.contents });
    const plan = await f.owner.waitForCard(0);
    expect(f.owner.cards).toHaveLength(1);
    expect(plan.sessionId).toBe(workBoardOriginSessionId(f.itemId));
    expect(plan.toolName).toBe("work_board_run");
    expect(f.foreign.cards).toHaveLength(0);
    expect(f.gate.listPendingRendererRequests(f.foreign.contents)).toEqual([]);
    expect(f.approve(plan, f.foreign.contents)).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.approve(plan, f.owner.contents)?.choice).toBe("allow-once");

    const action = await f.owner.waitForCard(1);
    expect(f.owner.cards).toHaveLength(2);
    expect(action.toolName).toBe("board_write");
    expect(action.sessionId).not.toBe(plan.sessionId);
    expect(approvalSurfaceRegistry.resolve(action.sessionId)).toBe(f.owner.contents);
    expect(f.foreign.cards).toHaveLength(0);
    expect(f.gate.listPendingRendererRequests(f.foreign.contents)).toEqual([]);
    expect(f.approve(action, f.foreign.contents)).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.approve(action, f.owner.contents)?.choice).toBe("allow-once");
    expect((await running).status).toBe("completed");
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await readFile(f.path, "utf8")).toBe("approved board execution");
    expect(f.approve(action, f.owner.contents)).toBeNull();
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.auditLog.mock.calls.filter(([record]) => record.output?.includes("[approval:surface-owner-required]"))).toHaveLength(2);
    expect(approvalSurfaceRegistry.resolve(workBoardOriginSessionId(f.itemId))).toBeNull();
  });

  it("cannot transfer a live board run through a second run request", async () => {
    const f = await boardRun();
    const running = f.engine.runItem(f.itemId, { approvalSurface: f.owner.contents });
    const plan = await f.owner.waitForCard(0);
    expect(f.owner.cards).toHaveLength(1);
    expect((await f.engine.runItem(f.itemId, { approvalSurface: f.foreign.contents })).status).toBe("already_running");
    expect(approvalSurfaceRegistry.resolve(workBoardOriginSessionId(f.itemId))).toBe(f.owner.contents);
    expect(f.gate.listPendingRendererRequests(f.foreign.contents)).toEqual([]);
    f.gate.resolveFromDesktopRenderer(plan.id, { requestId: plan.id, choice: "deny-once", nonce: plan.nonce, hmac: plan.hmac }, f.owner.contents);
    expect((await running).status).toBe("denied");
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("denies a background board plan explicitly when there is no approval surface", async () => {
    const f = await boardRun();
    const result = await f.engine.runItem(f.itemId);
    expect(result.status).toBe("denied");
    expect(result.reason).toBe("Nobody can approve this request; do not retry.");
    expect(f.owner.cards).toHaveLength(0);
    expect(f.foreign.cards).toHaveLength(0);
    expect(f.execute).not.toHaveBeenCalled();
  });
});
