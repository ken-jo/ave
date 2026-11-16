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
const keepTerminalOutput = vi.fn(() => ({ ok: true }));
const reviewSnapshot = vi.fn(async () => ({ cwd: "/work", latestBlockId: null, files: [{ path: "/work/script.sh", sessionIds: ["s"], lastUsed: null }], warnings: [] }));
vi.mock("../../main/terminal/changed-file-evidence.js", () => ({
  terminalFileEvidence: { snapshot: reviewSnapshot },
}));
const tracker = { list: () => [] };
let currentTracker: typeof tracker | undefined;
vi.mock("../../main/terminal/terminal-blocks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../main/terminal/terminal-blocks.js")>();
  return {
    ...actual,
    getWindowTerminalBlockTracker: (...args: Parameters<typeof actual.getWindowTerminalBlockTracker>) => currentTracker ?? actual.getWindowTerminalBlockTracker(...args),
    getWindowTerminalBlockSession: (...args: Parameters<typeof actual.getWindowTerminalBlockSession>) => currentTracker
      ? terminalSessionFixture("terminal:0000000a-1", "manual") : actual.getWindowTerminalBlockSession(...args),
  };
});
const { spawnRequests, shellPreference, appearance, scrollback } = vi.hoisted(() => ({
  spawnRequests: [] as Array<Record<string, unknown>>,
  shellPreference: { read: null as (() => string) | null },
  appearance: { terminal: { shell: "" } },
  // Boot installs the store (boot/steps/terminal-scrollback-setup.ts); the domain only forgets a tab the user closes.
  scrollback: { install: vi.fn(), forgotten: [] as string[] },
}));
vi.mock("../../main/terminal/pty-manager.js", () => ({
  setTerminalEmitter: (fn: TerminalEmit) => { emitter = fn; },
  setManualShellPreference: (read: () => string) => { shellPreference.read = read; },
  setTerminalScrollbackStore: scrollback.install,
  forgetTerminalScrollback: (tabId: string) => { scrollback.forgotten.push(tabId); },
  spawnTerminal: vi.fn(async ({ tabId, lane, ...rest }: { tabId: string; lane: "manual" | "agent"; replay?: boolean }) => {
    spawnRequests.push({ tabId, lane, ...rest });
    return { ok: true, tabId, replayed: false, session: terminalSessionFixture(tabId, lane), blockMarkerToken: "view-token" };
  }),
  writeTerminal,
  resizeTerminal: vi.fn(() => ({ ok: true })),
  keepTerminalOutput,
  killTerminal,
  terminalOwnedBy: (tabId: string, ownerWindowId: number | null) => !internalIds.has(tabId) && (!owners.has(tabId) || owners.get(tabId) === ownerWindowId),
}));

const { TerminalBlockTracker, registerTerminalBlockTracker, __resetTerminalBlocksForTest } = await import("../../main/terminal/terminal-blocks.js");
const { TERMINAL_TEST_NONCE, terminalMarker } = await import("../../__tests__/support/terminal-markers.js");
const { createTerminalReadTool } = await import("../../tools/terminal-read.js");
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

const settingsService = { get: vi.fn((key: string) => (key === "appearance" ? appearance : undefined)) };

beforeEach(() => {
  __resetTerminalBlocksForTest();
  handlers.clear();
  owners.clear();
  internalIds.clear();
  fanOut.mockClear();
  writeTerminal.mockClear();
  killTerminal.mockClear();
  keepTerminalOutput.mockClear();
  reviewSnapshot.mockClear();
  settingsService.get.mockClear();
  scrollback.install.mockClear();
  currentTracker = undefined;
  fromWebContents.mockImplementation((sender: { windowId: number }) => (sender.windowId === 1 ? windowOne : windowTwo));
  registerTerminalHandlers({
    auditLogger: { log: vi.fn() },
    getMainWindow: () => windowOne,
    getAppWindows: () => [windowOne, windowTwo],
    settingsService,
  } as never);
});

describe("terminal IPC between two windows", () => {
  it("keeps what the owner's view shows of its tab, and refuses another window's or a malformed one", async () => {
    owners.set("terminal:0000000a-1", 1);
    const keep = handlers.get(CHANNELS.terminal.keep);
    if (!keep) throw new Error("the terminal domain registered no keep handler");
    expect(await keep(from(windowTwo), { tabId: "terminal:0000000a-1", shown: "shown\r\n" })).toEqual({ ok: false, error: "not-owner" });
    for (const payload of [
      { tabId: "terminal:0000000a-1", shown: 3 },
      { tabId: "terminal:0000000a-1" },
      { tabId: "", shown: "shown\r\n" },
      null,
    ]) expect(await keep(from(windowOne), payload)).toEqual({ ok: false, error: "invalid-params" });
    expect(keepTerminalOutput).not.toHaveBeenCalled();
    expect(await keep(from(windowOne), { tabId: "terminal:0000000a-1", shown: "shown\r\n" })).toEqual({ ok: true });
    expect(keepTerminalOutput).toHaveBeenCalledWith("terminal:0000000a-1", 1, "shown\r\n");
    // A view that could not serialize its terminal says so.
    expect(await keep(from(windowOne), { tabId: "terminal:0000000a-1", shown: null })).toEqual({ ok: true });
    expect(keepTerminalOutput).toHaveBeenLastCalledWith("terminal:0000000a-1", 1, null);
  });

  it("registers the exact native terminal owner before spawn and refuses ownership theft", async () => {
    const tabId = "terminal:0000000a-1";
    const spawn = handlers.get(CHANNELS.terminal.spawn)!;
    expect(await spawn(from(windowOne), { tabId, lane: "manual", purpose: "workspace" })).toMatchObject({ ok: true });
    expect(approvalSurfaceRegistry.resolve(undefined, tabId)).toBe(windowOne.webContents);
    owners.set(tabId, 1);
    expect(await spawn(from(windowTwo), { tabId, lane: "manual", purpose: "workspace" })).toMatchObject({ ok: false, reason: "not-owner" });
    expect(approvalSurfaceRegistry.resolve(undefined, tabId)).toBe(windowOne.webContents);
    updateApprovalSurface({ kind: "release-terminal", tabId });
  });

  it("never registers a terminal approval owner from a trusted-URL subframe", async () => {
    const tabId = "terminal:0000000a-2";
    const event = { ...from(windowOne), senderFrame: { url: "file:///Applications/Ave.app/dist/index.html" } };
    expect(await handlers.get(CHANNELS.terminal.spawn)!(event as IpcMainInvokeEvent, { tabId, lane: "manual", purpose: "workspace" }))
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


describe("terminal shell setting", () => {
  it("gives the PTY manager the saved shell, read again at every start", () => {
    if (!shellPreference.read) throw new Error("the terminal domain registered no shell preference");
    expect(shellPreference.read()).toBe("");
    appearance.terminal.shell = "/opt/homebrew/bin/fish";
    expect(shellPreference.read()).toBe("/opt/homebrew/bin/fish");
    appearance.terminal.shell = "";
  });
});

describe("kept terminal output", () => {
  it("reads no settings and installs no store at registration, asks for a restore only when the view does, and forgets a tab the user closes", async () => {
    // Registering reads nothing and touches no disk: the shell preference is read at each start, and boot owns the store.
    expect(settingsService.get).not.toHaveBeenCalled();
    expect(scrollback.install).not.toHaveBeenCalled();
    const spawn = handlers.get(CHANNELS.terminal.spawn);
    const kill = handlers.get(CHANNELS.terminal.kill);
    if (!spawn || !kill) throw new Error("the terminal domain registered no spawn or kill handler");
    const tabId = "terminal:0000000a-1";
    spawnRequests.length = 0;
    expect(await spawn(from(windowOne), { tabId, lane: "manual", purpose: "workspace", restore: true })).toMatchObject({ ok: true });
    expect(await spawn(from(windowOne), { tabId, lane: "manual", purpose: "workspace" })).toMatchObject({ ok: true });
    expect(spawnRequests.map((request) => request.restore)).toEqual([true, undefined]);
    expect(await spawn(from(windowOne), { tabId, lane: "manual", purpose: "workspace", restore: "yes" })).toMatchObject({ ok: false, reason: "bad-request" });
    scrollback.forgotten.length = 0;
    // Another window's tab is not this one's to close, and its output stays.
    owners.set(tabId, 1);
    expect(await kill(from(windowTwo), { tabId })).toEqual({ ok: false, error: "not-owner" });
    expect(scrollback.forgotten).toEqual([]);
    expect(await kill(from(windowOne), { tabId })).toEqual({ ok: true });
    expect(scrollback.forgotten).toEqual([tabId]);
  });
});

describe("terminal IPC lane validation", () => {
  it("forwards a no-replay re-attach and refuses a replay flag that is not a boolean", async () => {
    const spawn = handlers.get(CHANNELS.terminal.spawn);
    if (!spawn) throw new Error("the terminal domain registered no spawn handler");
    const tabId = "terminal:0000000a-7";
    spawnRequests.length = 0;
    expect(await spawn(from(windowOne), { tabId, lane: "manual", purpose: "workspace", replay: false })).toMatchObject({ ok: true });
    expect(await spawn(from(windowOne), { tabId, lane: "manual", purpose: "workspace" })).toMatchObject({ ok: true });
    expect(spawnRequests.map((request) => request.replay)).toEqual([false, undefined]);
    expect(await spawn(from(windowOne), { tabId, lane: "manual", purpose: "workspace", replay: "no" })).toMatchObject({ ok: false, reason: "bad-request" });
    expect(spawnRequests).toHaveLength(2);
  });

  it("requires explicit lane on spawn and incarnation on mutations and block reads", async () => {
    expect(await handlers.get(CHANNELS.terminal.spawn)!(from(windowOne), { tabId: "terminal:0000000a-1" })).toMatchObject({ ok: false, reason: "bad-request" });
    for (const channel of [CHANNELS.terminal.input, CHANNELS.terminal.resize, CHANNELS.terminal.blocks, CHANNELS.terminal.block, CHANNELS.terminal.fileReviews]) {
      expect(await handlers.get(channel)!(from(windowOne), { tabId: "terminal:0000000a-1" })).toEqual({ ok: false, error: "invalid-params" });
    }
  });
});


describe("conversation terminal privacy boundary", () => {
  it("refuses renderer agent requests and never forwards their data or exit", async () => {
    const ref = terminalSessionFixture("terminal:0000000a-9", "agent");
    expect(await handlers.get(CHANNELS.terminal.spawn)!(from(windowOne), { tabId: ref.tabId, lane: "agent" })).toMatchObject({ ok: false, reason: "bad-request" });
    for (const channel of [CHANNELS.terminal.input, CHANNELS.terminal.resize, CHANNELS.terminal.blocks, CHANNELS.terminal.block, CHANNELS.terminal.fileReviews]) {
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


describe("terminal preview display boundary", () => {
  it("returns only the last authenticated command to the owner renderer while model reads exclude the host", async () => {
    const tabId = "terminal:0000000a-1";
    owners.set(tabId, 1);
    const tracker = new TerminalBlockTracker({ nonce: TERMINAL_TEST_NONCE, marksPromptEnd: true });
    tracker.recordOutput(terminalMarker("P;Cwd=/repo;Keys=emacs;Paste=1") + terminalMarker("C;cmdline_url=make%20build") + "private output" + terminalMarker("D;0"));
    registerTerminalBlockTracker(terminalSessionFixture(tabId, "manual"), tracker, 1);
    const preview = handlers.get(CHANNELS.terminal.preview)!;
    expect(await preview(from(windowOne), { tabId })).toEqual({ ok: true, command: "make build" });
    expect(await preview(from(windowTwo), { tabId })).toEqual({ ok: false, error: "not-owner" });
    const tool = createTerminalReadTool({ windowIdForHostedSession: () => 1, liveOriginSessionId: () => undefined, conversationTerminalRef: () => undefined, hostDisclosure: () => undefined });
    const result = await tool.execute({}, { metadata: { sessionId: "conversation" } } as never);
    expect(result.output).not.toContain("make build");
    expect(result.output).not.toContain("private output");
    const targeted = await tool.execute({ tabId, terminalSessionId: `${tabId}/manual` }, { metadata: { sessionId: "conversation" } } as never);
    expect(targeted.isError).toBe(true);
    expect(targeted.output).not.toContain("make build");
    expect(fanOut).not.toHaveBeenCalled();
  });
  it("bounds a multiline command preview to its first line", async () => {
    const tabId = "terminal:0000000a-3";
    owners.set(tabId, 1);
    const tracker = new TerminalBlockTracker({ nonce: TERMINAL_TEST_NONCE, marksPromptEnd: true });
    const firstLine = `cat <<'END' ${"x".repeat(220)}`;
    tracker.recordOutput(terminalMarker("P;Cwd=/repo;Keys=emacs;Paste=1") + terminalMarker(`C;cmdline_url=${encodeURIComponent(`${firstLine}\nprivate heredoc body\nEND`)}`) + terminalMarker("D;0"));
    registerTerminalBlockTracker(terminalSessionFixture(tabId, "manual"), tracker, 1);
    const result = await handlers.get(CHANNELS.terminal.preview)!(from(windowOne), { tabId });
    expect(result).toEqual({ ok: true, command: `${firstLine.slice(0, 199)}…` });
    if (typeof result !== "object" || result === null || !("command" in result)) throw new Error("Expected command preview");
    expect(result.command).toHaveLength(200);
    expect(result.command).not.toContain("private heredoc body");
  });
  it("exposes no raw scrollback or heuristic command and rejects subframes and agent payloads", async () => {
    const tabId = "terminal:0000000a-2";
    const tracker = new TerminalBlockTracker({ nonce: TERMINAL_TEST_NONCE, marksPromptEnd: true });
    tracker.recordInput("untrusted command\r"); tracker.recordOutput("raw scrollback");
    registerTerminalBlockTracker(terminalSessionFixture(tabId, "manual"), tracker, 1);
    const preview = handlers.get(CHANNELS.terminal.preview)!;
    expect(await preview(from(windowOne), { tabId })).toEqual({ ok: true, command: null });
    expect(await preview(from(windowOne), { tabId, lane: "agent" })).toEqual({ ok: false, error: "invalid-params" });
    const event = { ...from(windowOne), senderFrame: { url: "file:///Applications/Ave.app/dist/index.html" } };
    expect(await preview(event as IpcMainInvokeEvent, { tabId })).toMatchObject({ ok: false });
  });
});

describe("host file review boundary", () => {
  const ref = terminalSessionFixture("terminal:0000000a-1", "manual");
  it("requires the owning window, top-level sender and current incarnation", async () => {
    owners.set(ref.tabId, 1);
    const handler = handlers.get(CHANNELS.terminal.fileReviews)!;
    expect(await handler(from(windowTwo), ref)).toEqual({ ok: false, error: "not-owner" });
    expect(await handler({ ...from(windowOne), senderFrame: { url: "file:///Applications/Ave.app/dist/index.html" } } as IpcMainInvokeEvent, ref)).toMatchObject({ ok: false });
    expect(await handler(from(windowOne), ref)).toEqual({ ok: false, error: "stale-terminal-session" });
    expect(reviewSnapshot).not.toHaveBeenCalled();
  });
  it("lists the read-only snapshot and registers no channel that records a review", async () => {
    currentTracker = tracker;
    expect(await handlers.get(CHANNELS.terminal.fileReviews)!(from(windowOne), ref)).toMatchObject({ ok: true, snapshot: { files: [{ path: "/work/script.sh" }] } });
    expect([...handlers.keys()].filter((channel) => channel.startsWith("ave:terminal:") && /review/u.test(channel))).toEqual([CHANNELS.terminal.preview, CHANNELS.terminal.fileReviews]);
    expect(writeTerminal).not.toHaveBeenCalled();
  });
  it("revokes responses when the terminal closes during filesystem reads", async () => {
    currentTracker = tracker;
    reviewSnapshot.mockImplementationOnce(async () => {
      currentTracker = undefined;
      return { cwd: "/work", latestBlockId: null, files: [], warnings: [] };
    });
    expect(await handlers.get(CHANNELS.terminal.fileReviews)!(from(windowOne), ref)).toEqual({ ok: false, error: "stale-terminal-session" });
  });
});
