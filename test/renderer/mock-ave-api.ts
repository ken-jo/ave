import type { TurnReviewResult } from "../../src/shared/turn-change-review.js";
/** Mockable AveApi surface for renderer tests. Every method is a `vi.fn()` so tests can spy on calls,
 * and the default return values are sensible empty/pass values so <App /> can mount without crashing. */
import { vi, type Mock } from "vitest";
import type { RewindMode, RewindResult } from "../../src/shared/code-rewind.js";
import { MAIN_CHAT_GROUP_ID } from "../../src/contract/app-contract.js";
import { fakeLlmSettings } from "../../src/shared/__tests__/fake-llm-settings.js";
import { resolveActiveChatModel, type ActiveChatModelSettings } from "../../src/shared/active-chat-model.js";
import { canUseLlmVendorWithoutApiKey, getLlmVendorSettings } from "../../src/shared/llm-vendor-defaults.js";
import type { ChatEntry, ChatStreamEvent } from "../../src/lib/chat-stream-state.js";
import type { AgentSpawnEvent as SharedAgentSpawnEvent } from "../../src/shared/subagent-events.js";
import type { AppBootstrapStatus } from "../../src/shared/bootstrap-status.js";
import type { ModelCatalogIpcResult } from "../../src/shared/model-catalog/types.js";
import type { SubscriptionRuntimeStatusUpdatedEvent } from "../../src/shared/subscription-runtime.js";
import type { SubAgentTranscriptRequest, SubAgentTranscriptResult } from "../../src/shared/subagent-transcript.js";
import type { SessionSummary } from "../../src/ui/renderer/hooks/use-sessions.js";
import type { SessionFamily, SessionListKindFilter } from "../../src/shared/session-lookup.js";
import { terminalSessionFixture } from "../../src/__tests__/support/terminal-session-fixtures.js";
import { browserControlFixture } from "../../src/__tests__/support/browser-control-fixture.js";
import type { TerminalDataEvent, TerminalRef, TerminalSessionRef } from "../../src/shared/terminal-session.js";
import type { BrowserTabControlState, SessionTabBindingsState } from "../../src/shared/browser-surface.js";

export type MockAveApi = Record<string, Mock>;

/** A seeded conversation row: the REAL {@link SessionSummary} with everything the mock can derive made optional. Re-declaring the row here let a fixture describe a shape production never
 * produces; the copy was missing `projectRoot`, `projectName`, `archivedAt`, `unreadSince` and `branchedFromCompactNum`, so a test could not seed the fields the sidebar groups and badges by. */
export type SessionSeed = Partial<SessionSummary> & Pick<SessionSummary, "id" | "modifiedAt">;

/** One conversation row with the defaults main would have stamped. The suites that render lists (sidebar, starred, insights) each wrote the same literal out per row; this is that literal, once. `family`
 * follows from the other fields when a fixture does not name one, so a test written before families still describes the row it meant. The session the mock side-chat channel opens on `new` and `load`. */
export const MOCK_SIDE_CHAT_SESSION_ID = "side-chat-1";

export function sessionRow(seed: SessionSeed): SessionSummary {
  const sessionKind = seed.sessionKind ?? "main";
  return {
    ...seed,
    id: seed.id,
    modifiedAt: seed.modifiedAt,
    title: seed.title ?? `세션 ${seed.id.slice(0, 8)}`,
    sessionKind,
    family: seed.family
      ?? (seed.workBoardItemId !== undefined
        ? "work-board"
        : sessionKind === "routine" ? "routine" : "main"),
  };
}

/** Persisted default of `permissions.reviewer.parentAdjudication`. The Permissions tab renders the
 * block unconditionally, so every mock of `reviewerDispatch("show")` has to carry it; main always does. */
export const MOCK_REVIEWER_PARENT_ADJUDICATION = {
  maxVerdict: "medium",
  timeoutMs: 30_000,
  maxPerChildRun: 200,
  includeParentContextTurns: 0,
  backgroundEscalation: "deferred",
  model: "reviewer",
} as const;

/** `PERMISSIONS.judgeGet` for a home with no `permissions.judge` block (judge off, reviewer model unset) unless overridden. The
 * Permissions tab renders the judge section unconditionally, so a tab mock without it shows a read-failure status the real host never does. */
export function mockJudgeGet(overrides: {
  model?: { vendor: string; model: string } | null;
  modelOptions?: Array<{ vendor: string; model: string }>;
  chatModel?: string | null;
  reviewerModelUnavailable?: boolean;
} = {}) {
  return vi.fn(async () => ({
    ok: true as const,
    settings: {
      model: overrides.model ?? null,
      chain: [],
      mode: "shadow" as const,
      categories: { shell: true, write: true, network: false },
      timeoutMs: 15_000,
      chainDeadlineMs: 60_000,
      breaker: { consecutive: 3, total: 20 },
    },
    issues: [],
    modelOptions: overrides.modelOptions ?? [],
    chatModel: overrides.chatModel ?? null,
    reviewerModelUnavailable: overrides.reviewerModelUnavailable ?? false,
    storedChainRejected: false,
  }));
}

type HistoryMock = {
  sessionId?: string;
  sessionTitle?: string;
  sessionKind?: "main" | "routine";
  projectRoot?: string;
  projectName?: string;
  restoredSubAgents?: unknown[];
  messages: unknown[];
};

/** Give seeded history rows the identity main always serializes. Every row main hands the renderer has been through `ConversationHistory`, which stamps `messageId`; so a fixture without one is not a smaller version of production, it is a
 * shape production never produces, and the actions that address a row by id would be unreachable in every test that uses it. Ids are derived from the row's position here only because a fixture is static; the app never derives them that way. */
function withSeededMessageIds(messages: unknown[]): unknown[] {
  return messages.map((message, index) =>
    message !== null && typeof message === "object" && !("messageId" in message)
      ? { ...(message as Record<string, unknown>), messageId: `seed-msg-${index}` }
      : message,
  );
}

type AgentSpawnEvent = SharedAgentSpawnEvent<ChatEntry>;

type ApiOverrides = {
  /** Give the double a terminal surface (`api.terminal`). Off by default: most suites never open a terminal,
   * and the app treats an absent surface as "no terminal here". A suite that turns it on also mocks xterm. */
  terminal?: boolean;
  /** Give the double the agent browser surface (`api.browserTabs`) and the active-surface report
   * (`api.setActiveSurface`). A test drives main's side with `emitBrowserTabOp` / `emitBrowserControl` below. */
  browserTabs?: boolean;
  settings?: unknown;
  /** Override the settings RPC itself when a renderer test needs to control its timing. */
  getSettings?: () => Promise<unknown>;
  /** Settings paths the environment is forcing on (see env-backed-settings). */
  envForcedSettings?: readonly string[];
  /** The `ave:llm:get-model-catalog` answer; refused as unavailable unless a test supplies one. */
  modelCatalog?: ModelCatalogIpcResult;
  /** Hosts the telemetry endpoint may point at (see main/telemetry). */
  telemetryAllowedHosts?: readonly string[];
  personaPrompts?: unknown[];
  sessions?: readonly SessionSeed[];
  currentSession?: string;
  starred?: unknown[];
  history?: ({ sessionId: string } & HistoryMock) | Promise<{ sessionId: string } & HistoryMock>;
  historyBySession?: Record<string, HistoryMock | Promise<HistoryMock>>;
  hasApiKey?: boolean;
  turnReview?: TurnReviewResult | ((sessionId: string) => TurnReviewResult);
  subscriptionRuntimeStatus?: unknown;
  hasProvider?: boolean;
  usage?: unknown;
  appInfo?: unknown;
  /** What `gitMarketplace.listSources` answers (the workspace stats read it). */
  marketplaceSources?: unknown[];
  agentProfiles?: unknown;
  skills?: unknown;
  pluginCards?: unknown[];
  pluginUiExtensions?: unknown[];
  /** Give the app a side-chat channel. Off by default because the panel offers the side-chat tab only when the host has one, and most suites want the launcher as it is without it. */
  sideChat?: boolean;
  latestRoutineResult?: unknown;
  pendingRoutineResults?: unknown[];
  routineSessionsByRoutine?: Record<string, unknown[]>;
  memoryIndex?: string;
  mainActiveState?: {
    mainActiveSessionId: string | null;
    mainActiveMode: "resume" | "fresh";
    updatedAt: string;
  } | null;
};

/** The settings a mock app boots with. Exported so a test that needs to vary ONE field can start from a
 * complete, bootable object instead of a partial one; App reads `llm.provider` during mount and throws on a bare stub. */
export const MOCK_DEFAULT_SETTINGS = {
  llm: fakeLlmSettings({ provider: "openai", model: "gpt-4o-mini" }),
  chat: { systemPrompt: "", autoCompact: true },
  webSearch: { provider: "none" },
  marketplace: {
    installedProviderIds: [],
    installedThemeBundleIds: [],
    installedLanguagePacks: [],
  },
  routine: {},
  homeDocs: { keepLatest: false },
  privacy: { piiRedactEnabled: false },
  // Global shortcuts are off with no accelerator chosen; the persisted default in `settings-defaults.ts`.
  shortcuts: { toggleWindow: null, enabled: false },
  // Z onboarding chain; mark the seed user as already past onboarding so the first-boot probe dispatches `probe-skip` and the chain advances straight to
  // `done`. Without this, the chain stays at the new default initial stage ("showcase") and masks the ChatView empty-state branch that several tests rely on.
  features: { idlePreferenceRefresh: false, onboardingCompleted: true },
};

/** The session id the mock hands the main tile when a test names none. */
export const MOCK_DEFAULT_SESSION_ID = "sess-default";

const DEFAULT_USAGE = {
  today: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
  thisWeek: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
  thisMonth: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 },
  perVendor: [],
  perModel: [],
  trend: [],
  topConversations: [],
  generatedAt: new Date().toISOString(),
};

/** The app identity a mock app boots with; exported so a test asserting the version on screen reads the same value the mock serves. */
export const DEFAULT_APP_INFO = {
  version: "0.0.0-test",
  electronVersion: "0.0.0",
  nodeVersion: "0.0.0",
  chromeVersion: "0.0.0",
  v8Version: "0.0.0",
  platform: "test",
  arch: "x64",
  userDataPath: "/tmp/ave-test-user-data",
};

/** The terminal surface: every shell spawns, and output reaches the app through the `onData` listeners the app registered; a test drives them with `emitTerminalData` below. */
function makeTerminalDouble() {
  const dataListeners = new Set<(payload: TerminalDataEvent) => void>();
  return {
    spawn: vi.fn(async ({ tabId, lane }: TerminalRef) => ({ ok: true, tabId, replayed: false, session: terminalSessionFixture(tabId, lane) })),
    input: vi.fn(async () => ({ ok: true })),
    resize: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(async () => ({ ok: true })),
    onData: vi.fn((listener: (payload: TerminalDataEvent) => void) => {
      dataListeners.add(listener);
      return () => { dataListeners.delete(listener); };
    }),
    onExit: vi.fn(() => () => {}),
    listBlocks: vi.fn(async (ref: TerminalSessionRef) => ({ ok: true, session: terminalSessionFixture(ref.tabId, ref.lane, ref.terminalSessionId), blocks: [], integrated: false })),
    getBlock: vi.fn(async () => ({ ok: false, error: "no-block" })),
    /** Not part of the surface: what the main process's PTY output would do. */
    emitTerminalData: (tabId: string, chunk: string) => {
      for (const listener of [...dataListeners]) listener({ ...terminalSessionFixture(tabId, "manual"), chunk });
    },
  };
}

/** The agent browser surface: main's tab operations and control state reach the app through these. */
function makeBrowserTabsDouble() {
  const opListeners = new Set<(request: unknown) => void>();
  const controlListeners = new Set<(state: BrowserTabControlState) => void>();
  const bindingListeners = new Set<(state: SessionTabBindingsState) => void>();
  let state: BrowserTabControlState = { revision: 0, tabs: [] };
  let bindingState: SessionTabBindingsState = { revision: 0, bindings: [] };
  return {
    bindTab: vi.fn(async () => ({ ok: true as const })),
    stop: vi.fn(async () => ({ ok: true as const })),
    pause: vi.fn(async () => ({ ok: true as const })),
    resume: vi.fn(async () => ({ ok: true as const })),
    pausePopup: vi.fn(async () => ({ ok: true as const })),
    resumePopup: vi.fn(async () => ({ ok: true as const })),
    getState: vi.fn(async () => state),
    getSessionBindings: vi.fn(async () => bindingState),
    onSessionBindingsChanged: vi.fn((listener: (state: SessionTabBindingsState) => void) => {
      bindingListeners.add(listener);
      return () => { bindingListeners.delete(listener); };
    }),
    onTabOp: vi.fn((listener: (request: unknown) => void) => {
      opListeners.add(listener);
      return () => { opListeners.delete(listener); };
    }),
    onControl: vi.fn((listener: (state: BrowserTabControlState) => void) => {
      controlListeners.add(listener);
      return () => { controlListeners.delete(listener); };
    }),
    /** Not part of the surface: an `ave:browser:tab-op` from main. */
    emitBrowserTabOp: (request: unknown) => {
      for (const listener of [...opListeners]) listener(request);
    },
    /** Not part of the surface: an `ave:browser:control` from main. */
    emitBrowserControl: (agentControlledTabIds: string[]) => {
      state = browserControlFixture(agentControlledTabIds, "agent-active", state.revision + 1);
      for (const listener of [...controlListeners]) listener(state);
    },
    emitSessionBindingsChanged: (bindings: SessionTabBindingsState["bindings"]) => {
      bindingState = { revision: bindingState.revision + 1, bindings };
      for (const listener of [...bindingListeners]) listener(bindingState);
    },
  };
}

export function makeMockAveApi(overrides: ApiOverrides = {}): {
  api: MockAveApi;
  /** Which groups' loops were released; one spy per group, see the body. */
  releasedGroupIds: () => string[];
  emitChatStream: (ev: ChatStreamEvent) => void;
  /** `ave:chat:fallback` addressed to one tile, as preload's per-group filter delivers it. */
  emitChatFallback: (chatGroupId: string, payload: { from: string; to: string }) => void;
  emitAgentSpawnEvent: (event: AgentSpawnEvent) => void;
  /** `ave:skill-load:event`; window-wide, stamped with the turn's session. */
  emitSkillLoaded: (event: { name: string; description: string; sessionId: string }) => void;
  /** `onSessionTasksChanged` push; the assistant's checklist for one session. */
  emitSessionTasksChanged: (payload: { sessionId: string; items: unknown[] }) => void;
  /** `onSessionGoalChanged` push; the goal one session is working towards, or its absence. */
  emitSessionGoalChanged: (payload: { sessionId: string; goal: unknown }) => void;
  emitOverlayShow: (item: unknown) => void;
  emitOverlayDismiss: (id: string) => void;
  emitRoutineFired: (r: unknown) => void;
  /** The spinner a routine shows while it runs, before its result replaces it. */
  emitRoutineRunningStarted: (p: unknown) => void;
  emitPluginEvent: (eventType: string, payload: unknown) => void;
  emitWorkBoardItemChanged: (p: unknown) => void;
  /** `settingsTab` mirrors the main process's `ave:view:activate` payload for settings opens. */
  emitViewActivate: (v: string, settingsTab?: string) => void;
  emitAskUserQuestion: (r: unknown) => void;
  emitTourStart: (scenarioId: string) => void;
  emitBootstrapStatus: (status: AppBootstrapStatus) => void;
  emitPluginInstallProgress: (payload: unknown) => void;
  emitPluginInstallResult: (payload: unknown) => void;
  emitPluginRuntimeUpdated: (payload: { pluginId: string }) => void;
  emitNotificationToast: (payload: unknown) => void;
  emitNotificationClicked: (payload: unknown) => void;
  emitSubscriptionRuntimeStatusUpdated: (event: SubscriptionRuntimeStatusUpdatedEvent) => void;
} {
  // Main's pane chats: each pane tab's conversation, as `paneHistory` reads it back.
  const paneChats = new Map<string, { sessionId: string; messages: Array<{ index: number; role: "user"; content: string }> }>();
  let mintedPaneChats = 0;
  let paneChatStreams = 1000;
  const sideStreamHandlers = new Set<(event: ChatStreamEvent) => void>();
  let settings = overrides.settings ?? MOCK_DEFAULT_SETTINGS;
  let personaPrompts = overrides.personaPrompts ?? [];
  const sessions = (overrides.sessions ?? []).map(sessionRow);
  const currentSession = overrides.currentSession ?? MOCK_DEFAULT_SESSION_ID;
  let sentTurnCount = 0;
  const starred = overrides.starred ?? [];
  const history = overrides.history ?? { sessionId: currentSession, messages: [] };
  const historyBySession = overrides.historyBySession ?? {};
  const hasApiKey = overrides.hasApiKey ?? true;
  // Main derives `activeChatModel` onto every snapshot it sends
  // (`rendererSettingsSnapshot`); the mock does the same from its own key answer, unless a test hands one in explicitly.
  const projectSnapshot = (value: unknown): unknown => {
    const record = value as { llm?: Partial<ActiveChatModelSettings>; activeChatModel?: unknown };
    if (record.activeChatModel !== undefined) return record;
    // Many fixtures hand-write a partial `llm`; main's store would have normalized it, so fill what normalization fills before deriving.
    const llm = {
      ...MOCK_DEFAULT_SETTINGS.llm,
      ...record.llm,
      activeChatRuntime: record.llm?.activeChatRuntime ?? { kind: "api" as const },
    } as ActiveChatModelSettings;
    // Main's rule (`activeApiRouteConnected`): a stored key, or a route that runs without one.
    const connected = hasApiKey
      || canUseLlmVendorWithoutApiKey(llm.provider, getLlmVendorSettings(llm.vendors, llm.provider));
    return { ...record, activeChatModel: resolveActiveChatModel(llm, connected) };
  };
  const chatGroupApis = new Map<string, {
    chatGetHistory: ReturnType<typeof vi.fn>;
    chatGroupRelease: ReturnType<typeof vi.fn>;
    onChatFallback: ReturnType<typeof vi.fn>;
  }>();
  // The provider-fallback frame is labelled with its chat group in preload and filtered per tile; the
  // mock keeps one handler set per group so a test can address the frame to ONE tile, as main does.
  const chatFallbackHandlers = new Map<string, Set<(payload: { from: string; to: string }) => void>>();
  const subscribeChatFallback = (chatGroupId: string) =>
    vi.fn((handler: (payload: { from: string; to: string }) => void) => {
      const handlers = chatFallbackHandlers.get(chatGroupId) ?? new Set();
      chatFallbackHandlers.set(chatGroupId, handlers);
      handlers.add(handler);
      return () => handlers.delete(handler);
    });
  // The primary group is not reached through `chatGroup()`; `chatGroupApi` hands it the window api itself; so its release is the top-level member, exactly as in `AveApi`.
  const chatGroupRelease = vi.fn(async () => ({ ok: true, released: true }));
  const subscriptionRuntimeStatus = overrides.subscriptionRuntimeStatus ?? {
    ok: false,
    error: { code: "subscription-runtime-not-configured", message: "not configured" },
  };
  const hasProvider = overrides.hasProvider ?? true;
  const usage = overrides.usage ?? DEFAULT_USAGE;
  const appInfo = overrides.appInfo ?? DEFAULT_APP_INFO;
  const marketplaceSources = overrides.marketplaceSources ?? [{ id: "ave", enabled: true, status: { state: "up-to-date" } }];
  const agentProfiles = overrides.agentProfiles ?? { agents: [] };
  const skills = overrides.skills ?? { skills: [] };
  const pluginCards = overrides.pluginCards ?? [];
  const pluginUiExtensions = overrides.pluginUiExtensions ?? [];
  const latestRoutineResult = overrides.latestRoutineResult ?? null;
  const pendingRoutineResults = overrides.pendingRoutineResults ?? [];
  const routineSessionsByRoutine = overrides.routineSessionsByRoutine ?? {};
  const memoryIndex = overrides.memoryIndex ?? "";
  const mainActiveState = overrides.mainActiveState ?? {
    mainActiveSessionId: null,
    mainActiveMode: "fresh" as const,
    updatedAt: new Date().toISOString(),
  };

  const chatStreamHandlers = new Set<(ev: ChatStreamEvent) => void>();
  const agentSpawnEventHandlers = new Set<(event: AgentSpawnEvent) => void>();
  const skillLoadedHandlers = new Set<
    (event: { name: string; description: string; sessionId: string }) => void
  >();
  const overlayShowHandlers = new Set<(item: unknown) => void>();
  const overlayDismissHandlers = new Set<(id: string) => void>();
  const routineFiredHandlers = new Set<(r: unknown) => void>();
  const routineRunningHandlers = new Set<(p: unknown) => void>();
  const pluginEventHandlers = new Map<string, Set<(p: unknown) => void>>();
  const workBoardItemChangedHandlers = new Set<(p: unknown) => void>();
  const viewHandlers = new Set<(v: string, settingsTab?: string) => void>();
  const settingsUpdatedHandlers = new Set<(settings: unknown) => void>();
  const subscriptionRuntimeStatusUpdatedHandlers = new Set<(event: SubscriptionRuntimeStatusUpdatedEvent) => void>();
  const personaPromptsUpdatedHandlers = new Set<() => void>();
  const askUserQuestionHandlers = new Set<(r: unknown) => void>();
  const tourStartHandlers = new Set<(payload: { scenarioId: string }) => void>();
  const bootstrapStatusHandlers = new Set<(status: AppBootstrapStatus) => void>();
  const pluginInstallProgressHandlers = new Set<(payload: unknown) => void>();
  const pluginInstallResultHandlers = new Set<(payload: unknown) => void>();
  const pluginRuntimeUpdatedHandlers = new Set<(payload: { pluginId: string }) => void>();
  const notificationToastHandlers = new Set<(payload: unknown) => void>();
  const notificationClickedHandlers = new Set<(payload: unknown) => void>();
  const sessionTasksHandlers = new Set<(payload: unknown) => void>();
  const sessionGoalHandlers = new Set<(payload: unknown) => void>();

  const api: MockAveApi = {
    ...(overrides.terminal ? { terminal: makeTerminalDouble() } : {}),
    ...(overrides.browserTabs
      ? { browserTabs: makeBrowserTabsDouble(), setActiveSurface: vi.fn(async () => ({ ok: true as const })) }
      : {}),
    notifyPluginTheme: vi.fn(async () => ({ ok: true })),
    remoteA2a: {
      targets: vi.fn(async () => ({ ok: false, error: "a2a-remote-disabled" })),
      status: vi.fn(async () => ({ ok: false, error: "a2a-remote-disabled" })),
      send: vi.fn(async () => ({ ok: false, error: "a2a-remote-disabled" })),
      task: vi.fn(async () => ({ ok: false, error: "a2a-remote-disabled" })),
      action: vi.fn(async () => ({ ok: false, error: "a2a-remote-disabled" })),
    },
    tour: {
      getState: vi.fn(async () => ({
        ok: true,
        state: {
          lastSeenScenario: null,
          completedScenarios: [],
          dismissedAt: null,
        },
      })),
      markComplete: vi.fn(async () => ({ ok: true })),
      dismiss: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async (scenarioId: string) => ({ ok: true, scenarioId })),
      onStart: vi.fn((handler: (payload: { scenarioId: string }) => void) => {
        tourStartHandlers.add(handler);
        return () => tourStartHandlers.delete(handler);
      }),
    },
    // No plugin declares onboarding in the default fixture, so the host has nothing to propose and stages no card. The cast is the price of `MockAveApi` being `Record<string, Mock>`: a namespaced surface is not a `Mock`, so
    // the literal fails the index signature. Five surfaces above and below carry that error untyped rather than cast; widening the type is a change every consumer of `api.<fn>` would feel, and it is not this one's to make.
    onboarding: {
      listPending: vi.fn(async () => ({ ok: true, pending: [] })),
      answer: vi.fn(async () => ({ ok: true, pending: [] })),
    } as unknown as Mock,
    getSettings: vi.fn(overrides.getSettings ?? (async () => projectSnapshot(settings))),
    updateSettings: vi.fn(async (p: unknown) => {
      settings = { ...(settings as object), ...(p as object) };
      const snapshot = projectSnapshot(settings);
      settingsUpdatedHandlers.forEach((handler) => handler(snapshot));
      return snapshot;
    }),
    // Nothing is env-forced by default: a test that cares about the forced notice says so explicitly,
    // and every other test gets the ordinary case rather than a rejected promise from a missing method.
    envForcedSettings: vi.fn(async () => overrides.envForcedSettings ?? []),
    getModelCatalog: vi.fn(async (): Promise<ModelCatalogIpcResult> => overrides.modelCatalog ?? { ok: false, error: "catalog-unavailable" }),
    telemetryAllowedHosts: vi.fn(async () => overrides.telemetryAllowedHosts ?? ["localhost"]),
    onSettingsUpdated: vi.fn((handler: (settings: unknown) => void) => {
      settingsUpdatedHandlers.add(handler);
      return () => settingsUpdatedHandlers.delete(handler);
    }),
    onSubscriptionRuntimeStatusUpdated: vi.fn((handler: (event: SubscriptionRuntimeStatusUpdatedEvent) => void) => {
      subscriptionRuntimeStatusUpdatedHandlers.add(handler);
      return () => subscriptionRuntimeStatusUpdatedHandlers.delete(handler);
    }),
    listPersonaPromptSummaries: vi.fn(async () => ({
      prompts: personaPrompts.map((item) => ({
        id: (item as { id?: string }).id ?? "",
        name: (item as { name?: string }).name ?? "",
      })),
    })),
    listPersonaPrompts: vi.fn(async () => ({ prompts: personaPrompts })),
    savePersonaPrompt: vi.fn(async (prompt: { id: string; name: string; systemPromptAdd: string }) => {
      personaPrompts = [
        ...personaPrompts.filter((item) => (item as { id?: unknown }).id !== prompt.id),
        prompt,
      ];
      personaPromptsUpdatedHandlers.forEach((handler) => handler());
      return { ok: true, prompt };
    }),
    deletePersonaPrompt: vi.fn(async (id: string) => {
      const before = personaPrompts.length;
      personaPrompts = personaPrompts.filter((item) => (item as { id?: unknown }).id !== id);
      personaPromptsUpdatedHandlers.forEach((handler) => handler());
      return { ok: true, deleted: personaPrompts.length !== before };
    }),
    onPersonaPromptsUpdated: vi.fn((handler: () => void) => {
      personaPromptsUpdatedHandlers.add(handler);
      return () => personaPromptsUpdatedHandlers.delete(handler);
    }),
    setApiKey: vi.fn(async () => ({ ok: true })),
    hasApiKey: vi.fn(async () => hasApiKey),
    subscriptionRuntimeStatus: vi.fn(async () => subscriptionRuntimeStatus),
    deleteApiKey: vi.fn(async () => ({ ok: true })),
    listLlmModels: vi.fn(async () => ({
      ok: false,
      error: "model-list-not-supported",
    })),
    installMarketplaceProviderPreset: vi.fn(async () => settings),
    uninstallMarketplaceProviderPreset: vi.fn(async () => settings),
    setWebApiKey: vi.fn(async () => ({ ok: true })),
    hasWebApiKey: vi.fn(async () => false),
    deleteWebApiKey: vi.fn(async () => ({ ok: true })),
    previewClaudeDesktopMcpImport: vi.fn(async () => ({ entries: [], errors: [] })),
    applyClaudeDesktopMcpImport: vi.fn(async () => ({ ok: true, results: [], parseErrors: [] })),
    permission: {
      getMode: vi.fn(async () => ({ mode: "default" })),
      setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
      onModeChanged: vi.fn(() => () => undefined),
      listRules: vi.fn(async () => []),
      listScopedRules: vi.fn(async () => ({ rules: [], errors: [] })),
      removeScopedRule: vi.fn(async () => ({ ok: true })),
      addRule: vi.fn(async () => ({ ok: true })),
      removeRule: vi.fn(async () => ({ ok: true })),
      deferredList: vi.fn(async () => ({ ok: true, pending: [], total: 0 })),
      deferredResolve: vi.fn(async () => ({ ok: true })),
      onDeferredPending: vi.fn(() => () => undefined),
      hookTrustList: vi.fn(async () => ({ ok: true, active: [], disabled: [], totalDisabled: 0 })),
      dirDispatch: vi.fn(async () => ({ ok: true, verb: "list", defaults: [], userAdditions: [], effective: [] })),
      judgeGet: mockJudgeGet(),
      reviewerDispatch: vi.fn(async () => ({
        ok: true,
        verb: "show",
        settings: {
          mode: "disabled",
          fallbackOnError: "deny",
          parentAdjudication: MOCK_REVIEWER_PARENT_ADJUDICATION,
        },
      })),
      auditShow: vi.fn(async () => ({ ok: true, entries: [], total: 0, summary: { files: 0, bytes: 0 } })),
      auditVerify: vi.fn(async () => ({ ok: true, intact: true, totalFiles: 0, totalEntries: 0, perDay: [] })),
      onManifestViolation: vi.fn(() => () => undefined),
      onUserApprovalHit: vi.fn(() => () => undefined),
      onReviewSuggestion: vi.fn(() => () => undefined),
    },
    policy: {
      get: vi.fn(async () => ({
        version: 1,
        requireExplicitApproval: false,
        managed: false,
        updatedAt: new Date().toISOString(),
        source: "defaults",
      })),
      set: vi.fn(async () => ({ ok: true })),
    },

    chatHasProvider: vi.fn(async () => hasProvider),
    // A tile binds its own view of the window api through `chatGroupApi`, so a window with more than one tile needs this to exist at all; without it a split throws
    // `chat-group-unavailable`. Each non-primary group answers with its OWN conversation id, which is what lets a test tell two tiles apart; everything else is deliberately the window's shared mock.
    chatGroup: vi.fn((chatGroupId: string) => {
      // Memoized per group, so a spy a test reads is the same one production called. A fresh object per call would hand every assertion a spy nothing had touched, and "was a loop released?" could not be
      // asked. The spy is per GROUP, not shared: the interesting question at the conversation ceiling is not whether something was released but WHICH group was; a shared spy answers the first and hides the second.
      const existing = chatGroupApis.get(chatGroupId);
      if (existing) return existing;
      const made = {
        chatGetHistory: vi.fn(async () => ({ ...(await history), sessionId: `session-${chatGroupId}` })),
        chatGroupRelease: vi.fn(async () => ({ ok: true, released: true })),
        onChatFallback: subscribeChatFallback(chatGroupId),
      };
      chatGroupApis.set(chatGroupId, made);
      return made;
    }),
    chatGroupRelease,
    captureUserKeyboardIntent: vi.fn(() => ({ inputOrigin: "user-keyboard", token: "mock-user-intent" })),
    // Mirrors `runStreamedTurn`: every accepted turn announces its input and the identity of the row the host appended for it, which is how the transcript's optimistic bubble
    // learns which row it stands for. Without this the bubble would never become addressable and every action that names a past message would be dead in tests but alive in the app.
    chatSend: vi.fn(async (payload?: unknown) => {
      const text = typeof payload === "string"
        ? payload
        : (payload as { input?: string } | undefined)?.input ?? "";
      sentTurnCount += 1;
      chatStreamHandlers.forEach((h) => h({
        type: "user_message",
        text,
        origin: "user-keyboard",
        messageId: `sent-msg-${sentTurnCount}`,
      } as ChatStreamEvent));
      return { ok: true };
    }),
    chatGuide: vi.fn(async () => ({ ok: true })),
    chatNew: vi.fn(async () => ({ ok: true })),
    chatSessions: vi.fn(async (opts?: { kind?: SessionListKindFilter; families?: SessionFamily[]; routineId?: string; limit?: number; before?: string; beforeId?: string; after?: string }) => {
      const beforeTime = opts?.before ? Date.parse(opts.before) : Number.NaN;
      const afterTime = opts?.after ? Date.parse(opts.after) : Number.NaN;
      const filtered = sessions.filter((session) => {
        // Mirrors the handler: a `families` request selects by family and ignores `kind`; without one, `kind` governs the main store alone.
        const family = session.family;
        if (opts?.families) {
          if (!opts.families.includes(family)) return false;
        } else {
          const kind = opts?.kind ?? "main";
          if (kind !== "all" && session.sessionKind !== kind) return false;
        }
        if (opts?.routineId && session.routineId !== opts.routineId) return false;
        const t = Date.parse(session.modifiedAt);
        if (!Number.isNaN(afterTime) && t < afterTime) return false;
        if (Number.isNaN(beforeTime)) return true;
        if (t < beforeTime) return true;
        return t === beforeTime && opts?.beforeId !== undefined && session.id < opts.beforeId;
      });
      return {
        current: currentSession,
        sessions: filtered.slice(0, opts?.limit ?? 20),
      };
    }),
    chatSessionResume: vi.fn(async (id: string) => ({ ok: true, compacted: false, compactedAt: null, removedMessageCount: 0 })),
    // Reached whenever a tile that is NOT focused takes stream activity; the window marks that conversation unread. A window with two tiles hits it in the ordinary course of a test.
    chatSessionUpdate: vi.fn(async () => ({ ok: true as const })),
    chatGetTurnReview: vi.fn(async (sessionId: string): Promise<TurnReviewResult> => typeof overrides.turnReview === "function"
      ? overrides.turnReview(sessionId) : overrides.turnReview ?? { ok: false, error: "turn-review-unavailable" }),
    chatCompact: vi.fn(async () => ({ compacted: false, compactedAt: null, summary: "불필요", removedMessageCount: 0 })),
    chatMainActiveState: vi.fn(async () => mainActiveState),
    chatGetHistory: vi.fn(async () => {
      const resolved = await history;
      return { ...resolved, messages: withSeededMessageIds(resolved.messages) };
    }),
    chatSessionHistory: vi.fn(async (sessionId: string) => {
      const resolved = await (historyBySession[sessionId] ?? history);
      return {
        ok: true,
        sessionKind: resolved.sessionKind ?? "main",
        sessionTitle: resolved.sessionTitle,
        projectRoot: resolved.projectRoot,
        projectName: resolved.projectName,
        restoredSubAgents: resolved.restoredSubAgents,
        messages: withSeededMessageIds(resolved.messages),
      };
    }),
    chatEditResend: vi.fn(async () => ({ ok: true })),
    // Main hands back the input to restore, resolved from the row it cut, so the double resolves it from the
    // seeded history the same way rather than returning an empty string the composer would silently accept.
    chatRewindTo: vi.fn(async (messageId: string, mode?: RewindMode): Promise<RewindResult> => {
      if (mode === "code") return { ok: true, text: "" };
      const resolved = await history;
      const row = withSeededMessageIds(resolved.messages).find(
        (m): m is Record<string, unknown> =>
          m !== null && typeof m === "object" && (m as Record<string, unknown>).messageId === messageId,
      );
      return {
        ok: true as const,
        text: typeof row?.content === "string" ? row.content : "",
      };
    }),
    chatFork: vi.fn(async () => ({ ok: true, sessionId: currentSession })),
    // Shapes match actual preload/IPC return types exactly; discriminated union: success paths have no `ok` field (enter → { messageIndexAtCreation },
    // branch → { newSessionId, ...branchState }); error paths return { error: string }. IPC may also return UNAUTHORIZED_FRAME { ok: false, error }.
    chatEnterCheckpointView: vi.fn(async (_sessionId: string, _compactNum: number) => ({ messageIndexAtCreation: 5 })),
    chatExitCheckpointView: vi.fn(async () => ({ ok: true })),
    chatBranchFromCheckpoint: vi.fn(async (_sessionId: string, _compactNum: number) => ({
      newSessionId: "sess-branch-1",
      lastMessageRole: "assistant",
      shouldAutoContinue: false,
    })),
    chatContinueLastUser: vi.fn(async (_sessionId: string) => ({ ok: true })),
    chatRetryEffort: vi.fn(async () => ({ ok: true })),
    chatExport: vi.fn(async () => ({ ok: true, filePath: "/tmp/out.md" })),
    listSessionTasks: vi.fn(async () => []),
    clearSessionTasks: vi.fn(async () => ({ ok: true })),
    onSessionTasksChanged: vi.fn((handler: (payload: unknown) => void) => {
      sessionTasksHandlers.add(handler);
      return () => sessionTasksHandlers.delete(handler);
    }),
    getSessionGoal: vi.fn(async () => null),
    pauseSessionGoal: vi.fn(async () => ({ ok: true })),
    resumeSessionGoal: vi.fn(async () => ({ ok: true })),
    clearSessionGoal: vi.fn(async () => ({ ok: true })),
    onSessionGoalChanged: vi.fn((handler: (payload: unknown) => void) => {
      sessionGoalHandlers.add(handler);
      return () => sessionGoalHandlers.delete(handler);
    }),
    onChatStream: vi.fn((h: (ev: ChatStreamEvent) => void) => {
      chatStreamHandlers.add(h);
      return () => chatStreamHandlers.delete(h);
    }),
    onAgentSpawnEvent: vi.fn((handler: (event: AgentSpawnEvent) => void) => {
      agentSpawnEventHandlers.add(handler);
      return () => agentSpawnEventHandlers.delete(handler);
    }),
    onSkillLoaded: vi.fn((
      handler: (event: { name: string; description: string; sessionId: string }) => void,
    ) => {
      skillLoadedHandlers.add(handler);
      return () => skillLoadedHandlers.delete(handler);
    }),
    onChatFallback: subscribeChatFallback(MAIN_CHAT_GROUP_ID),
    onNotificationToast: vi.fn((handler: (payload: unknown) => void) => {
      notificationToastHandlers.add(handler);
      return () => notificationToastHandlers.delete(handler);
    }),
    onNotificationClicked: vi.fn((handler: (payload: unknown) => void) => {
      notificationClickedHandlers.add(handler);
      return () => notificationClickedHandlers.delete(handler);
    }),
    notifyClick: vi.fn(async () => ({ ok: true })),

    starredList: vi.fn(async () => starred),
    listStarred: vi.fn(async () => starred),
    addStarred: vi.fn(async (entry: unknown) => ({ ok: true, entry })),
    removeStarred: vi.fn(async () => ({ ok: true })),

    memoryListNotes: vi.fn(async () => []),
    memorySaveNote: vi.fn(async () => ({ ok: true })),
    memoryDeleteNote: vi.fn(async () => undefined),
    memorySearchNotes: vi.fn(async () => []),
    memoryListEntries: vi.fn(async () => []),
    memoryListCandidates: vi.fn(async () => []),
    memorySaveEntry: vi.fn(async () => ({ ok: true })),
    memoryDeleteEntry: vi.fn(async () => ({ ok: true })),
    memoryActivateCandidate: vi.fn(async () => ({ ok: true })),
    memoryDeleteCandidate: vi.fn(async () => ({ ok: true })),
    memorySearchEntries: vi.fn(async () => []),
    memoryGetIndex: vi.fn(async () => memoryIndex),
    memoryUpdateIndexIfUnchanged: vi.fn(async () => true),
    memoryUpdateIndexSections: vi.fn(async () => ({ ok: true })),
    memoryListSessions: vi.fn(async () => []),
    memorySearchSessions: vi.fn(async () => []),
    memoryGetAgentsMd: vi.fn(async () => "# Agents"),
    memoryUpdateAgentsMd: vi.fn(async () => undefined),
    memoryGetUserPrefs: vi.fn(async () => "# Preferences"),
    memoryUpdateUserPrefs: vi.fn(async () => undefined),
    memoryRefreshUserPrefs: vi.fn(async () => ({ ok: true, content: "# Refreshed Preferences" })),
    memoryRefreshLongTerm: vi.fn(async () => ({ ok: true, global: { status: "up-to-date", sourceCount: 0 } })),

    homeDocsStatus: vi.fn(async () => ({
      agentsDisplayPath: "~/.ave/AGENTS.md",
      customDisplayPath: "~/.ave/agents.custom.md",
      markers: [],
      mergedContent: null,
    })),
    homeDocsReadMarker: vi.fn(async () => ({ ok: true, content: "", live: "" })),
    homeDocsApplyPackaged: vi.fn(async () => ({ ok: true, movedToCustom: false })),
    homeDocsKeepMine: vi.fn(async () => ({ ok: true })),
    homeDocsGetCustom: vi.fn(async () => ""),
    homeDocsUpdateCustom: vi.fn(async () => ({ ok: true })),
    homeDocsMerge: vi.fn(async () => ({
      ok: true,
      content: "# Merged",
      mergedAt: "2026-09-03T00:00:00.000Z",
      sources: ["~/.ave/AGENTS.md"],
    })),
    homeDocsApplyMerged: vi.fn(async () => ({ ok: true })),
    homeDocsDiscardMerged: vi.fn(async () => ({ ok: true })),

    uninstallMarketplacePlugin: vi.fn(async () => ({ ok: true })),
    // A namespace, not a function: the map's `Mock` type does not describe it.
    gitMarketplace: mockGitMarketplace(marketplaceSources) as unknown as Mock,
    gitRuntime: {
      status: vi.fn(async () => ({ ok: false as const, error: "git-runtime-unavailable" as const })),
      install: vi.fn(async () => ({ ok: false as const, error: "git-runtime-unavailable" as const })),
      onProgress: vi.fn(() => () => {}),
    } as unknown as Mock,
    // Marketplace agent/skill surface. Settings/dashboard tests still read these counts even though the composer no longer injects them per turn.
    listAgentProfiles: vi.fn(async () => agentProfiles),
    listSkills: vi.fn(async () => skills),
    uninstallAgentPackage: vi.fn(async (slug: string) => ({
      ok: true as const,
      slug,
      agentId: `mock-agent-${slug}`,
    })),
    uninstallSkillPackage: vi.fn(async (slug: string) => ({
      ok: true as const,
      slug,
      skillId: `mock-skill-${slug}`,
    })),
    onAgentUninstallResult: vi.fn(() => () => {}),
    onSkillUninstallResult: vi.fn(() => () => {}),
    listPluginUiExtensions: vi.fn(async () => pluginUiExtensions),
    listPluginCards: vi.fn(async () => pluginCards),
    callPluginMethod: vi.fn(async () => ({ ok: true })),
    e2ePluginBundleSnapshot: vi.fn(async () => ({
      ok: false,
      error: "production-disabled",
    })),
    onPluginEvent: vi.fn((eventType: string, handler: (p: unknown) => void) => {
      let set = pluginEventHandlers.get(eventType);
      if (!set) {
        set = new Set();
        pluginEventHandlers.set(eventType, set);
      }
      set.add(handler);
      return () => set!.delete(handler);
    }),
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    window: {
      openHtmlPreview: vi.fn(async () => ({ ok: true, windowId: 2 })),
    },

    getRecentNotes: vi.fn(async () => []),

    getUsageSummary: vi.fn(async () => usage),
    getUsageDailySummary: vi.fn(async () => ({ ok: false, error: "mock-unavailable" })),
    getPricingOverrides: vi.fn(async () => []),
    getAppInfo: vi.fn(async () => appInfo),
    // Routine API
    listRoutines: vi.fn(async () => ({ routines: [], invalid: [] })),
    dismissRoutine: vi.fn(async () => ({ ok: true })),
    removeRoutine: vi.fn(async () => ({ ok: true })),
    triggerRoutineNow: vi.fn(async () => ({ ok: true })),
    listPendingRoutineResults: vi.fn(async () => pendingRoutineResults),
    acknowledgeRoutineResult: vi.fn(async () => ({ ok: true })),
    addRoutine: vi.fn(async () => ({ ok: true, routine: {} })),
    onRoutineFired: vi.fn((h: (r: unknown) => void) => {
      routineFiredHandlers.add(h);
      // Replay latestRoutineResult on subscription (simulates mount-time catchup).
      if (latestRoutineResult !== null) {
        Promise.resolve(latestRoutineResult).then((r) => {
          if (r !== null && r !== undefined) h(r);
        });
      }
      return () => routineFiredHandlers.delete(h);
    }),
    onRoutineRunningStarted: vi.fn((h: (p: unknown) => void) => {
      routineRunningHandlers.add(h);
      return () => routineRunningHandlers.delete(h);
    }),
    onRoutineRunningFinished: vi.fn((_h: (id: string) => void) => () => {}),
    onRoutineFailed: vi.fn((_handler: (event: { routineId: string; error: string }) => void) => () => {}),
    listRoutineSessions: vi.fn(async (routineId: string) => routineSessionsByRoutine[routineId] ?? []),
    // Work Board API; board panel subscribes to onWorkBoardItemChanged at mount, so the smoke test mock must define these even when the suite
    // doesn't exercise the board. CRUD mocks return the store's discriminated `status` envelopes; events are no-op subscribe handles by default.
    listWorkBoard: vi.fn(async () => ({ status: "ok", items: [] })),
    getWorkBoardItem: vi.fn(async (id: number) => ({ status: "not_found", itemId: id })),
    addWorkBoardItem: vi.fn(async () => ({ status: "invalid", reason: "mock" })),
    updateWorkBoardItem: vi.fn(async (id: number) => ({ status: "not_found", itemId: id })),
    transitionWorkBoardItem: vi.fn(async (id: number) => ({ status: "not_found", itemId: id })),
    completeWorkBoardItem: vi.fn(async (id: number) => ({ status: "not_found", itemId: id })),
    reopenWorkBoardItem: vi.fn(async (id: number) => ({ status: "not_found", itemId: id })),
    removeWorkBoardItem: vi.fn(async (id: number) => ({ status: "not_found", itemId: id })),
    runWorkBoardItem: vi.fn(async () => ({ ok: true })),
    generateWorkBoardReport: vi.fn(async (input: { kind: string; period?: string }) => ({
      status: "empty",
      kind: input.kind,
      period: input.period ?? "",
      reason: "mock",
    })),
    runWorkBoardBriefing: vi.fn(async (kind: string) => ({
      status: "empty",
      kind,
      reason: "mock",
    })),
    onWorkBoardItemChanged: vi.fn((handler: (p: unknown) => void) => {
      workBoardItemChangedHandlers.add(handler);
      return () => workBoardItemChangedHandlers.delete(handler);
    }),
    onWorkBoardRunStarted: vi.fn((_h: (p: unknown) => void) => () => {}),
    onWorkBoardRunFinished: vi.fn((_h: (p: unknown) => void) => () => {}),
    onWorkBoardRunFailed: vi.fn((_h: (p: unknown) => void) => () => {}),
    onWorkBoardFailed: vi.fn((_h: (event: { itemId: number; error: string }) => void) => () => {}),
    onWorkBoardDueSoon: vi.fn((_h: (p: unknown) => void) => () => {}),
    // Overlay trigger lifecycle. Tests that don't exercise the trigger card just need these to be callable subscribe/no-op functions.
    onTriggerStarted: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerCompleted: vi.fn((_h: (r: unknown) => void) => () => {}),
    onTriggerFailed: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerExpired: vi.fn((_h: (p: unknown) => void) => () => {}),
    onTriggerImported: vi.fn((_h: (p: unknown) => void) => () => {}),
    dismissTrigger: vi.fn(async () => ({ ok: true, removed: true })),
    importTrigger: vi.fn(async () => ({ ok: true, imported: 0 })),
    onOverlayShow: vi.fn((handler: (item: unknown) => void) => {
      overlayShowHandlers.add(handler);
      return () => overlayShowHandlers.delete(handler);
    }),
    onOverlayUpdate: vi.fn((_handler: (id: string, patch: unknown) => void) => () => {}),
    onOverlayDismiss: vi.fn((handler: (id: string) => void) => {
      overlayDismissHandlers.add(handler);
      return () => overlayDismissHandlers.delete(handler);
    }),

    onAskUserQuestion: vi.fn((h: (r: unknown) => void) => {
      askUserQuestionHandlers.add(h);
      return () => askUserQuestionHandlers.delete(h);
    }),
    onAskUserQuestionTimeout: vi.fn(() => () => {}),
    respondAskUserQuestion: vi.fn(async () => ({ ok: true })),
    listPendingAskUserQuestions: vi.fn(async () => []),

    submitFeedback: vi.fn(async () => ({ ok: true })),

    ...(overrides.sideChat ? {
      sideChat: {
        // A pane's turn lands in that pane's own conversation, as main keeps it.
        send: vi.fn(async (input: string, _attachments?: unknown[], _origin?: string, _request?: string, surface?: { tabId: string }) => {
          if (surface) {
            const chat = paneChats.get(surface.tabId) ?? { sessionId: `00000000-0000-4000-8000-${String(++mintedPaneChats).padStart(12, "0")}`, messages: [] };
            chat.messages.push({ index: chat.messages.length, role: "user" as const, content: input });
            paneChats.set(surface.tabId, chat);
            // Main announces the turn's session in its prelude and closes the stream with `done`; the pane chat's turn then reads as finished.
            const streamId = ++paneChatStreams;
            for (const handler of [...sideStreamHandlers]) {
              handler({ type: "user_message", streamId, sessionId: chat.sessionId, sendRequestId: _request, text: input } as ChatStreamEvent);
              handler({ type: "done", streamId } as ChatStreamEvent);
            }
          }
          return { ok: true, result: {} };
        }),
        paneHistory: vi.fn(async (tabId: string) => {
          const chat = paneChats.get(tabId);
          return { ok: true, sessionId: chat?.sessionId ?? null, messages: chat ? [...chat.messages] : [] };
        }),
        endPaneChat: vi.fn(async (tabId: string, _reason: "new" | "closed") => {
          const chat = paneChats.get(tabId);
          paneChats.delete(tabId);
          return { ok: true, sessionId: chat?.sessionId ?? null };
        }),
        new: vi.fn(async () => ({ ok: true, sessionId: MOCK_SIDE_CHAT_SESSION_ID })),
        load: vi.fn(async () => ({ ok: true, sessionId: MOCK_SIDE_CHAT_SESSION_ID, messages: [] })),
        getSubAgentTranscript: vi.fn(async (_request: SubAgentTranscriptRequest): Promise<SubAgentTranscriptResult> => ({
          ok: false,
          error: "sub-agent-reference-not-found",
        })),
        list: vi.fn(async () => ({ current: null, sessions: [] })),
        abort: vi.fn(async () => ({ ok: true })),
        onStream: vi.fn((handler: (event: ChatStreamEvent) => void) => {
          sideStreamHandlers.add(handler);
          return () => sideStreamHandlers.delete(handler);
        }),
        onFallback: vi.fn(() => () => undefined),
      },
    } : {}),

    onViewActivate: vi.fn((h: (v: string, settingsTab?: string) => void) => {
      viewHandlers.add(h);
      return () => viewHandlers.delete(h);
    }),

    onMarketplaceUpdatesAvailable: vi.fn(() => () => {}),
    onMarketplaceAnnouncements: vi.fn(() => () => {}),
    onPluginInstallProgress: vi.fn((handler: (payload: unknown) => void) => {
      pluginInstallProgressHandlers.add(handler);
      return () => pluginInstallProgressHandlers.delete(handler);
    }),
    onPluginInstallResult: vi.fn((handler: (payload: unknown) => void) => {
      pluginInstallResultHandlers.add(handler);
      return () => pluginInstallResultHandlers.delete(handler);
    }),
    onPluginRuntimeUpdated: vi.fn((handler: (payload: { pluginId: string }) => void) => {
      pluginRuntimeUpdatedHandlers.add(handler);
      return () => pluginRuntimeUpdatedHandlers.delete(handler);
    }),
    onBootstrapStatus: vi.fn((handler: (status: AppBootstrapStatus) => void) => {
      bootstrapStatusHandlers.add(handler);
      return () => bootstrapStatusHandlers.delete(handler);
    }),
    // Late-mount snapshot pull. `null` is the host's answer when nothing was reported yet, which is what most suites want: the mock stays event-driven.
    getBootstrapStatus: vi.fn(async () => null),
    retryBootstrap: vi.fn(async () => ({ ok: true })),
    // App auto-update bridge; renderer's useAppUpdate hook subscribes immediately at App mount,
    // so the smoke test mock must define these even when the suite doesn't exercise update flow.
    onAppUpdateState: vi.fn(() => () => {}),
    getAppUpdateState: vi.fn(async () => ({ kind: "idle" })),
    downloadAppUpdate: vi.fn(async () => ({ ok: true })),
    installAppUpdate: vi.fn(async () => ({ ok: true })),
    skipAppUpdate: vi.fn(async () => ({ ok: true })),

    plugins: {
      getPerfStats: vi.fn(async () => ({})),
    },
  };

  api.starredAdd = api.addStarred;
  api.starredRemove = api.removeStarred;

  return {
    api,
    /** Which groups' loops were released. One spy per group rather than one shared spy: at the conversation ceiling the
     * interesting question is not whether something was released but WHICH group was, and a shared spy answers only the first. */
    releasedGroupIds: (): string[] => [
      ...(chatGroupRelease.mock.calls.length > 0 ? [MAIN_CHAT_GROUP_ID] : []),
      ...[...chatGroupApis.entries()]
        .filter(([, group]) => group.chatGroupRelease.mock.calls.length > 0)
        .map(([chatGroupId]) => chatGroupId),
    ],
    emitChatStream: (ev) => chatStreamHandlers.forEach((h) => h(ev)),
    emitChatFallback: (chatGroupId, payload) =>
      chatFallbackHandlers.get(chatGroupId)?.forEach((h) => h(payload)),
    emitAgentSpawnEvent: (event) => agentSpawnEventHandlers.forEach((h) => h(event)),
    emitSkillLoaded: (event) => skillLoadedHandlers.forEach((h) => h(event)),
    emitSessionTasksChanged: (payload) => sessionTasksHandlers.forEach((h) => h(payload)),
    emitSessionGoalChanged: (payload) => sessionGoalHandlers.forEach((h) => h(payload)),
    emitOverlayShow: (item) => overlayShowHandlers.forEach((h) => h(item)),
    emitOverlayDismiss: (id) => overlayDismissHandlers.forEach((h) => h(id)),
    emitRoutineFired: (r) => routineFiredHandlers.forEach((h) => h(r)),
    emitRoutineRunningStarted: (p) => routineRunningHandlers.forEach((h) => h(p)),
    emitPluginEvent: (eventType, payload) =>
      pluginEventHandlers.get(eventType)?.forEach((h) => h(payload)),
    emitWorkBoardItemChanged: (p) => workBoardItemChangedHandlers.forEach((h) => h(p)),
    emitViewActivate: (v, settingsTab) => viewHandlers.forEach((h) => h(v, settingsTab)),
    emitAskUserQuestion: (r) => askUserQuestionHandlers.forEach((h) => h(r)),
    emitTourStart: (scenarioId) => tourStartHandlers.forEach((h) => h({ scenarioId })),
    emitBootstrapStatus: (status) => bootstrapStatusHandlers.forEach((h) => h(status)),
    emitPluginInstallProgress: (payload) => pluginInstallProgressHandlers.forEach((h) => h(payload)),
    emitPluginInstallResult: (payload) => pluginInstallResultHandlers.forEach((h) => h(payload)),
    emitPluginRuntimeUpdated: (payload) => pluginRuntimeUpdatedHandlers.forEach((h) => h(payload)),
    emitNotificationToast: (payload) => notificationToastHandlers.forEach((h) => h(payload)),
    emitNotificationClicked: (payload) => notificationClickedHandlers.forEach((h) => h(payload)),
    emitSubscriptionRuntimeStatusUpdated: (event) =>
      subscriptionRuntimeStatusUpdatedHandlers.forEach((handler) => handler(event)),
  };
}

/** Build the double and put it where the renderer looks for it. Every settings-tab test needs the same two lines; make the api, assign it to `window.aveApi`; and each one had written its own `installApi`, which is
 * how two of them ended up as the same function under the same name in two files. One implementation, so a component that starts calling a new method gets it everywhere at once instead of failing per test file. */
export function installMockAveApi(overrides: ApiOverrides = {}): MockAveApi {
  const { api } = makeMockAveApi(overrides);
  (globalThis as unknown as { window: { aveApi?: unknown } }).window.aveApi = api;
  return api;
}

type AveNamespaceOverrides = {
  env?: Partial<{
    isDev: boolean;
    isE2E: boolean;
    enableDevConsole: boolean;
    debugStream: boolean;
  }>;
  /** Requests the host is already parked on when the renderer mounts. */
  pendingApprovals?: unknown[];
  /** Project folders `workspace.listRoots` reports; the default is `/ws` alone. */
  workspaceRoots?: Array<{ path: string; isDefault: boolean }>;
  /** Install the native context-menu bridge (`ave.ui`). Opt-in: without it the renderer's menus fall through to their ancestors, which most suites rely on. */
  nativeContextMenu?: boolean;
};

export function makeMockAveNamespace(overrides: AveNamespaceOverrides = {}) {
  const approvalHandlers = new Set<(r: unknown) => void>();
  const approvalSettledHandlers = new Set<(payload: unknown) => void>();
  const roots = overrides.workspaceRoots ?? [{ path: "/ws", isDefault: true }];
  const defaultRoot = roots.find((root) => root.isDefault)?.path ?? roots[0]?.path ?? "/ws";
  const nativeMenuHandlers = new Set<(action: { requestId: string; command: string }) => void>();
  const showNativeContextMenu = vi.fn(async (_payload: { requestId: string; commands: string[] }) => ({ ok: true as const }));
  const ui = overrides.nativeContextMenu
    ? {
      ui: {
        showNativeContextMenu,
        onNativeContextMenuAction: (handler: (action: { requestId: string; command: string }) => void) => {
          nativeMenuHandlers.add(handler);
          return () => { nativeMenuHandlers.delete(handler); };
        },
      },
    }
    : {};
  return {
    ns: {
      permission: {
        getMode: vi.fn(async () => ({ mode: "default" })),
        setMode: vi.fn(async (mode: string) => ({ ok: true, mode })),
        onModeChanged: vi.fn(() => () => undefined),
        listRules: vi.fn(async () => []),
        listScopedRules: vi.fn(async () => ({ rules: [], errors: [] })),
        removeScopedRule: vi.fn(async () => ({ ok: true })),
        addRule: vi.fn(async () => ({ ok: true })),
        removeRule: vi.fn(async () => ({ ok: true })),
        onReviewSuggestion: vi.fn(() => () => undefined),
      },
      approval: {
        onRequest: vi.fn((cb: (r: unknown) => void) => {
          approvalHandlers.add(cb);
          return () => approvalHandlers.delete(cb);
        }),
        onSettled: vi.fn((cb: (payload: unknown) => void) => {
          approvalSettledHandlers.add(cb);
          return () => approvalSettledHandlers.delete(cb);
        }),
        respond: vi.fn(async () => ({ ok: true })),
        // Nothing parked on the host by default; a test that opens with a request already waiting (a reload mid-approval) overrides this.
        listPending: vi.fn(async () => overrides.pendingApprovals ?? []),
        // `/allow` selector. Defaults to "no provider configured" so a test that never opts in still exercises the failure path rather than a silently successful proposal.
        selectSentence: vi.fn(async () => ({
          ok: false as const,
          error: "allow-selector-unavailable",
        })),
      },
      userApproval: {
        record: vi.fn(async () => ({ ok: true })),
        revokeByKey: vi.fn(async () => ({ ok: true })),
        list: vi.fn(async () => []),
        listSession: vi.fn(async () => []),
      },
      policy: {
        get: vi.fn(async () => ({
          version: 1,
          requireExplicitApproval: false,
          managed: false,
          updatedAt: new Date().toISOString(),
          source: "defaults",
        })),
        set: vi.fn(async () => ({ ok: true })),
      },
      // File-preview + project-folder browser surfaces (workspace rail). Default stubs so any
      // renderApp-based test that opens the file-browser tab renders without a real preload bridge.
      preview: {
        readFile: vi.fn(async (path: string) => ({ ok: true, content: "", path, truncated: false })),
        readDocument: vi.fn(async () => ({ ok: false, error: "unsupported-format", message: "Unsupported preview document format." })),
        onDocumentObservation: vi.fn(() => () => {}),
        acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })),
      },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot, roots })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async (path: string) => ({ ok: true, path, entries: [], truncated: false })),
      },
      env: {
        isDev: false,
        isE2E: false,
        enableDevConsole: false,
        debugStream: false,
        ...overrides.env,
      },
      ...ui,
    },
    emitApproval: (r: unknown) => approvalHandlers.forEach((h) => h(r)),
    /** The host retired a parked request; see `ave:approval:settled`. */
    emitApprovalSettled: (requestId: string) =>
      approvalSettledHandlers.forEach((h) => h({ requestId })),
    /** Answer the last native menu the renderer asked for with `command`. */
    chooseNativeMenuCommand: (command: string) => {
      const payload = showNativeContextMenu.mock.calls.at(-1)?.[0];
      if (!payload) throw new Error("no native context menu was requested");
      for (const handler of nativeMenuHandlers) handler({ requestId: payload.requestId, command });
    },
  };
}

/** The git marketplace namespace: every read answers empty, every event subscribes to nothing. */
function mockGitMarketplace(sources: unknown[]) {
  const ok = <T>(value: T) => vi.fn(async () => ({ ok: true as const, value }));
  const subscribe = () => vi.fn(() => () => {});
  return {
    listSources: ok(sources),
    previewSource: ok(null),
    addSource: ok(null),
    removeSource: ok({ orphanedPackages: [] }),
    setSourceEnabled: ok(null),
    refreshSources: ok(sources),
    repairSource: ok(sources),
    acceptRewrite: ok(null),
    setToken: ok({ host: "github.com" }),
    deleteToken: ok({ host: "github.com" }),
    listCatalog: ok({ entries: [], counts: {}, sourceCount: sources.length, syncedAt: null }),
    packageDetail: ok(null),
    planInstall: ok(null),
    planUpdate: ok(null),
    executeInstall: ok(null),
    uninstall: ok(null),
    previewDirectMcp: ok(null),
    onSyncProgress: subscribe(),
    onCatalogChanged: subscribe(),
    onInstallProgress: subscribe(),
    takeDeepLink: ok(null),
    onDeepLink: subscribe(),
    bootInstallNotice: ok(null),
    dismissBootInstallNotice: ok(null),
    onBootInstallsApplied: subscribe(),
    updateStatus: ok({
      discovery: { lastAttemptAt: null, lastSuccessAt: null, result: null, nextAt: "2026-10-01T00:00:00.000Z" },
      applyCheckAt: null,
      running: false,
      historyReset: false,
      packages: [],
    }),
    checkUpdates: ok({
      discovery: { lastAttemptAt: null, lastSuccessAt: null, result: null, nextAt: "2026-10-01T00:00:00.000Z" },
      applyCheckAt: null,
      running: false,
      historyReset: false,
      packages: [],
    }),
    onUpdateStatus: subscribe(),
  };
}
