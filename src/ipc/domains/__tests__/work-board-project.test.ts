import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORK_BOARD } from "../../../shared/ipc-channels.js";
import { registerWorkBoardHandlers } from "../work-board.js";
import type { IpcDeps } from "../../types.js";
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
      workBoardEngine: { runItem, runBriefing }, auditLogger: { log: vi.fn() },
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
      workBoardEngine: { runItem, runBriefing }, auditLogger: { log: vi.fn() },
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
