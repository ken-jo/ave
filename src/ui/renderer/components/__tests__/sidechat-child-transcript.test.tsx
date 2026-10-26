// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect, useMemo } from "react";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNELS, PERMISSIONS } from "../../../../contract/app-contract.js";
import { sessionUuid } from "../../../../__tests__/support/session-uuid.js";
import { cleanupTmpDir } from "../../../../__tests__/support/tmp-dir-teardown.js";
import { installNativeChatWindow, nativeChatFrameEvent } from "../../../../__tests__/support/native-chat-window.js";
import { MemoryManager } from "../../../../memory/memory-manager.js";
import { openFeatureNamespace } from "../../../../main/storage/feature-namespace.js";
import { SubAgentRunner } from "../../../../engine/subagent-runner.js";
import { registerChatHandlers } from "../../../../ipc/domains/chat.js";
import { registerSideChatHandlers } from "../../../../ipc/domains/sidechat.js";
import type { IpcDeps } from "../../../../ipc/types.js";
import { buildPublicSurface } from "../../../../preload/public-surface.js";
import { buildInternalApiSurface } from "../../../../preload/internal-api-surface.js";
import { fakeLlmSettings } from "../../../../shared/__tests__/fake-llm-settings.js";
import type { GenericMessage } from "../../../../engine/llm/types.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ApprovalSurfaceProvider, useApproval, type ApprovalSurfaceContextValue } from "../../hooks/use-approval.js";
import { useSideChat } from "../../hooks/use-side-chat.js";
import { ChatContextProvider, type ChatContextValue } from "../../context/ChatContext.js";
import { useWorkspaceTabs } from "../../preview/workspace-tabs.js";
import { ChatSidePanel } from "../ChatSidePanel.js";
import type { SubAgentSpawn } from "../../subagents/types.js";
import type { AveApi } from "../../types.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { approvalRequest, approvalSurfaceStub, deferred, emptyToolActivity } from "../../../../../test/renderer/helpers.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../../shared/test-ids.js";
import type { AgentSpawnEvent } from "../../../../shared/subagent-events.js";
import { A2ATaskState } from "../../../../shared/a2a.js";

// Native transport and parent loops are fixtures. The production registrar, sender guard, preload methods, runner
// ownership/read and child store remain real, so a renderer-only mock cannot hide a refusal at the host boundary.
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
let senderFrame: { url: string } | null = { url: "file:///index.html" };
const replies: Array<{ channel: string; result: unknown }> = [];
function publish(channel: string, payload: unknown) {
  for (const listener of listeners.get(channel) ?? []) listener({}, payload);
}
const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Unregistered test channel: ${channel}`);
  const result = await handler({ ...nativeChatFrameEvent(), senderFrame }, ...args);
  replies.push({ channel, result });
  return result;
});
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
  },
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => invoke(channel, ...args),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      const subscribed = listeners.get(channel) ?? new Set();
      subscribed.add(listener);
      listeners.set(channel, subscribed);
    }),
    removeListener: vi.fn((channel: string, listener: (...args: unknown[]) => void) => listeners.get(channel)?.delete(listener)),
  },
}));

const TILE_GROUP = "transcript-tile";
const sideSessionId = sessionUuid("transcript-side-owner");
const tileSessionId = sessionUuid("transcript-tile-owner");
const primarySessionId = sessionUuid("transcript-primary-owner");
const replacementSessionId = sessionUuid("transcript-replacement-side-owner");
const childSessionId = `sub-owned-${sessionUuid("transcript-side-child")}`;
const foreignChildId = `sub-foreign-${sessionUuid("transcript-foreign-child")}`;
const tileChildId = `sub-tile-${sessionUuid("transcript-tile-child")}`;

function parentLoop(initialSessionId: string) {
  let sessionId = initialSessionId;
  let transitioning = false;
  const messages: GenericMessage[] = [];
  const history = { length: 0, getMessages: () => messages };
  return {
    getSessionId: () => sessionId,
    getSessionKind: () => "main" as const,
    getHistory: () => history,
    isSessionTransitioning: () => transitioning,
    hasProvider: () => true,
    hasActiveTurn: () => false,
    runTurn: vi.fn(async () => ({ route: "chat" })),
    abortCurrentTurn: vi.fn(),
    loadSession: vi.fn(async (nextSessionId: string) => {
      sessionId = nextSessionId;
      return true;
    }),
    newConversation: vi.fn(async () => { sessionId = replacementSessionId; }),
    runSessionTransition: async <T,>(_reason: string, operation: (lease: object) => Promise<T>): Promise<T> => {
      transitioning = true;
      try {
        return await operation({});
      } finally {
        transitioning = false;
      }
    },
  };
}

let scratchHome: string;
let previousAveHome: string | undefined;
let previousAveDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  handlers.clear();
  listeners.clear();
  replies.length = 0;
  invoke.mockClear();
  senderFrame = { url: "file:///index.html" };
  previousAveHome = process.env.AVE_HOME;
  previousAveDescriptor = Object.getOwnPropertyDescriptor(window, "ave");
  scratchHome = mkdtempSync(join(tmpdir(), "ave-child-transcript-"));
  process.env.AVE_HOME = scratchHome;
});

afterEach(async () => {
  if (previousAveDescriptor) Object.defineProperty(window, "ave", previousAveDescriptor);
  else Reflect.deleteProperty(window, "ave");
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  await cleanupTmpDir(scratchHome);
});

async function setup() {
  const ownerWindow = { webContents: { send: publish, isDestroyed: () => false, on: vi.fn() } };
  await installNativeChatWindow(ownerWindow);
  senderFrame = nativeChatFrameEvent().senderFrame;
  const childStore = new MemoryManager({ aveDir: openFeatureNamespace("subagent").dir });
  const mainStore = new MemoryManager({ aveDir: scratchHome });
  childStore.load();
  mainStore.load();
  for (const [child, origin, content] of [
    [childSessionId, sideSessionId, "Persisted side-chat child transcript"],
    [foreignChildId, tileSessionId, "Foreign child must remain private"],
    [tileChildId, tileSessionId, "Persisted tile child transcript"],
  ]) {
    await childStore.saveSession(child, [{ role: "assistant", content }]);
    await childStore.saveSessionMetadata(child, { sessionKind: "subagent", originSessionId: origin });
  }
  // These reads require only the real isolated store; no child turn or provider execution is needed to exercise the runner's
  // persisted transcript methods.
  const runner = new SubAgentRunner({ subAgentMemoryManager: childStore } as ConstructorParameters<typeof SubAgentRunner>[0]);
  const read = vi.spyOn(runner, "getPersistedTranscript");
  const primaryLoop = parentLoop(primarySessionId);
  const tileLoop = parentLoop(tileSessionId);
  const sideLoop = parentLoop(sideSessionId);
  const deps = {
    conversationLoop: primaryLoop,
    sideChatConversationLoop: sideLoop,
    // No pane chat is open in these flows.
    paneChatLoops: {
      resolve: () => { throw new Error("no pane chat in this test"); },
      get: () => undefined,
      release: () => undefined,
      inWindow: () => [],
      holding: () => undefined,
      all: () => [],
    },
    memoryManager: mainStore,
    resolveChatGroupLoop: (group: string) => {
      if (group !== TILE_GROUP) throw new Error("Unknown test chat group");
      return tileLoop;
    },
    releaseChatGroupLoop: vi.fn(),
    getSubAgentRunner: () => runner,
    settingsService: { get: (key: string) => key === "llm" ? fakeLlmSettings() : {} },
    auditLogger: { log: vi.fn() },
    getMainWindow: () => ownerWindow,
  } as unknown as IpcDeps;
  registerChatHandlers(deps);
  registerSideChatHandlers(deps);
  handlers.set(PERMISSIONS.approvalPending, async () => []);
  const publicApi = buildPublicSurface();
  const internalApi = buildInternalApiSurface();
  const { api: fixtureApi } = makeMockAveApi({ sideChat: true });
  const api: AveApi = {
    ...(fixtureApi as unknown as AveApi),
    ...publicApi.chatGroup(TILE_GROUP),
    sideChat: internalApi.sideChat,
    approval: internalApi.approval,
    onAgentSpawnEvent: internalApi.onAgentSpawnEvent,
    onAskUserQuestion: internalApi.onAskUserQuestion,
    onAskUserQuestionTimeout: internalApi.onAskUserQuestionTimeout,
  };
  return { api, deps, runner, read, sideLoop, tileLoop };
}

describe("side-chat session transition boundary", () => {
  it("keeps the host and hook on the accepted session after a competing load is refused", async () => {
    const { api, sideLoop } = await setup();
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.loadSession(sideSessionId); });
    const entered = deferred<void>();
    const completion = deferred<void>();
    const loadSession = sideLoop.loadSession.getMockImplementation()!;
    sideLoop.loadSession.mockImplementationOnce(async (next) => {
      entered.resolve(undefined);
      await completion.promise;
      return loadSession(next);
    });
    let accepted = Promise.resolve();
    act(() => { accepted = result.current.loadSession(replacementSessionId); });
    await entered.promise;
    try {
      await act(async () => { await result.current.loadSession(tileSessionId); });
      expect(replies.at(-1)).toMatchObject({
        channel: CHANNELS.sidechat.load, result: { ok: false, error: "streaming-active" },
      });
    } finally {
      await act(async () => { completion.resolve(undefined); await accepted; });
    }
    expect(sideLoop.getSessionId()).toBe(replacementSessionId);
    expect(result.current.sessionId).toBe(sideLoop.getSessionId());
    expect(result.current.entries).toContainEqual(expect.objectContaining({
      kind: "assistant", terminalError: true,
      text: "아직 응답을 생성하는 중입니다. 중지하거나 끝날 때까지 기다린 뒤 다시 보내 주세요.",
    }));
  });

  it("continues the conversation its view shows after a peer started a new host session", async () => {
    const { api, sideLoop } = await setup();
    sideLoop.getHistory().getMessages().push({ role: "user", content: "Old transcript" });
    const { result } = renderHook(() => useSideChat(api));
    await act(async () => { await result.current.loadSession(sideSessionId); });
    expect(result.current.entries).toContainEqual(expect.objectContaining({ kind: "user", text: "Old transcript" }));
    await api.sideChat!.new();
    expect(sideLoop.getSessionId()).toBe(replacementSessionId);
    await act(async () => { await result.current.send("New prompt"); });
    // The send names the session this view shows, so the host moves back onto it rather than writing this view's prompt into
    // the peer's new session.
    expect(sideLoop.getSessionId()).toBe(sideSessionId);
    expect(result.current.sessionId).toBe(sideSessionId);
    expect(result.current.entries.filter((entry) => entry.kind === "user").map((entry) => entry.text))
      .toEqual(["Old transcript", "New prompt"]);
  });
});

function Panel({ api, spawns = [], openStoredSession = true, surface }: {
  api: AveApi;
  spawns?: SubAgentSpawn[];
  openStoredSession?: boolean;
  surface?: ApprovalSurfaceContextValue;
}) {
  const workspaceTabs = useWorkspaceTabs();
  const defaultSurface = useMemo(approvalSurfaceStub, []);
  const context = useMemo(() => ({ currentSessionId: tileSessionId, hasApiKey: true }) as ChatContextValue, []);
  return (
    <TooltipProvider>
      <ApprovalSurfaceProvider value={surface ?? defaultSurface}>
        <ChatContextProvider value={context}>
        <ChatSidePanel
          api={api}
          sessionId={tileSessionId}
          targets={[]}
          files={[]}
          selectedId={null}
          onSelect={vi.fn()}
          workspaceTabs={workspaceTabs}
          subAgentSpawns={spawns}
          width={340}
          onWidthChange={vi.fn()}
          onWidthCommit={vi.fn()}
          onClose={vi.fn()}
          activity={emptyToolActivity()}
          {...(openStoredSession ? { sideChatOpenRequest: { chatGroupId: TILE_GROUP, sessionId: sideSessionId, nonce: 1 } } : {})}
        />
        </ChatContextProvider>
      </ApprovalSurfaceProvider>
    </TooltipProvider>
  );
}

function ApprovalPanel({ api, onSurface }: {
  api: AveApi;
  onSurface: (surface: ApprovalSurfaceContextValue) => void;
}) {
  const approvals = useApproval();
  const surface = useMemo(() => ({ ...approvalSurfaceStub(), ...approvals }), [approvals]);
  useLayoutEffect(() => { onSurface(surface); }, [onSurface, surface]);
  return <Panel api={api} openStoredSession={false} surface={surface} />;
}

function openSubagentTab() {
  const trigger = screen.getByTestId("chat-side-panel-add-tab");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByTestId("chat-side-panel-launcher-menu-subagent"));
}

describe("side-chat child transcript across host and renderer", () => {
  it.each(["spawn", "question", "approval"] as const)(
    "binds the first pending send without an open request before its %s events",
    async (eventKind) => {
      const { api, read, sideLoop } = await setup();
      const pending = deferred<{ route: string }>();
      const surface = approvalSurfaceStub();
      const live: { surface: ApprovalSurfaceContextValue | null } = { surface: null };
      let ownerAtTurnStart: string | null = null;
      sideLoop.runTurn.mockImplementation(async () => {
        ownerAtTurnStart = (live.surface ?? surface).claims.ownerOf(sideSessionId);
        if (eventKind === "spawn") {
          const event: AgentSpawnEvent = {
            type: "start", spawnId: "first-side-spawn", parentSessionId: sideSessionId,
            taskState: A2ATaskState.SUBMITTED, title: "First side child", childSessionId,
          };
          publish(CHANNELS.agentSpawn.event, event);
          publish(CHANNELS.agentSpawn.event, { ...event, type: "done", taskState: A2ATaskState.COMPLETED, entries: [], toolCallCount: 0 });
        } else if (eventKind === "question") {
          publish(CHANNELS.askUserQuestion.request, {
            id: "ask-side", sessionId: sideSessionId, createdAt: Date.now(),
            questions: [{ question: "Question for the first side turn", choices: ["Continue", "Stop"] }],
          });
          publish(CHANNELS.askUserQuestion.request, {
            id: "ask-main", sessionId: tileSessionId, createdAt: Date.now(),
            questions: [{ question: "Foreign question must stay outside", choices: ["Continue", "Stop"] }],
          });
        } else {
          publish(CHANNELS.approval.request, approvalRequest({ id: "approval-side", sessionId: sideSessionId, toolName: "side-task" }));
          publish(CHANNELS.approval.request, approvalRequest({ id: "approval-main", sessionId: tileSessionId, toolName: "foreign-task" }));
        }
        return pending.promise;
      });
      if (eventKind === "approval") {
        Object.defineProperty(window, "ave", { value: { approval: api.approval }, configurable: true, writable: true });
        render(<ApprovalPanel api={api} onSurface={(next) => { live.surface = next; }} />);
      } else {
        render(<Panel api={api} openStoredSession={false} surface={surface} />);
      }
      fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("side-chat")));
      if (eventKind === "spawn") {
        publish(CHANNELS.agentSpawn.event, {
          type: "start", spawnId: "before-prelude-spawn", parentSessionId: sideSessionId,
          taskState: A2ATaskState.SUBMITTED, title: "Child before identity",
        } satisfies AgentSpawnEvent);
      }
      try {
        const sideView = within(screen.getByTestId("side-chat-view"));
        fireEvent.change(sideView.getByTestId("composer-textarea"), { target: { value: "Start the first side turn" } });
        fireEvent.click(sideView.getByTestId("composer-send-button"));
        await waitFor(() => expect(sideLoop.runTurn).toHaveBeenCalledOnce());
        expect(replies.some(({ channel }) => channel === CHANNELS.sidechat.send)).toBe(false);
        expect(invoke).not.toHaveBeenCalledWith(CHANNELS.sidechat.load, expect.anything());
        expect(invoke).not.toHaveBeenCalledWith(CHANNELS.sidechat.new);
        if (eventKind === "spawn") {
          openSubagentTab();
          await screen.findByRole("option", { name: /First side child/ });
          expect(screen.getAllByTestId("chat-side-panel-subagent-row")).toHaveLength(1);
          expect(screen.queryByRole("option", { name: /Child before identity/ })).toBeNull();
          await within(screen.getByTestId("chat-side-panel-subagent-detail")).findByText("Persisted side-chat child transcript");
          expect(read).toHaveBeenCalledExactlyOnceWith({ originSessionId: sideSessionId, childSessionId });
          expect(invoke).not.toHaveBeenCalledWith(CHANNELS.chat.getSubAgentTranscript, expect.anything(), expect.anything());
        } else if (eventKind === "question") {
          const overlay = await sideView.findByTestId(TEST_IDS.questionOverlay);
          expect(overlay).toHaveTextContent("Question for the first side turn");
          expect(overlay).not.toHaveTextContent("Foreign question must stay outside");
        } else {
          const dock = await sideView.findByTestId(TEST_IDS.approvalDock);
          expect(dock).toHaveTextContent("side-task");
          expect(dock).not.toHaveTextContent("foreign-task");
          expect(live.surface?.claims.ownerOf(tileSessionId)).toBeNull();
          expect(listeners.get(CHANNELS.approval.request)?.size).toBe(1);
        }
        expect(ownerAtTurnStart).toBe(`side-chat:${sideSessionId}`);
      } finally {
        await act(async () => {
          pending.resolve({ route: "chat" });
          await pending.promise;
          await Promise.allSettled(invoke.mock.results.map(({ value }) => value));
        });
      }
    },
  );

  it("renders the persisted child through its side-chat owner read", async () => {
    const { api, read } = await setup();
    render(<Panel api={api} />);
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("side-chat")));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(CHANNELS.sidechat.load, sideSessionId));
    await waitFor(() => expect(listeners.get(CHANNELS.agentSpawn.event)?.size).toBeGreaterThan(0));
    await act(async () => {
      const event: AgentSpawnEvent = {
        type: "start", spawnId: "side-spawn", parentSessionId: sideSessionId,
        taskState: A2ATaskState.SUBMITTED, title: "Side child",
      };
      for (const listener of listeners.get(CHANNELS.agentSpawn.event) ?? []) {
        listener({}, event);
        listener({}, { ...event, type: "activity", taskState: A2ATaskState.WORKING, childSessionId });
        listener({}, { ...event, type: "done", taskState: A2ATaskState.COMPLETED, childSessionId, entries: [], toolCallCount: 0 });
      }
    });
    openSubagentTab();
    const detail = screen.getByTestId("chat-side-panel-subagent-detail");
    const transcriptReply = () => replies.find(({ channel }) =>
      channel === CHANNELS.sidechat.getSubAgentTranscript || channel === CHANNELS.chat.getSubAgentTranscript);
    await waitFor(() => expect(transcriptReply()).toBeDefined());
    expect(transcriptReply()!.result).toMatchObject({ ok: true, childSessionId });
    await within(detail).findByText("Persisted side-chat child transcript");
    expect(invoke).toHaveBeenCalledWith(CHANNELS.sidechat.getSubAgentTranscript, {
      originSessionId: sideSessionId, childSessionId,
    });
    expect(invoke).not.toHaveBeenCalledWith(CHANNELS.chat.getSubAgentTranscript, expect.anything(), expect.anything());
    expect(read).toHaveBeenCalledExactlyOnceWith({ originSessionId: sideSessionId, childSessionId });
  });

  it("denies a foreign side-chat origin through the actual preload and host", async () => {
    const { api, read } = await setup();
    await expect(api.sideChat!.getSubAgentTranscript!({ originSessionId: tileSessionId, childSessionId }))
      .resolves.toEqual({ ok: false, error: "origin-session-not-active" });
    expect(read).not.toHaveBeenCalled();
  });

  it("denies a persisted foreign child through real metadata ownership", async () => {
    const { api, read } = await setup();
    await expect(api.sideChat!.getSubAgentTranscript!({ originSessionId: sideSessionId, childSessionId: foreignChildId }))
      .resolves.toEqual({ ok: false, error: "sub-agent-reference-not-found" });
    expect(read).not.toHaveBeenCalled();
  });

  it("denies a retained preload read if the configured side-chat loop is unavailable", async () => {
    const { api, deps, read } = await setup();
    deps.sideChatConversationLoop = undefined;
    await expect(api.sideChat!.getSubAgentTranscript!({ originSessionId: sideSessionId, childSessionId }))
      .resolves.toEqual({ ok: false, error: "side-chat-unavailable" });
    expect(read).not.toHaveBeenCalled();
  });

  it("denies the old side-chat owner after a new-session transition", async () => {
    const { api, read } = await setup();
    await expect(api.sideChat!.new()).resolves.toMatchObject({ ok: true, sessionId: replacementSessionId });
    await expect(api.sideChat!.getSubAgentTranscript!({ originSessionId: sideSessionId, childSessionId }))
      .resolves.toEqual({ ok: false, error: "origin-session-not-active" });
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the tile path bound to the tile's active origin", async () => {
    const { api, read } = await setup();
    await expect(api.chatGetSubAgentTranscript!({ originSessionId: sideSessionId, childSessionId }))
      .resolves.toEqual({ ok: false, error: "origin-session-not-active" });
    expect(read).not.toHaveBeenCalled();
    render(<Panel api={api} spawns={[{
      spawnId: "tile-spawn", childSessionId: tileChildId, parentSessionId: tileSessionId,
      title: "Tile child", status: "done", entries: [], toolCallCount: 0,
    }]} />);
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    await within(screen.getByTestId("chat-side-panel-subagent-detail")).findByText("Persisted tile child transcript");
    expect(invoke).toHaveBeenCalledWith(CHANNELS.chat.getSubAgentTranscript, {
      originSessionId: tileSessionId, childSessionId: tileChildId,
    }, TILE_GROUP);
    expect(invoke).not.toHaveBeenCalledWith(CHANNELS.sidechat.getSubAgentTranscript, expect.anything());
    expect(read).toHaveBeenCalledExactlyOnceWith({ originSessionId: tileSessionId, childSessionId: tileChildId });
  });

  it("keeps the real sender guard on the new read", async () => {
    const { api, read } = await setup();
    senderFrame = null;
    await expect(api.sideChat!.getSubAgentTranscript!({ originSessionId: sideSessionId, childSessionId }))
      .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
    expect(read).not.toHaveBeenCalled();
  });
});
