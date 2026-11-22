// Removing a project through the real removal handler reaches the stage scheduler: live stage children of template runs on that project
// are interrupted and their stages fail `workspace-revoked`; a run on another project stays live.
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const {
  handlers,
  additionalDirectories,
  pendingWorkspaceRootRemovals,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  additionalDirectories: { value: [] as string[] },
  pendingWorkspaceRootRemovals: { value: [] as unknown[] },
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  dialog: { showOpenDialog: vi.fn() },
  shell: { showItemInFolder: vi.fn() },
}));

vi.mock("../../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({
    permissions: {
      additionalDirectories: additionalDirectories.value,
      pendingWorkspaceRootRemovals: pendingWorkspaceRootRemovals.value,
    },
  }),
  addAllowedDirectoryPersist: vi.fn(async () => additionalDirectories.value),
  removeAllowedDirectoryPersist: vi.fn(async (dir: string) => {
    additionalDirectories.value = additionalDirectories.value.filter((d) => d !== dir);
    return additionalDirectories.value;
  }),
  beginWorkspaceRootRemovalPersist: vi.fn(async (target: string) => ({
    intent: {
      operationId: "op-1",
      storedPath: target,
      runtimePath: target,
      requestedAt: new Date().toISOString(),
      source: "test",
    },
    activeDirectories: additionalDirectories.value,
    created: true,
  })),
  completeWorkspaceRootRemovalPersist: vi.fn(async () => {
    additionalDirectories.value = [];
    return additionalDirectories.value;
  }),
}));

import { registerWorkspaceHandlers } from "../workspace.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { stageOf } from "../../../work-board/workflow/__tests__/stage-fixtures.js";
import { stageRunHarness } from "../../../work-board/workflow/__tests__/stage-run-harness.js";

type Harness = Awaited<ReturnType<typeof stageRunHarness>>;
let h: Harness;
let root: string;
let other: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "ave-template-run-revoke-"));
  other = mkdtempSync(join(tmpdir(), "ave-template-run-keep-"));
  h = await stageRunHarness();
  registerWorkspaceHandlers({
    auditLogger: { log: vi.fn() },
    pluginRuntime: { retireSandboxGrantsOutsideCeiling: vi.fn(async () => [] as string[]) },
    getMainWindow: () => null,
    memoryManager: { sessions: { allowProjectRoot: vi.fn(), detachSessionsFromProject: vi.fn(async () => 0) } },
    conversationLoop: {
      deps: {},
      permissionManager: { prunePathGrantsUnderRoot: async () => [] },
      revokeWorkspaceRoot: () => ({ sessionDirectoriesRemoved: 0, turnDirectoriesRemoved: 0, projectRebound: false }),
    },
    routinesStore: { revokeWorkspaceRoot: async () => ({ routinesUpdated: 0, directoriesRemoved: 0 }) },
    // The engine of the harness, as boot hands the real one to these handlers.
    workBoardEngine: h.engine,
  } as never);
});

afterAll(async () => {
  for (const child of h.children) child.finish();
  await h.cleanup();
  await cleanupTmpDir(root);
  await cleanupTmpDir(other);
});

it("removing a project root interrupts the live stage children of its template runs and leaves another project's run live", async () => {
  additionalDirectories.value = [root, other];
  const version = await h.confirm([stageOf("a"), stageOf("b")]);
  const onRoot = await h.addItem(version, root);
  const onOther = await h.addItem(version, other);
  void h.start(onRoot, h.local(version, root));
  const ofRoot = [...await h.untilLive(2)];
  void h.start(onOther, h.local(version, other));
  await h.untilLive(4);

  const fn = handlers.get(CHANNELS.workspace.removeRoot);
  if (!fn) throw new Error("no removal handler");
  const removed = await fn({ sender: { id: 1 }, senderFrame: { url: "file:///app/index.html" } } as never, root) as { ok: boolean };
  expect(removed.ok).toBe(true);

  const item = await h.until(onRoot, current => current.stageRuns.every(run => run.status === "failed"));
  expect(item.stageRuns).toMatchObject([{ stageId: "a", failure: "workspace-revoked" }, { stageId: "b", failure: "workspace-revoked" }]);
  expect([...h.interrupts].sort()).toEqual(ofRoot.map(child => child.sessionId).sort());
  expect(h.live()).toHaveLength(2);
  expect((await h.item(onOther)).stageRuns.map(run => run.status)).toEqual(["running", "running"]);
});
