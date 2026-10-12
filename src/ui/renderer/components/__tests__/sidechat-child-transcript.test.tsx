// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHANNELS } from "../../../../contract/app-contract.js";
import { sessionUuid } from "../../../../__tests__/support/session-uuid.js";
import { cleanupTmpDir } from "../../../../__tests__/support/tmp-dir-teardown.js";
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
import { ApprovalSurfaceProvider } from "../../hooks/use-approval.js";
import { useWorkspaceTabs } from "../../preview/workspace-tabs.js";
import { ChatSidePanel } from "../ChatSidePanel.js";
import type { SubAgentSpawn } from "../../subagents/types.js";
import type { AveApi } from "../../types.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { approvalSurfaceStub, emptyToolActivity } from "../../../../../test/renderer/helpers.js";
import { chatSidePanelLauncherTestId } from "../../../../shared/test-ids.js";
import type { AgentSpawnEvent } from "../../../../shared/subagent-events.js";
import { A2ATaskState } from "../../../../shared/a2a.js";

// Native transport and parent loops are fixtures. The production registrar,
// sender guard, preload methods, runner ownership/read and child store remain
// real, so a renderer-only mock cannot hide a refusal at the host boundary.
const handlers = new Map<string, (...args: unknown[]) => unknown>();
const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
let senderFrame: { url: string } | null = { url: "file:///index.html" };
const replies: Array<{ channel: string; result: unknown }> = [];
const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Unregistered test channel: ${channel}`);
  const result = await handler({ senderFrame }, ...args);
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

beforeEach(() => {
  handlers.clear();
  listeners.clear();
  replies.length = 0;
  invoke.mockClear();
  senderFrame = { url: "file:///index.html" };
  previousAveHome = process.env.AVE_HOME;
  scratchHome = mkdtempSync(join(tmpdir(), "ave-child-transcript-"));
  process.env.AVE_HOME = scratchHome;
});

afterEach(async () => {
  if (previousAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = previousAveHome;
  await cleanupTmpDir(scratchHome);
});

async function setup() {
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
  // These reads require only the real isolated store; no child turn or provider
  // execution is needed to exercise the runner's persisted transcript methods.
  const runner = new SubAgentRunner({ subAgentMemoryManager: childStore } as ConstructorParameters<typeof SubAgentRunner>[0]);
  const read = vi.spyOn(runner, "getPersistedTranscript");
  const primaryLoop = parentLoop(primarySessionId);
  const tileLoop = parentLoop(tileSessionId);
  const sideLoop = parentLoop(sideSessionId);
  const deps = {
    conversationLoop: primaryLoop,
    sideChatConversationLoop: sideLoop,
    memoryManager: mainStore,
    resolveChatGroupLoop: (group: string) => {
      if (group !== TILE_GROUP) throw new Error("Unknown test chat group");
      return tileLoop;
    },
    releaseChatGroupLoop: vi.fn(),
    getSubAgentRunner: () => runner,
    settingsService: { get: (key: string) => key === "llm" ? fakeLlmSettings() : {} },
    auditLogger: { log: vi.fn() },
    getMainWindow: () => null,
  } as unknown as IpcDeps;
  registerChatHandlers(deps);
  registerSideChatHandlers(deps);
  const publicApi = buildPublicSurface();
  const internalApi = buildInternalApiSurface();
  const { api: fixtureApi } = makeMockAveApi({ sideChat: true });
  const api: AveApi = {
    ...(fixtureApi as unknown as AveApi),
    ...publicApi.chatGroup(TILE_GROUP),
    sideChat: internalApi.sideChat,
    onAgentSpawnEvent: internalApi.onAgentSpawnEvent,
  };
  return { api, deps, runner, read, sideLoop, tileLoop };
}

function Panel({ api, spawns = [] }: { api: AveApi; spawns?: SubAgentSpawn[] }) {
  const workspaceTabs = useWorkspaceTabs();
  return (
    <TooltipProvider>
      <ApprovalSurfaceProvider value={approvalSurfaceStub()}>
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
          sideChatOpenRequest={{ chatGroupId: TILE_GROUP, sessionId: sideSessionId, nonce: 1 }}
        />
      </ApprovalSurfaceProvider>
    </TooltipProvider>
  );
}

function openSubagentTab() {
  const trigger = screen.getByTestId("chat-side-panel-add-tab");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
  fireEvent.click(screen.getByTestId("chat-side-panel-launcher-menu-subagent"));
}

describe("side-chat child transcript across host and renderer", () => {
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
