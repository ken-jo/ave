// The work-approvals projection over real stores in a temp dir: which decisions a project sees, the all-project badge total, clear failures for
// a missing source, and the change signal from every write path (IPC, briefing, scheduler).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WORK_APPROVALS } from "../../../shared/ipc-channels.js";
import { hostFrameEvent, untrustedEvent } from "../../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { WorkBoardStore, itemDigestOf, planHashOf } from "../../../main/work-board-store.js";
import { RoutinesStore } from "../../../main/routines-store.js";
import { TEST_OWNER } from "../../../main/__tests__/routines-fixture.js";
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
  // PROJECT_GONE is a project the user removed: its plans must never be listed or counted.
  listAuthorizedWorkspaceProjects: vi.fn(() => [
    { projectRoot: DEFAULT_ROOT, projectName: "default", isDefault: true },
    { projectRoot: PROJECT_A, projectName: "project-a" },
  ]),
}));

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

async function fileProposal(input: import("../../../shared/work-board-types.js").WorkProposalInput) {
  const result = await workBoardStore.fileBriefingProposals([input]);
  const listed = await workBoardStore.listProposals();
  if (listed.status !== "ok") throw new Error("proposal setup failed");
  const proposal = listed.proposals.find((entry) => entry.id === result.filed[0] || entry.id === result.refreshed[0]);
  if (!proposal) throw new Error("proposal setup failed");
  return proposal;
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
    await fileProposal(PROPOSAL);
    const result = await list({ projectRoot: PROJECT_A });
    if (!result.ok) throw new Error(`list failed: ${JSON.stringify(result)}`);
    expect(keys(result.items)).toEqual(["proposal"]);
    expect(result.total).toBe(1);
  });

  it("masks secrets in titles and summaries before they reach the renderer", async () => {
    await register();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await fileProposal({
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
    const posted = await fileProposal(PROPOSAL);
    const result = await list();
    if (!result.ok) throw new Error("list failed");
    expect(result.items).toEqual([{
      kind: "proposal",
      key: `proposal:${posted.id}`,
      scope: { type: "unscoped" },
      title: PROPOSAL.title,
      arrivedAt: posted.updatedAt,
      proposalId: posted.id,
      summary: PROPOSAL.summary,
      pluginLabel: "Briefing",
      priority: "medium",
      expiresAt: posted.expiresAt,
      state: PROPOSAL.state,
      evidence: [],
      blockers: [],
    }]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE-TASK-BRIEF");
  });

  it("drops dismissed and accepted proposals", async () => {
    await register();
    const posted = await fileProposal(PROPOSAL);
    await workBoardStore.dismissProposal(posted.id);
    const result = await list();
    expect(result.ok && result.items).toEqual([]);
    expect(result.ok && result.total).toBe(0);
  });

  it("lists a routine only for missing plugins, never for an unseen or notify-only result, and keeps prePrompt out", async () => {
    await register();
    const attention = await routinesStore.add({ ...TEST_OWNER,
      trigger: "schedule",
      execution: "llm-session",
      schedule: { at: new Date(Date.now() + 60_000).toISOString(), repeat: { kind: "daily" } },
      prePrompt: "PRIVATE-PRE-PROMPT",
      title: "Morning",
      scope: { pluginIds: { mode: "allow", ids: ["calendar", "mail"] }, forcedPluginIds: [], directories: [] },
    });
    const fired = await routinesStore.markFired(attention.id, ["mail"]);
    // Fired and never acknowledged: an unseen successful result, which is not a decision.
    const unseen = await routinesStore.add({ ...TEST_OWNER,
      trigger: "schedule",
      execution: "llm-session",
      schedule: { at: new Date(Date.now() + 60_000).toISOString(), repeat: { kind: "daily" } },
      prePrompt: "x",
      title: "Unseen result",
    });
    await routinesStore.markFired(unseen.id);
    const notify = await routinesStore.add({ ...TEST_OWNER,
      trigger: "schedule",
      execution: "notification-only",
      schedule: { at: new Date(Date.now() + 60_000).toISOString(), repeat: { kind: "daily" } },
      notificationTitle: "Notify only",
    });
    await routinesStore.markFired(notify.id);
    await routinesStore.add({ ...TEST_OWNER,
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
    const daily = await routinesStore.add({ ...TEST_OWNER,
      trigger: "schedule",
      execution: "llm-session",
      schedule: { at: new Date(Date.now() + 60_000).toISOString(), repeat: { kind: "daily" } },
      prePrompt: "x",
      title: "Daily",
    });
    const dailyFired = (await routinesStore.markFired(daily.id))!.lastFiredAt!;
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await routinesStore.recordRunOutcome(daily.id, dailyFired, { ok: false, kind: "error", reason: `provider down ${secret}` });
    const quit = await routinesStore.add({ ...TEST_OWNER, trigger: "shutdown", execution: "llm-session", prePrompt: "wrap up", title: "Quit" });
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
    // All projects is its own request; it does not combine with one project, and only `true` turns it on.
    expect(await list({ allProjects: true, projectRoot: PROJECT_A })).toEqual({ ok: false, error: "invalid-input" });
    expect(await list({ allProjects: false })).toEqual({ ok: false, error: "invalid-input" });
  });

  it("refuses a non-host sender", async () => {
    await register();
    expect(await list(undefined, untrustedEvent())).toEqual({ ok: false, error: "unauthorized-frame" });
  });
});

describe("work approvals changed signal", () => {
  it("fires for a briefing proposal filed outside IPC", async () => {
    wire();
    await fileProposal(PROPOSAL);
    expect(changedCount()).toBe(1);
    expect(send).toHaveBeenCalledWith(WORK_APPROVALS.changed, undefined);
  });

  it("fires when the scheduler records a skipped routine", async () => {
    const routine = await routinesStore.add({ ...TEST_OWNER,
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

// A work item run to a stored plan that waits for the user's decision, as the engine leaves it.
async function pendingPlan(title: string, projectRoot: string | undefined, plan = `PLAN for ${title}`) {
  const created = await workBoardStore.create({ title, detail: "details", ...(projectRoot ? { projectRoot } : {}) });
  if (created.status !== "created") throw new Error("setup failed");
  const runId = `run-${created.itemId}`;
  await workBoardStore.beginRun(created.itemId, runId, new Date().toISOString());
  const stored = await workBoardStore.setPlanAwaitingApproval(created.itemId, {
    runId, plan, runSessionId: "plan-session", revision: 0, itemDigest: itemDigestOf(created.item),
  });
  if (stored?.status !== "updated") throw new Error("setup failed");
  return { id: created.itemId, runId, item: stored.item };
}

function planKeys(items: WorkApprovalView[]): string[] {
  return items.filter((item) => item.kind === "plan").map((item) => item.title).sort();
}

describe("work approvals — plan approvals", () => {
  it("lists a project's pending plan in that project only, with the shared kinds, and counts every project in the total", async () => {
    await register();
    await pendingPlan("plan in A", PROJECT_A);
    await pendingPlan("plan in default", DEFAULT_ROOT);
    await pendingPlan("plan with no project", undefined);
    await fileProposal(PROPOSAL);

    const inA = await list({ projectRoot: PROJECT_A });
    if (!inA.ok) throw new Error(`list failed: ${JSON.stringify(inA)}`);
    expect(planKeys(inA.items)).toEqual(["plan in A", "plan with no project"]);
    expect(inA.items.filter((item) => item.kind === "proposal")).toHaveLength(1);
    // Three plans and one proposal across every authorized project.
    expect(inA.total).toBe(4);

    const inDefault = await list({ projectRoot: DEFAULT_ROOT });
    if (!inDefault.ok) throw new Error("list failed");
    expect(planKeys(inDefault.items)).toEqual(["plan in default", "plan with no project"]);
    expect(inDefault.total).toBe(4);
  });

  it("projects a plan field by field: scope, the stored hash, the masked plan text, and no item detail", async () => {
    await register();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const plan = `1. Rotate ${secret}`;
    const { id, runId, item } = await pendingPlan(`Fix ${secret}`, DEFAULT_ROOT, plan);
    const result = await list({ projectRoot: DEFAULT_ROOT });
    if (!result.ok) throw new Error("list failed");
    const view = result.items.find((entry) => entry.kind === "plan");
    expect(view).toEqual({
      kind: "plan",
      key: `plan:${id}`,
      scope: { type: "project", projectRoot: DEFAULT_ROOT, isDefault: true },
      title: expect.not.stringContaining(secret),
      arrivedAt: item.planApproval!.requestedAt,
      itemId: id,
      runId,
      // The decision binds to the stored plan, never to the masked text shown.
      planHash: planHashOf(plan),
      plan: expect.not.stringContaining(secret),
      revision: 0,
      planNumber: 1,
      phase: "pending",
      stale: false,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("details");
  });

  it("never lists or counts a plan in a project the user removed, in any mode", async () => {
    await register();
    await pendingPlan("plan in removed project", PROJECT_GONE);
    await pendingPlan("plan in A", PROJECT_A);
    for (const request of [{ projectRoot: PROJECT_A }, { projectRoot: DEFAULT_ROOT }, { allProjects: true }]) {
      const result = await list(request);
      if (!result.ok) throw new Error("list failed");
      expect(JSON.stringify(result)).not.toContain("removed project");
      expect(result.total).toBe(1);
    }
  });

  it("lists every authorized project's plans in all-projects mode, with the project list to group them by", async () => {
    await register();
    await pendingPlan("plan in A", PROJECT_A);
    await pendingPlan("plan in default", DEFAULT_ROOT);
    await fileProposal(PROPOSAL);
    const result = await list({ allProjects: true });
    if (!result.ok) throw new Error("list failed");
    expect(planKeys(result.items)).toEqual(["plan in A", "plan in default"]);
    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.projects).toEqual([
      { projectRoot: DEFAULT_ROOT, projectName: "default", isDefault: true },
      { projectRoot: PROJECT_A, projectName: "project-a", isDefault: false },
    ]);
  });

  it("marks a plan stale once its item changed, and keeps a re-planning item listed but not counted", async () => {
    await register();
    const edited = await pendingPlan("edit me", PROJECT_A);
    await workBoardStore.update(edited.id, { title: "edited title" });
    const replanned = await pendingPlan("send back", PROJECT_A);
    const decided = await workBoardStore.decidePlan(replanned.id, {
      runId: replanned.runId, planHash: replanned.item.planApproval!.planHash, status: "changes_requested", note: "cover the edge cases",
    });
    expect(decided.status).toBe("decided");

    const result = await list({ projectRoot: PROJECT_A });
    if (!result.ok) throw new Error("list failed");
    const byId = new Map(result.items.flatMap((entry) => (entry.kind === "plan" ? [[entry.itemId, entry] as const] : [])));
    expect(byId.get(edited.id)).toMatchObject({ phase: "pending", stale: true, title: "edited title" });
    // The plan being made after the first change request is the second plan; the stored revision is still 0 until it lands.
    expect(byId.get(replanned.id)).toMatchObject({ phase: "replanning", changeRequest: "cover the edge cases", revision: 0, planNumber: 2 });
    // Only the plan waiting for a decision counts.
    expect(result.total).toBe(1);
  });

  it("drops a plan once it is approved or rejected", async () => {
    await register();
    const approved = await pendingPlan("approve me", PROJECT_A);
    const rejected = await pendingPlan("reject me", PROJECT_A);
    await workBoardStore.decidePlan(approved.id, { runId: approved.runId, planHash: approved.item.planApproval!.planHash, status: "approved" });
    await workBoardStore.decidePlan(rejected.id, { runId: rejected.runId, planHash: rejected.item.planApproval!.planHash, status: "rejected" });
    const result = await list({ projectRoot: PROJECT_A });
    if (!result.ok) throw new Error("list failed");
    expect(planKeys(result.items)).toEqual([]);
    expect(result.total).toBe(0);
  });
});

describe("work approvals changed signal — work items", () => {
  it("fires when a plan is stored, decided, and when its item is edited or deleted", async () => {
    wire();
    const { id, runId, item } = await pendingPlan("signal", PROJECT_A);
    const afterPlan = changedCount();
    // create, beginRun and the stored plan each wrote the board.
    expect(afterPlan).toBe(3);
    await workBoardStore.update(id, { title: "renamed" });
    expect(changedCount()).toBe(afterPlan + 1);
    await workBoardStore.decidePlan(id, { runId, planHash: item.planApproval!.planHash, status: "rejected" });
    expect(changedCount()).toBe(afterPlan + 2);
    await workBoardStore.remove(id);
    expect(changedCount()).toBe(afterPlan + 3);
  });

  it("does not fire for a refused write", async () => {
    const { id } = await pendingPlan("refused", PROJECT_A);
    wire();
    const refused = await workBoardStore.decidePlan(id, { runId: "run-other", planHash: "0".repeat(64), status: "approved" });
    expect(refused.status).toBe("refused");
    expect(changedCount()).toBe(0);
  });
});
