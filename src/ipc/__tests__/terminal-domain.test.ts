import { terminalSessionFixture } from "../../__tests__/support/terminal-session-fixtures.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { TerminalEmit } from "../../main/terminal/pty-manager.js";
import { approvalSurfaceRegistry, updateApprovalSurface } from "../../permissions/approval-surface-registry.js";

const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
const fromWebContents = vi.fn();

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

const fanOut = vi.fn((_windows: unknown[], _channel: string, _payload: unknown) => 0);
vi.mock("../window-fanout.js", () => ({ fanOutToAllWindows: fanOut }));

let emitter: TerminalEmit = () => {};
const owners = new Map<string, number | null>();
const internalIds = new Set<string>();
const writeTerminal = vi.fn(() => ({ ok: true }));
const killTerminal = vi.fn();
vi.mock("../../main/terminal/pty-manager.js", () => ({
  setTerminalEmitter: (fn: TerminalEmit) => { emitter = fn; },
  spawnTerminal: vi.fn(async ({ tabId, lane }: { tabId: string; lane: "manual" | "agent" }) => ({ ok: true, tabId, replayed: false, session: terminalSessionFixture(tabId, lane) })),
  writeTerminal,
  resizeTerminal: vi.fn(() => ({ ok: true })),
  killTerminal,
  terminalOwnedBy: (tabId: string, ownerWindowId: number | null) => !internalIds.has(tabId) && (!owners.has(tabId) || owners.get(tabId) === ownerWindowId),
}));

const { registerTerminalHandlers } = await import("../domains/terminal.js");
const { CHANNELS } = await import("../../contract/app-contract.js");

function appWindow(id: number) {
  const mainFrame = { url: "file:///Applications/Ave.app/dist/index.html" };
  return { id, isDestroyed: () => false,
    webContents: { windowId: id, isDestroyed: () => false, mainFrame },
  };
}
const windowOne = appWindow(1);
const windowTwo = appWindow(2);

function from(win: ReturnType<typeof appWindow>): IpcMainInvokeEvent {
  return { senderFrame: win.webContents.mainFrame, sender: win.webContents } as unknown as IpcMainInvokeEvent;
}

beforeEach(() => {
  handlers.clear();
  owners.clear();
  internalIds.clear();
  fanOut.mockClear();
  writeTerminal.mockClear();
  killTerminal.mockClear();
  fromWebContents.mockImplementation((sender: { windowId: number }) => (sender.windowId === 1 ? windowOne : windowTwo));
  registerTerminalHandlers({
    auditLogger: { log: vi.fn() },
    getMainWindow: () => windowOne,
    getAppWindows: () => [windowOne, windowTwo],
  } as never);
});

describe("terminal IPC between two windows", () => {
  it("registers the exact native terminal owner before spawn and refuses ownership theft", async () => {
    const tabId = "terminal:0000000a-1";
    const spawn = handlers.get(CHANNELS.terminal.spawn)!;
    expect(await spawn(from(windowOne), { tabId, lane: "manual" })).toMatchObject({ ok: true });
    expect(approvalSurfaceRegistry.resolve(undefined, tabId)).toBe(windowOne.webContents);
    owners.set(tabId, 1);
    expect(await spawn(from(windowTwo), { tabId, lane: "manual" })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(approvalSurfaceRegistry.resolve(undefined, tabId)).toBe(windowOne.webContents);
    updateApprovalSurface({ kind: "release-terminal", tabId });
  });

  it("never registers a terminal approval owner from a trusted-URL subframe", async () => {
    const tabId = "terminal:0000000a-2";
    const event = { ...from(windowOne), senderFrame: { url: "file:///Applications/Ave.app/dist/index.html" } };
    expect(await handlers.get(CHANNELS.terminal.spawn)!(event as IpcMainInvokeEvent, { tabId, lane: "manual" }))
      .toMatchObject({ ok: false, reason: "unauthorized-frame" });
    expect(approvalSurfaceRegistry.resolve(undefined, tabId)).toBeNull();
  });
  it("sends a terminal's output and exit to its owning window only", () => {
    emitter("data", { ...terminalSessionFixture("terminal:0000000a-1", "manual"), chunk: "hi" }, 2);
    emitter("exit", { ...terminalSessionFixture("terminal:0000000a-1", "manual"), exitCode: 0 }, 2);
    expect(fanOut.mock.calls.map(([windows, channel]) => [(windows as Array<{ id: number }>).map((win) => win.id), channel])).toEqual([
      [[2], CHANNELS.terminal.data],
      [[2], CHANNELS.terminal.exit],
    ]);
  });

  it("refuses another window's input, resize and close, and passes the owner's", async () => {
    owners.set("terminal:0000000a-1", 1);
    const input = handlers.get(CHANNELS.terminal.input)!;
    const kill = handlers.get(CHANNELS.terminal.kill)!;
    const resize = handlers.get(CHANNELS.terminal.resize)!;
    expect(await input(from(windowTwo), { ...terminalSessionFixture("terminal:0000000a-1", "manual"), data: "rm -rf ~\r" })).toEqual({ ok: false, error: "not-owner" });
    expect(await resize(from(windowTwo), { ...terminalSessionFixture("terminal:0000000a-1", "manual"), cols: 10, rows: 10 })).toEqual({ ok: false, error: "not-owner" });
    expect(await kill(from(windowTwo), { tabId: "terminal:0000000a-1" })).toEqual({ ok: false, error: "not-owner" });
    expect(writeTerminal).not.toHaveBeenCalled();
    expect(killTerminal).not.toHaveBeenCalled();
    expect(await input(from(windowOne), { ...terminalSessionFixture("terminal:0000000a-1", "manual"), data: "ls\r" })).toEqual({ ok: true });
    expect(writeTerminal).toHaveBeenCalledWith(expect.objectContaining({ tabId: "terminal:0000000a-1", lane: "manual", terminalSessionId: "terminal:0000000a-1/manual" }), "ls\r");
  });
});


describe("terminal IPC lane validation", () => {
  it("requires explicit lane on spawn and incarnation on mutations and block reads", async () => {
    expect(await handlers.get(CHANNELS.terminal.spawn)!(from(windowOne), { tabId: "terminal:0000000a-1" })).toMatchObject({ ok: false, reason: "bad-request" });
    for (const channel of [CHANNELS.terminal.input, CHANNELS.terminal.resize, CHANNELS.terminal.blocks, CHANNELS.terminal.block]) {
      expect(await handlers.get(channel)!(from(windowOne), { tabId: "terminal:0000000a-1" })).toEqual({ ok: false, error: "invalid-params" });
    }
  });
});


describe("conversation terminal privacy boundary", () => {
  it("refuses renderer agent requests and never forwards their data or exit", async () => {
    const ref = terminalSessionFixture("terminal:0000000a-9", "agent");
    expect(await handlers.get(CHANNELS.terminal.spawn)!(from(windowOne), { tabId: ref.tabId, lane: "agent" })).toMatchObject({ ok: false, reason: "bad-request" });
    for (const channel of [CHANNELS.terminal.input, CHANNELS.terminal.resize, CHANNELS.terminal.blocks, CHANNELS.terminal.block]) {
      expect(await handlers.get(channel)!(from(windowOne), { ...ref, data: "bad", cols: 80, rows: 24, blockId: 1 })).toEqual({ ok: false, error: "invalid-params" });
    }
    expect(await handlers.get(CHANNELS.terminal.kill)!(from(windowOne), ref)).toEqual({ ok: false, error: "invalid-params" });
    internalIds.add(ref.tabId);
    expect(await handlers.get(CHANNELS.terminal.kill)!(from(windowOne), { tabId: ref.tabId })).toEqual({ ok: false, error: "not-owner" });
    emitter("data", { ...ref, chunk: "private" }, 1);
    emitter("exit", { ...ref, exitCode: 0 }, 1);
    expect(fanOut).not.toHaveBeenCalled();
    expect(writeTerminal).not.toHaveBeenCalled();
    expect(killTerminal).not.toHaveBeenCalled();
  });
});
