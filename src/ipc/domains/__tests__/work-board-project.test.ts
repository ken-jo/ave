import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configureHostResources } from "../../../main/host-resources.js";
import { WORK_BOARD } from "../../../shared/ipc-channels.js";
import { registerWorkBoardHandlers } from "../work-board.js";
import type { IpcDeps } from "../../types.js";
import { WorkBoardStore } from "../../../main/work-board-store.js";
import type { WorkItemResolved } from "../../../main/work-board-store.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME } from "../../gated.js";

const ipc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  };
});

vi.mock("electron", () => {
  const electron = {
    ipcMain: {
      handle: ipc.handle,
    },
  };
  return { ...electron, default: electron };
});

vi.mock("../../gated.js", () => ({
  validateHostRendererSender: () => true,
  UNAUTHORIZED_FRAME: { ok: false, error: "unauthorized-frame" },
  auditUnauthorized: vi.fn(),
}));

let oldHome: string | undefined;
let oldCwd: string;
let root: string;
let workspace: string;

function registeredHandler<T extends (...args: unknown[]) => unknown>(channel: string): T {
  const handler = ipc.handlers.get(channel);
  if (!handler) throw new Error(`missing handler for ${channel}`);
  return handler as T;
}

function deniedItem(projectRoot: string): WorkItemResolved {
  return {
    id: 7,
    title: "secret",
    status: "planned",
    status_resolved: "planned",
    priority: "medium",
    projectRoot,
    projectName: "secret",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  oldHome = process.env.AVE_HOME;
  oldCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "ave-work-board-project-"));
  workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  workspace = realpathSync(workspace);
  process.env.AVE_HOME = root;
  process.chdir(workspace);
  ipc.handlers.clear();
  ipc.handle.mockClear();
});

afterEach(async () => {
  process.chdir(oldCwd);
  if (oldHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = oldHome;
  await cleanupTmpDir(root);
});

describe("work-board project authorization", () => {
  it("passes the registered board main frame as the owner of runs and briefings", async () => {
    const owner = { isDestroyed: () => false, mainFrame: { url: "file:///index.html" } };
    const other = { isDestroyed: () => false, mainFrame: { url: "file:///index.html" } };
    const window = { isDestroyed: () => false, webContents: owner };
    const runItem = vi.fn(async () => ({ status: "completed" }));
    const runBriefing = vi.fn(async () => ({ status: "empty", kind: "daily", reason: "no findings" }));
    registerWorkBoardHandlers({
      workBoardStore: { get: async () => ({ status: "found", item: { ...deniedItem(workspace), projectRoot: workspace } }) },
      workBoardEngine: { runItem, runBriefing, projectTemplateRuns: async (items: unknown[]) => items, adoptParkedTemplateRuns: async () => {} }, auditLogger: { log: vi.fn() },
      getMainWindow: () => window, getAppWindows: () => [window],
    } as unknown as IpcDeps);
    const event = { sender: owner, senderFrame: owner.mainFrame };
    await registeredHandler(WORK_BOARD.run)(event, 7, { agentName: "writer", approvalSurface: other });
    await registeredHandler(WORK_BOARD.runBriefing)(event, "daily", workspace);
    expect(runItem).toHaveBeenCalledWith(7, { agentName: "writer", approvalSurface: owner });
    expect(runBriefing).toHaveBeenCalledWith("daily", { projectRoot: workspace, includeUnscoped: true, approvalSurface: owner });
  });

  it.each(["subframe", "unregistered", "destroyed"] as const)("rejects a %s initiating frame before it can register a board approval owner", async (kind) => {
    const owner = { isDestroyed: () => false, mainFrame: { url: "file:///index.html" } };
    const sender = kind === "unregistered"
      ? { isDestroyed: () => false, mainFrame: { url: "file:///index.html" } }
      : owner;
    const window = { isDestroyed: () => kind === "destroyed", webContents: owner };
    const runItem = vi.fn();
    const runBriefing = vi.fn();
    registerWorkBoardHandlers({
      workBoardStore: { get: async () => ({ status: "found", item: { ...deniedItem(workspace), projectRoot: workspace } }) },
      workBoardEngine: { runItem, runBriefing, projectTemplateRuns: async (items: unknown[]) => items, adoptParkedTemplateRuns: async () => {} }, auditLogger: { log: vi.fn() },
      getMainWindow: () => window, getAppWindows: () => [window],
    } as unknown as IpcDeps);
    const event = { sender, senderFrame: kind === "subframe" ? { url: "file:///index.html" } : sender.mainFrame };
    vi.mocked(auditUnauthorized).mockClear();
    await expect(registeredHandler(WORK_BOARD.run)(event, 7)).resolves.toEqual(UNAUTHORIZED_FRAME);
    await expect(registeredHandler(WORK_BOARD.runBriefing)(event, "daily", workspace)).resolves.toEqual(UNAUTHORIZED_FRAME);
    expect(runItem).not.toHaveBeenCalled();
    expect(runBriefing).not.toHaveBeenCalled();
    expect(auditUnauthorized).toHaveBeenCalledTimes(2);
  });

  it("defaults missing list and report filters to the app-managed workspace project", async () => {
    const list = vi.fn(async () => ({ status: "ok", items: [] }));
    const generate = vi.fn(async () => ({
      status: "empty",
      kind: "daily",
      period: "2026-07-04",
      reason: "no-items",
    }));
    registerWorkBoardHandlers({
      workBoardStore: { list },
      workBoardReport: { generate },
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      getAppWindows: () => [],
    } as unknown as IpcDeps);

    await registeredHandler(WORK_BOARD.list)({});
    await registeredHandler(WORK_BOARD.generateReport)({}, "daily", undefined);

    expect(list).toHaveBeenCalledWith({
      projectRoot: workspace,
      includeUnscoped: true,
    });
    expect(generate).toHaveBeenCalledWith("daily", {
      projectRoot: workspace,
      includeUnscoped: true,
    });
  });

  it("does not expose or mutate items from unauthorized stored project roots", async () => {
    const item = deniedItem(join(root, "denied-project"));
    const store = {
      get: vi.fn(async () => ({ status: "found", itemId: item.id, item })),
      update: vi.fn(async () => ({ status: "updated", itemId: item.id, item })),
      remove: vi.fn(async () => ({ status: "deleted", itemId: item.id })),
    };
    const engine = {
      runItem: vi.fn(async () => ({ status: "completed", output: "done" })),
      projectTemplateRuns: async (items: unknown[]) => items,
      adoptParkedTemplateRuns: async () => {},
    };
    registerWorkBoardHandlers({
      workBoardStore: store,
      workBoardEngine: engine,
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      getAppWindows: () => [],
    } as unknown as IpcDeps);

    await expect(registeredHandler(WORK_BOARD.get)({}, item.id)).resolves.toEqual({
      status: "not_found",
      itemId: item.id,
    });
    await expect(registeredHandler(WORK_BOARD.update)({}, item.id, { title: "changed" })).resolves.toEqual({
      status: "not_found",
      itemId: item.id,
    });
    await expect(registeredHandler(WORK_BOARD.remove)({}, item.id)).resolves.toEqual({
      status: "not_found",
      itemId: item.id,
    });
    await expect(registeredHandler(WORK_BOARD.run)({}, item.id)).resolves.toEqual({
      status: "not_found",
    });
    await expect(registeredHandler(WORK_BOARD.runTranscript)({}, item.id, "run-1")).resolves.toEqual({
      events: [],
    });
    expect(store.update).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
    expect(engine.runItem).not.toHaveBeenCalled();
  });

  it("rejects creating an item for an unauthorized explicit project root", async () => {
    const store = {
      create: vi.fn(async () => ({ status: "created", itemId: 1 })),
    };
    registerWorkBoardHandlers({
      workBoardStore: store,
      auditLogger: { log: vi.fn() },
      getMainWindow: () => null,
      getAppWindows: () => [],
    } as unknown as IpcDeps);

    await expect(registeredHandler(WORK_BOARD.add)({}, {
      title: "secret",
      projectRoot: join(root, "denied-project"),
      projectName: "secret",
    })).resolves.toEqual({
      status: "invalid",
      reason: "project root is not authorized",
    });
    expect(store.create).not.toHaveBeenCalled();
  });
});


describe("conditional board mutations", () => {
  it("passes the shown revision through the authorized handler to the real store", async () => {
    const store = new WorkBoardStore(join(root, "board.json"));
    const created = await store.create({ title: "Export notes", projectRoot: workspace });
    if (created.status !== "created") throw new Error("Create failed");
    registerWorkBoardHandlers({ workBoardStore: store, auditLogger: { log: vi.fn() }, getMainWindow: () => null, getAppWindows: () => [] } as unknown as IpcDeps);
    await store.beginRun(created.itemId, "new-run", new Date().toISOString());
    await expect(registeredHandler(WORK_BOARD.complete)({}, created.itemId, created.item.mutationRevision)).resolves.toMatchObject({ status: "invalid", reason: "work-item-changed" });
    await expect(registeredHandler(WORK_BOARD.transition)({}, created.itemId, "completed", created.item.mutationRevision)).resolves.toMatchObject({ status: "invalid", reason: "work-item-changed" });
  });
  it("refuses absent or malformed revisions at the renderer boundary", async () => {
    const store = new WorkBoardStore(join(root, "board.json"));
    const created = await store.create({ title: "Export notes", projectRoot: workspace });
    if (created.status !== "created") throw new Error("Create failed");
    registerWorkBoardHandlers({ workBoardStore: store, auditLogger: { log: vi.fn() }, getMainWindow: () => null, getAppWindows: () => [] } as unknown as IpcDeps);
    for (const revision of [undefined, "unknown", 3]) {
      await expect(registeredHandler(WORK_BOARD.complete)({}, created.itemId, revision)).resolves.toMatchObject({ status: "invalid", reason: "work-item-changed" });
    }
  });
});

describe("listed row delete", () => {
  it("deletes a listed row only by its id with the revision its card showed, and returns the run that row named", async () => {
    const store = new WorkBoardStore(join(root, "board.json"));
    const created = await store.create({ title: "Export notes", projectRoot: workspace });
    if (created.status !== "created") throw new Error("Create failed");
    registerWorkBoardHandlers({ workBoardStore: store, auditLogger: { log: vi.fn() }, getMainWindow: () => null, getAppWindows: () => [] } as unknown as IpcDeps);
    const remove = registeredHandler(WORK_BOARD.remove);
    for (const target of [undefined, {}, { revision: "unknown" }, { revision: created.item.mutationRevision, more: 1 }, "revision"]) {
      await expect(remove({}, created.itemId, target)).resolves.toEqual({ status: "invalid", itemId: created.itemId, reason: "work-item-changed" });
    }
    await store.beginRun(created.itemId, "run-1", new Date().toISOString());
    await expect(remove({}, created.itemId, { revision: created.item.mutationRevision })).resolves.toEqual({ status: "invalid", itemId: created.itemId, reason: "work-item-changed" });
    const current = await store.get(created.itemId);
    if (current.status !== "found") throw new Error("Missing item");
    await expect(remove({}, created.itemId, { revision: current.item.mutationRevision })).resolves.toEqual({ status: "deleted", itemId: created.itemId, runId: "run-1" });
    await expect(store.get(created.itemId)).resolves.toEqual({ status: "not_found", itemId: created.itemId });
  });
});

describe("invalid row delete", () => {
  it("deletes an entry that does not validate only as its invalid card names it, by its place and content, and only while the project it names is authorized", async () => {
    const path = join(root, "board.json");
    const valid = { id: 1, title: "kept", status: "planned", priority: "medium", created_at: "x", updated_at: "x" };
    const here = { id: 2, title: 5, projectRoot: workspace };
    const denied = { id: 3, title: 5, projectRoot: join(root, "denied-project") };
    const unscoped = { id: 4, title: 5 };
    const unnamed = { id: 5, title: 5, projectRoot: 7 };
    const idless = [null, 7, "text", []];
    writeFileSync(path, JSON.stringify({ version: 1, nextId: 6, items: [valid, here, denied, unscoped, unnamed, ...idless] }));
    const store = new WorkBoardStore(path);
    const broadcast = vi.fn();
    const window = { isDestroyed: () => false, webContents: { send: broadcast } };
    registerWorkBoardHandlers({ workBoardStore: store, auditLogger: { log: vi.fn() }, getMainWindow: () => window, getAppWindows: () => [window] } as unknown as IpcDeps);
    const remove = registeredHandler(WORK_BOARD.remove);
    const card = async (entry: unknown) => {
      const listed = await store.list();
      const hash = createHash("sha256").update(JSON.stringify(entry)).digest("hex");
      const found = listed.status === "ok" ? listed.unreadableRows?.find((row) => row.hash === hash) : undefined;
      if (!found) throw new Error("no card");
      return { invalidRow: { position: found.position, hash: found.hash } };
    };
    await expect(remove({}, 2)).resolves.toEqual({ status: "not_found", itemId: 2 });
    const named = await card(here);
    for (const [id, target] of [
      [2, named], [null, undefined], [null, { invalidRow: true }], [null, { ...named, more: 1 }], [null, { invalidRow: { ...named.invalidRow, more: 1 } }],
      [null, { invalidRow: { position: "0", hash: named.invalidRow.hash } }], [null, { invalidRow: { position: -1, hash: named.invalidRow.hash } }],
      [null, { invalidRow: { position: 0.5, hash: named.invalidRow.hash } }], [null, { invalidRow: { position: 0, hash: "A".repeat(64) } }], [null, "invalidRow"],
    ]) {
      await expect(remove({}, id, target)).resolves.toEqual({ ok: false, error: "invalid-input" });
    }
    await expect(remove({}, null, { invalidRow: { position: named.invalidRow.position, hash: "0".repeat(64) } })).resolves.toEqual({ status: "invalid", reason: "work-board-row-changed" });
    for (const entry of [denied, unnamed]) await expect(remove({}, null, await card(entry))).resolves.toEqual({ status: "not_found" });
    expect(broadcast).not.toHaveBeenCalled();
    await expect(remove({}, null, named)).resolves.toEqual({ status: "deleted", itemId: 2 });
    await expect(remove({}, null, await card(unscoped))).resolves.toEqual({ status: "deleted", itemId: 4 });
    for (const entry of idless) await expect(remove({}, null, await card(entry))).resolves.toEqual({ status: "deleted" });
    expect(JSON.parse(readFileSync(path, "utf8")).items).toEqual([valid, denied, unnamed]);
    expect(broadcast.mock.calls.map(([, payload]) => payload)).toEqual([
      { itemId: 2, change: "removed", changedAt: expect.any(String) }, { itemId: 4, change: "removed", changedAt: expect.any(String) },
      ...idless.map(() => ({ change: "removed", changedAt: expect.any(String) })),
    ]);
  });
});
