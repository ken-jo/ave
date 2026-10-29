import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { ObservationDaemon } from "../../observation/daemon.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { TerminalObservationEvent, ObservationBinding } from "../../shared/agent-observation.js";
import { beginAgentTerminalObservation, releaseAgentTerminalObservationSessions } from "../../tools/agent-terminal-observation.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../../tools/agent-observation-context.js";

const state = vi.hoisted(() => ({ defaultSession: {}, holder: null as unknown, registered: true,
  paneWindowId: null as number | null, railSessionId: undefined as string | undefined, railOwner: null as unknown,
  childParent: undefined as string | undefined }));
vi.mock("electron", () => ({ session: { defaultSession: state.defaultSession } }));
vi.mock("../app-state.js", () => ({ findSessionMainWindowContents: (id: string) => id === "session-one" ? state.holder : null,
  sideChatOwnerWindow: () => state.railOwner }));
import { TerminalObservationRuntime } from "../terminal-observation.js";

const frame = { url: "file:///app/index.html", detached: false, isDestroyed: () => false };
const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame, isDestroyed: () => false,
  getType: () => "window", session: state.defaultSession, send: vi.fn() });
const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
const deps = { getAppWindows: () => state.registered ? [{ id: 1, isDestroyed: () => false, webContents: sender }] : [], getMainWindow: () => null,
  paneChatLoops: { holding: (id: string) => id === "session-one" && state.paneWindowId !== null ? { windowId: state.paneWindowId } : undefined },
  sideChatConversationLoop: { getSessionId: () => state.railSessionId },
  getSubAgentRunner: () => ({ liveOriginSessionId: (id: string) => id === "child-session" ? state.childParent : undefined }) } as never;
const identity = { sessionId: "session-one", turnId: "turn-one", toolUseId: "tool-one" };
const input = { kind: "shell" as const, command: "bun test", cwd: "/workspace", sandbox: { mode: "isolated" as const, detail: "filesystem/process confinement" } };
let daemon: ObservationDaemon;
let runtime: TerminalObservationRuntime;

function subscribe(): ObservationBinding {
  const result = runtime.acknowledge(event, { action: "subscribe-terminal", sessionId: identity.sessionId });
  expect(result?.ok).toBe(true);
  return result!.observation!;
}
const events = (): TerminalObservationEvent[] => sender.send.mock.calls.flatMap((call) => call[1] as TerminalObservationEvent[]);
const start = () => runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity, async () => beginAgentTerminalObservation(input)!));

beforeEach(() => {
  vi.useFakeTimers();
  state.holder = sender;
  state.registered = true;
  state.paneWindowId = null;
  state.railSessionId = undefined;
  state.railOwner = null;
  state.childParent = undefined;
  sender.session = state.defaultSession;
  frame.detached = false;
  sender.send.mockClear();
  daemon = new ObservationDaemon();
  runtime = new TerminalObservationRuntime(deps, daemon);
});
afterEach(() => { runtime.dispose(); daemon.dispose(); vi.useRealTimers(); });

describe("terminal observation desktop binding", () => {
  it("admits a live child in its parent's window without borrowing another session's commands", async () => {
    const request = { action: "subscribe-terminal", sessionId: "child-session" };
    expect(runtime.acknowledge(event, request)).toEqual({ ok: false, error: "unauthorized" });
    state.childParent = identity.sessionId;
    const result = runtime.acknowledge(event, request);
    expect(result?.ok).toBe(true);
    const lease = await start();
    lease.write("parent-only-output");
    await vi.advanceTimersByTimeAsync(100);
    expect(events().at(-1)?.after).toMatchObject({ commands: [] });
    expect(JSON.stringify(events())).not.toContain("parent-only-output");
    state.childParent = undefined;
    expect(runtime.acknowledge(event, { action: "rendered", ...result!.observation!, seq: 0 })).toEqual({ ok: false, error: "unauthorized" });
  });
  it("admits a pane conversation only in the main-owned pane window", () => {
    state.holder = null;
    state.paneWindowId = 2;
    expect(runtime.acknowledge(event, { action: "subscribe-terminal", sessionId: identity.sessionId })).toEqual({ ok: false, error: "unauthorized" });
    state.paneWindowId = 1;
    const binding = subscribe();
    state.paneWindowId = null;
    expect(runtime.acknowledge(event, { action: "rendered", ...binding, seq: 0 })).toEqual({ ok: false, error: "unauthorized" });
  });

  it("admits the rail conversation only while its exact loop and owner still match", () => {
    state.holder = null;
    state.railSessionId = identity.sessionId;
    expect(runtime.acknowledge(event, { action: "subscribe-terminal", sessionId: identity.sessionId })).toEqual({ ok: false, error: "unauthorized" });
    state.railOwner = { webContents: sender };
    const binding = subscribe();
    state.railSessionId = "replacement";
    expect(runtime.acknowledge(event, { action: "rendered", ...binding, seq: 0 })).toEqual({ ok: false, error: "unauthorized" });
  });
  it("uses the existing private observation push and acknowledgement channel", async () => {
    const binding = subscribe();
    await vi.advanceTimersByTimeAsync(1);
    expect(sender.send).toHaveBeenCalledWith(CHANNELS.preview.observationEvents, expect.any(Array));
    expect(events()).toMatchObject([{ source: "terminal", actor: "agent", sessionId: identity.sessionId,
      target: { id: binding.targetId }, kind: "snapshot", after: { commands: [] } }]);
    expect(runtime.acknowledge(event, { action: "rendered", ...binding, seq: events()[0].seq })).toEqual({ ok: true });
    const lease = await start();
    lease.write("testing\n");
    await vi.advanceTimersByTimeAsync(100);
    const latest = events().at(-1)!;
    expect(latest).toMatchObject({ source: "terminal", after: { commands: [{ command: "bun test", outputTail: "testing\n", status: "running" }] } });
    runtime.acknowledge(event, { action: "rendered", ...binding, seq: latest.seq });
    lease.finish(3);
    await vi.advanceTimersByTimeAsync(100);
    expect(events().at(-1)).toMatchObject({ after: { commands: [{ exitCode: 3, status: "failed" }] } });
  });

  it.each([
    ["another session", () => ({ action: "subscribe-terminal", sessionId: "session-two" })],
    ["a path request", () => ({ action: "subscribe-terminal", sessionId: identity.sessionId, path: "/secret" })],
    ["an oversized session", () => ({ action: "subscribe-terminal", sessionId: "s".repeat(257) })],
    ["an empty session", () => ({ action: "subscribe-terminal", sessionId: "" })],
  ])("refuses %s without exposing a binding", (_name, request) => {
    expect(runtime.acknowledge(event, request())).toMatchObject({ ok: false });
    expect(events()).toEqual([]);
  });

  it("refuses subframes, plugin partitions and unregistered contents", () => {
    expect(runtime.acknowledge({ ...event, senderFrame: { ...frame } } as never,
      { action: "subscribe-terminal", sessionId: identity.sessionId })).toEqual({ ok: false, error: "unauthorized" });
    sender.session = {};
    expect(runtime.acknowledge(event, { action: "subscribe-terminal", sessionId: identity.sessionId })).toEqual({ ok: false, error: "unauthorized" });
    sender.session = state.defaultSession;
    state.registered = false;
    expect(runtime.acknowledge(event, { action: "subscribe-terminal", sessionId: identity.sessionId })).toEqual({ ok: false, error: "unauthorized" });
  });

  it("refuses stolen and future acknowledgements while preserving the owner", async () => {
    const binding = subscribe();
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.acknowledge(event, { action: "rendered", ...binding, sessionId: "session-two", seq: 1 })).toEqual({ ok: false, error: "unauthorized" });
    expect(() => runtime.acknowledge(event, { action: "rendered", ...binding, seq: 100 })).toThrow("Invalid observation acknowledgement.");
    expect(runtime.acknowledge(event, { action: "rendered", ...binding, seq: 1 })).toEqual({ ok: true });
  });

  it.each(["destroyed", "render-process-gone", "did-frame-navigate"])("revokes the view on %s", async (name) => {
    const binding = subscribe();
    const lease = await start();
    if (name === "did-frame-navigate") sender.emit(name, {}, "file:///app/reloaded.html", 0, "", true);
    else sender.emit(name);
    lease.write("late\n");
    await vi.advanceTimersByTimeAsync(100);
    expect(events()).toEqual([]);
    expect(runtime.acknowledge(event, { action: "rendered", ...binding, seq: 0 })).toBeUndefined();
    expect(sender.listenerCount("destroyed")).toBe(0);
  });

  it("rechecks session and frame identity at delivery", async () => {
    subscribe();
    state.holder = null;
    await vi.advanceTimersByTimeAsync(100);
    expect(events()).toEqual([]);
    frame.detached = true;
    expect(runtime.acknowledge(event, { action: "subscribe-terminal", sessionId: identity.sessionId })).toMatchObject({ ok: false });
  });

  it("releases subscriptions and buffers when a conversation is deleted", async () => {
    subscribe();
    const lease = await start();
    lease.write("held private value");
    releaseAgentTerminalObservationSessions((id) => id === identity.sessionId);
    expect(lease.signal.aborted).toBe(true);
    lease.write("late\n");
    await vi.advanceTimersByTimeAsync(100);
    expect(events()).toEqual([]);
    expect(sender.listenerCount("destroyed")).toBe(0);
    subscribe();
    await vi.advanceTimersByTimeAsync(1);
    expect(events()).toMatchObject([{ after: { commands: [] } }]);
  });

  it("does not retain duplicate subscriptions or owner listeners", () => {
    const first = subscribe();
    const second = subscribe();
    expect(second.targetId).not.toBe(first.targetId);
    expect(sender.listenerCount("destroyed")).toBe(1);
    expect(runtime.acknowledge(event, { action: "release", ...second })).toEqual({ ok: true });
    expect(sender.listenerCount("destroyed")).toBe(0);
  });
});
