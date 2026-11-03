// The work-approvals projection over real stores in a temp dir: which decisions a project sees, the all-project badge total, clear failures for
// a missing source, and the change signal from every write path (IPC, plugin HostApi, scheduler, memory capture).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WORK_APPROVALS } from "../../../shared/ipc-channels.js";
import { hostFrameEvent, untrustedEvent } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { WorkBoardStore } from "../../../main/work-board-store.js";
import { RoutinesStore } from "../../../main/routines-store.js";
import { MemoryManager } from "../../../memory/memory-manager.js";
import type { WorkApprovalListResult, WorkApprovalView } from "../../../shared/work-approvals-types.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const PROJECT_A = "/work/project-a";
const PROJECT_B = "/work/project-b";
const PROJECT_GONE = "/work/project-gone";
const DEFAULT_ROOT = "/work/default";

vi.mock("../../../main/project-root-authorization.js", () => ({
  resolveAuthorizedWorkspaceProject: vi.fn((root?: string) => {
    if (root === undefined || root === PROJECT_A) {
      return { authorized: true, project: { projectRoot: PROJECT_A, projectName: "project-a" } };
    }
    if (root === DEFAULT_ROOT) {
      return { authorized: true, project: { projectRoot: DEFAULT_ROOT, projectName: "default", isDefault: true } };
    }
    return { authorized: false, project: null };
  }),
  listAuthorizedWorkspaceProjects: vi.fn(() => [
    { projectRoot: DEFAULT_ROOT, projectName: "default", isDefault: true },
    { projectRoot: PROJECT_A, projectName: "project-a" },
    { projectRoot: PROJECT_B, projectName: "project-b" },
  ]),
}));

vi.mock("../../../main/default-workspace-root.js", () => ({
  isDefaultWorkspaceRoot: (root: string) => root === DEFAULT_ROOT,
}));

const INDEXER = { pluginId: "indexer", pluginLabel: "Indexer", grantedKinds: ["stale-index"] };
const PROPOSAL = {
  kind: "stale-index",
  key: "folder:reports",
  title: "Re-index the reports folder",
  summary: "18 files changed since the last scan.",
  state: "Last scanned 12 days ago.",
  taskBrief: "PRIVATE-TASK-BRIEF re-run the folder scan.",
};

let dir: string;
let workBoardStore: WorkBoardStore;
let routinesStore: RoutinesStore;
let memoryManager: MemoryManager;
let send: ReturnType<typeof vi.fn>;

function windowStub() {
  send = vi.fn();
  return { isDestroyed: () => false, webContents: { send, isDestroyed: () => false } };
}

async function register(overrides: Record<string, unknown> = {}) {
  handlers.clear();
  const { registerWorkApprovalsHandlers } = await import("../work-approvals.js");
  const win = windowStub();
  registerWorkApprovalsHandlers({
    workBoardStore,
    routinesStore,
    memoryManager,
    auditLogger: { log: vi.fn() },
    getMainWindow: () => win,
    getAppWindows: () => [win],
    ...overrides,
  } as never);
}

async function list(arg?: unknown, event = hostFrameEvent()): Promise<WorkApprovalListResult> {
  const fn = handlers.get(WORK_APPROVALS.list);
  if (!fn) throw new Error("work-approvals list is not registered");
  return (await fn(event, arg)) as WorkApprovalListResult;
}

function changedCount(): number {
  return send.mock.calls.filter(([channel]) => channel === WORK_APPROVALS.changed).length;
}

function keys(items: WorkApprovalView[]): string[] {
  return items.map((item) => item.kind).sort();
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ave-wa-"));
  workBoardStore = new WorkBoardStore(join(dir, "work-board", "board.json"));
  routinesStore = new RoutinesStore(join(dir, "routine", "routines.json"));
  await routinesStore.load();
  memoryManager = new MemoryManager({ aveDir: join(dir, "ave") });
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("work approvals list", () => {
  it("shows the project's candidates plus unscoped and global items, and totals every authorized project", async () => {
    await register();
    await workBoardStore.upsertProposal(INDEXER, PROPOSAL);
    const global = await memoryManager.saveMemory("Reply language", "Answer in Korean.", { source: "assistant", state: "candidate" });
    const inA = await memoryManager.saveMemory("Package manager", "Use bun.", { projectRoot: PROJECT_A, source: "assistant", state: "candidate" });
    await memoryManager.saveMemory("Other tool", "Use pnpm.", { projectRoot: PROJECT_B, source: "assistant", state: "candidate" });
    await memoryManager.saveMemory("Removed project", "Gone.", { projectRoot: PROJECT_GONE, source: "assistant", state: "candidate" });
    await memoryManager.saveMemory("Active fact", "Not a candidate.", { projectRoot: PROJECT_A, state: "active" });

    const result = await list({ projectRoot: PROJECT_A });
    if (!result.ok) throw new Error(`list failed: ${JSON.stringify(result)}`);
    expect(keys(result.items)).toEqual(["memory-candidate", "memory-candidate", "proposal"]);
    const candidates = result.items.filter((item) => item.kind === "memory-candidate");
    expect(candidates.map((item) => item.memoryId).sort()).toEqual([global.id, inA.id].sort());
    expect(candidates.find((item) => item.memoryId === inA.id)?.scope).toEqual({ type: "project", projectRoot: PROJECT_A, isDefault: false });
    expect(candidates.find((item) => item.memoryId === global.id)?.scope).toEqual({ type: "global" });
    // proposal + global + A + B; the unauthorized project's candidate cannot be acted on, so it is not counted.
    expect(result.total).toBe(4);
  });

  it("projects a proposal field by field, without its task brief", async () => {
    await register();
    const posted = await workBoardStore.upsertProposal(INDEXER, PROPOSAL);
    if (posted.status !== "ok") throw new Error("setup failed");
    const result = await list();
    if (!result.ok) throw new Error("list failed");
    expect(result.items).toEqual([{
      kind: "proposal",
      key: `proposal:${posted.proposal.id}`,
      scope: { type: "unscoped" },
      title: PROPOSAL.title,
      arrivedAt: posted.proposal.updatedAt,
      proposalId: posted.proposal.id,
      summary: PROPOSAL.summary,
      pluginLabel: "Indexer",
      priority: "medium",
      expiresAt: posted.proposal.expiresAt,
    }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-TASK-BRIEF");
  });

  it("drops dismissed and accepted proposals", async () => {
    await register();
    const posted = await workBoardStore.upsertProposal(INDEXER, PROPOSAL);
    if (posted.status !== "ok") throw new Error("setup failed");
    await workBoardStore.dismissProposal(posted.proposal.id);
    const result = await list();
    expect(result.ok && result.items).toEqual([]);
    expect(result.ok && result.total).toBe(0);
  });

  it("gives one routine one view with every reason, and keeps prePrompt out", async () => {
    await register();
    const attention = await routinesStore.add({
      trigger: "schedule",
      execution: "llm-session",
      schedule: { at: new Date(Date.now() + 60_000).toISOString(), repeat: { kind: "daily" } },
      prePrompt: "PRIVATE-PRE-PROMPT",
      title: "Morning",
      scope: { pluginIds: { mode: "allow", ids: ["calendar", "mail"] }, forcedPluginIds: [], directories: [] },
    });
    const fired = await routinesStore.markFired(attention.id, ["mail"]);
    const seen = await routinesStore.add({
      trigger: "schedule",
      execution: "notification-only",
      schedule: { at: new Date(Date.now() + 60_000).toISOString(), repeat: { kind: "daily" } },
      notificationTitle: "Seen",
    });
    const seenFired = await routinesStore.markFired(seen.id);
    await routinesStore.update(seen.id, { lastResultAcknowledgedAt: seenFired!.lastFiredAt });
    await routinesStore.add({
      trigger: "schedule",
      execution: "notification-only",
      schedule: { at: new Date(Date.now() + 60_000).toISOString() },
      notificationTitle: "Never fired",
    });

    const result = await list();
    if (!result.ok) throw new Error("list failed");
    expect(result.items).toEqual([{
      kind: "routine-attention",
      key: `routine:${attention.id}`,
      scope: { type: "global" },
      title: "Morning",
      arrivedAt: fired!.lastFiredAt,
      routineId: attention.id,
      reasons: ["plugins-missing", "result-unseen"],
      missingPluginIds: ["mail"],
      firedAt: fired!.lastFiredAt,
    }]);
    expect(result.total).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-PRE-PROMPT");
  });

  it("lists a held-back invalid routine", async () => {
    mkdirSync(join(dir, "routine"), { recursive: true });
    writeFileSync(join(dir, "routine", "routines.json"), JSON.stringify({
      version: 2,
      routines: [{
        id: "legacy",
        trigger: "schedule",
        execution: "llm-session",
        createdAt: "2026-01-01T00:00:00.000Z",
        scope: { pluginIds: { mode: "allow", ids: ["a_b"] }, forcedPluginIds: [], directories: [] },
      }],
    }));
    await routinesStore.load();
    await register();
    const result = await list();
    if (!result.ok) throw new Error("list failed");
    expect(result.items).toEqual([{
      kind: "routine-attention",
      key: "routine:legacy",
      scope: { type: "global" },
      title: "legacy",
      arrivedAt: null,
      routineId: "legacy",
      reasons: ["invalid-plugin-id"],
    }]);
  });

  it("marks the default project's candidates as default", async () => {
    await register();
    await memoryManager.saveMemory("Default note", "x", { projectRoot: DEFAULT_ROOT, source: "assistant", state: "candidate" });
    const result = await list({ projectRoot: DEFAULT_ROOT });
    if (!result.ok) throw new Error("list failed");
    expect(result.items.map((item) => item.scope)).toEqual([{ type: "project", projectRoot: DEFAULT_ROOT, isDefault: true }]);
  });

  it("fails clearly when a source store is not wired, instead of dropping it", async () => {
    await register({ workBoardStore: undefined });
    expect(await list()).toEqual({ ok: false, error: "source-unavailable", source: "proposal" });
    await register({ routinesStore: undefined });
    expect(await list()).toEqual({ ok: false, error: "source-unavailable", source: "routine-attention" });
  });

  it("refuses an unauthorized project and a payload with extra keys", async () => {
    await register();
    expect(await list({ projectRoot: PROJECT_GONE })).toEqual({ ok: false, error: "project-not-allowed" });
    expect(await list({ projectRoot: PROJECT_A, includeUnscoped: true })).toEqual({ ok: false, error: "invalid-input" });
    expect(await list("not-an-object")).toEqual({ ok: false, error: "invalid-input" });
  });

  it("refuses a non-host sender", async () => {
    await register();
    expect(await list(undefined, untrustedEvent())).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("work approvals changed signal", () => {
  it("fires for a plugin proposal posted through HostApi, not only through IPC", async () => {
    await register();
    await workBoardStore.upsertProposal(INDEXER, PROPOSAL);
    expect(changedCount()).toBe(1);
    expect(send).toHaveBeenCalledWith(WORK_APPROVALS.changed, undefined);
  });

  it("fires when a memory candidate is captured, approved, or discarded, and not for an active memory", async () => {
    await register();
    await memoryManager.saveMemory("Active fact", "x", { state: "active" });
    expect(changedCount()).toBe(0);
    const first = await memoryManager.saveMemory("Draft one", "x", { source: "assistant", state: "candidate" });
    const second = await memoryManager.saveMemory("Draft two", "y", { source: "assistant", state: "candidate" });
    expect(changedCount()).toBe(2);
    await memoryManager.activateMemoryCandidate(first.id!);
    expect(changedCount()).toBe(3);
    await memoryManager.deleteMemoryCandidate(second.id!);
    expect(changedCount()).toBe(4);
  });

  it("fires when deleteMemory removes a candidate file", async () => {
    await register();
    const draft = await memoryManager.saveMemory("Draft", "x", { source: "assistant", state: "candidate" });
    const before = changedCount();
    await memoryManager.deleteMemory(draft.filename);
    expect(changedCount()).toBe(before + 1);
  });

  it("fires when the scheduler records a skipped routine", async () => {
    const routine = await routinesStore.add({
      trigger: "schedule",
      execution: "llm-session",
      schedule: { at: new Date(Date.now() + 60_000).toISOString() },
      prePrompt: "x",
      scope: { pluginIds: { mode: "allow", ids: ["mail"] }, forcedPluginIds: [], directories: [] },
    });
    await register();
    await routinesStore.markPluginsMissing(routine.id, ["mail"]);
    expect(changedCount()).toBe(1);
  });
});
