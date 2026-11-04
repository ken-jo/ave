// The work-approvals projection over real stores in a temp dir: which decisions a project sees, the all-project badge total, clear failures for
// a missing source, and the change signal from every write path (IPC, plugin HostApi, scheduler).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WORK_APPROVALS } from "../../../shared/ipc-channels.js";
import { hostFrameEvent, untrustedEvent } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { WorkBoardStore } from "../../../main/work-board-store.js";
import { RoutinesStore } from "../../../main/routines-store.js";
import type { WorkApprovalListResult, WorkApprovalView } from "../../../shared/work-approvals-types.js";
import { wireWorkApprovalsChanged } from "../../../boot/steps/work-approvals-wiring.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const PROJECT_A = "/work/project-a";
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
    auditLogger: { log: vi.fn() },
    getMainWindow: () => win,
    getAppWindows: () => [win],
    ...overrides,
  } as never);
}

// The boot step that turns every source store's write signal into the payload-free broadcast.
function wire() {
  const win = windowStub();
  wireWorkApprovalsChanged({
    workBoardStore,
    routinesStore,
    getMainWindow: () => win,
    host: { desktop: { getAppWindows: () => [win] } },
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
});

afterEach(async () => {
  await cleanupTmpDir(dir);
});

describe("work approvals list", () => {
  it("returns the unscoped and global items for a project, with a matching total", async () => {
    await register();
    await workBoardStore.upsertProposal(INDEXER, PROPOSAL);
    const result = await list({ projectRoot: PROJECT_A });
    if (!result.ok) throw new Error(`list failed: ${JSON.stringify(result)}`);
    expect(keys(result.items)).toEqual(["proposal"]);
    expect(result.total).toBe(1);
    // There is no all-projects mode until project-scoped plan approvals (WA-1) exist.
    expect(await list({ allProjects: true })).toEqual({ ok: false, error: "invalid-input" });
  });

  it("masks secrets in titles and summaries before they reach the renderer", async () => {
    await register();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await workBoardStore.upsertProposal(INDEXER, {
      ...PROPOSAL,
      title: `Rotate ${secret}`,
      summary: `Leaked ${secret}`,
      state: `State ${secret}`,
      evidence: [{ label: "Token", detail: secret }],
      blockers: [{ reason: `Blocked by ${secret}`, resolution: `Rotate ${secret}` }],
    });
    const result = await list(undefined);
    if (!result.ok) throw new Error("list failed");
    expect(result.items).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(secret);
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
      state: PROPOSAL.state,
      evidence: [],
      blockers: [],
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

  it("lists a routine only for missing plugins, never for an unseen or notify-only result, and keeps prePrompt out", async () => {
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
    // Fired and never acknowledged: an unseen successful result, which is not a decision.
    const unseen = await routinesStore.add({
      trigger: "schedule",
      execution: "llm-session",
      schedule: { at: new Date(Date.now() + 60_000).toISOString(), repeat: { kind: "daily" } },
      prePrompt: "x",
      title: "Unseen result",
    });
    await routinesStore.markFired(unseen.id);
    const notify = await routinesStore.add({
      trigger: "schedule",
      execution: "notification-only",
      schedule: { at: new Date(Date.now() + 60_000).toISOString(), repeat: { kind: "daily" } },
      notificationTitle: "Notify only",
    });
    await routinesStore.markFired(notify.id);
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
      reasons: ["plugins-missing"],
      missingPluginIds: ["mail"],
    }]);
    expect(result.total).toBe(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-PRE-PROMPT");
  });

  it("lists an unacknowledged failed run, including a shutdown routine's dismissed record, and drops it once acknowledged", async () => {
    await register();
    const daily = await routinesStore.add({
      trigger: "schedule",
      execution: "llm-session",
      schedule: { at: new Date(Date.now() + 60_000).toISOString(), repeat: { kind: "daily" } },
      prePrompt: "x",
      title: "Daily",
    });
    const dailyFired = (await routinesStore.markFired(daily.id))!.lastFiredAt!;
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await routinesStore.recordRunOutcome(daily.id, dailyFired, { ok: false, kind: "error", reason: `provider down ${secret}` });
    const quit = await routinesStore.add({ trigger: "shutdown", execution: "llm-session", prePrompt: "wrap up", title: "Quit" });
    const quitFired = (await routinesStore.markFired(quit.id))!.lastFiredAt!;
    await routinesStore.recordRunOutcome(quit.id, quitFired, { ok: false, kind: "shutdown-timeout" });
    expect(routinesStore.list().find((r) => r.id === quit.id)?.dismissedAt).toBeDefined();

    const result = await list();
    if (!result.ok) throw new Error("list failed");
    const byId = new Map(result.items.map((item) => [item.kind === "routine-attention" ? item.routineId : item.key, item]));
    expect(byId.get(daily.id)).toMatchObject({
      reasons: ["run-failed"],
      failure: { kind: "error", firedAt: dailyFired },
    });
    expect(byId.get(quit.id)).toMatchObject({
      reasons: ["run-failed"],
      failure: { kind: "shutdown-timeout", firedAt: quitFired },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.total).toBe(2);

    expect(await routinesStore.acknowledgeFailure(quit.id, quitFired)).toBe("acknowledged");
    await routinesStore.acknowledgeResult(daily.id, dailyFired);
    const after = await list();
    if (!after.ok) throw new Error("list failed");
    expect(after.items).toEqual([]);
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

  it("fails clearly when a source store is not wired, instead of dropping it", async () => {
    await register({ workBoardStore: undefined });
    expect(await list()).toEqual({ ok: false, error: "work-approvals-source-unavailable", source: "proposal" });
    await register({ routinesStore: undefined });
    expect(await list()).toEqual({ ok: false, error: "work-approvals-source-unavailable", source: "routine-attention" });
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
    wire();
    await workBoardStore.upsertProposal(INDEXER, PROPOSAL);
    expect(changedCount()).toBe(1);
    expect(send).toHaveBeenCalledWith(WORK_APPROVALS.changed, undefined);
  });

  it("fires when the scheduler records a skipped routine", async () => {
    const routine = await routinesStore.add({
      trigger: "schedule",
      execution: "llm-session",
      schedule: { at: new Date(Date.now() + 60_000).toISOString() },
      prePrompt: "x",
      scope: { pluginIds: { mode: "allow", ids: ["mail"] }, forcedPluginIds: [], directories: [] },
    });
    wire();
    await routinesStore.markPluginsMissing(routine.id, ["mail"]);
    expect(changedCount()).toBe(1);
  });
});
