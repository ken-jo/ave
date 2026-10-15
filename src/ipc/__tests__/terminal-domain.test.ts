/**
 * The terminal IPC domain, between two app windows: a terminal's output goes
 * to the window that owns it only, and the other window cannot type into,
 * resize, close or read the blocks of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { TerminalEmit } from "../../main/terminal/pty-manager.js";

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
const writeTerminal = vi.fn();
const killTerminal = vi.fn();
vi.mock("../../main/terminal/pty-manager.js", () => ({
  setTerminalEmitter: (fn: TerminalEmit) => { emitter = fn; },
  spawnTerminal: vi.fn(async ({ tabId }: { tabId: string }) => ({ ok: true, tabId, replayed: false })),
  writeTerminal,
  resizeTerminal: vi.fn(),
  killTerminal,
  terminalOwnedBy: (tabId: string, ownerWindowId: number | null) => !owners.has(tabId) || owners.get(tabId) === ownerWindowId,
}));

const { registerTerminalHandlers } = await import("../domains/terminal.js");
const { CHANNELS } = await import("../../contract/app-contract.js");

function appWindow(id: number) {
  return { id, isDestroyed: () => false };
}
const windowOne = appWindow(1);
const windowTwo = appWindow(2);

function from(win: { id: number }): IpcMainInvokeEvent {
  const sender = { windowId: win.id };
  return { senderFrame: { url: "file:///Applications/Ave.app/dist/index.html" }, sender } as unknown as IpcMainInvokeEvent;
}

beforeEach(() => {
  handlers.clear();
  owners.clear();
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
  it("sends a terminal's output and exit to its owning window only", () => {
    emitter("data", { tabId: "terminal:0000000a-1", chunk: "hi" }, 2);
    emitter("exit", { tabId: "terminal:0000000a-1", exitCode: 0 }, 2);
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
    expect(await input(from(windowTwo), { tabId: "terminal:0000000a-1", data: "rm -rf ~\r" })).toEqual({ ok: false, error: "not-owner" });
    expect(await resize(from(windowTwo), { tabId: "terminal:0000000a-1", cols: 10, rows: 10 })).toEqual({ ok: false, error: "not-owner" });
    expect(await kill(from(windowTwo), { tabId: "terminal:0000000a-1" })).toEqual({ ok: false, error: "not-owner" });
    expect(writeTerminal).not.toHaveBeenCalled();
    expect(killTerminal).not.toHaveBeenCalled();
    expect(await input(from(windowOne), { tabId: "terminal:0000000a-1", data: "ls\r" })).toEqual({ ok: true });
    expect(writeTerminal).toHaveBeenCalledWith("terminal:0000000a-1", "ls\r");
  });
});
