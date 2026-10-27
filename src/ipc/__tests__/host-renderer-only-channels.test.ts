/**
 * The plugin UI shell is a `file://` frame, so the base sender validator admits
 * it. That validator is the protocol allow-list, not a trust decision: the only
 * IPC a plugin is meant to reach is the `pluginBridge.*` bridge, which has its
 * own validator. Every other host channel therefore takes
 * `validateHostRendererSender`, which rejects the shell.
 *
 * The narrow `window.avePlugin` preload is not what enforces this — it only
 * shapes what plugin authors can call. A compromised plugin renderer holds
 * `ipcRenderer` itself and can invoke any channel name, so the main-side frame
 * check is the only thing that holds.
 *
 * Each channel in the table is driven from BOTH frames, and what the table
 * asserts is the guard's reject branch: an `ipc-guard` audit row appears for
 * the plugin shell and does not appear for the host renderer. Driving only the
 * plugin direction would stay green if a channel started refusing everyone.
 *
 * The audit row is the table's observable because the rejection sentinels
 * differ per handler (some return `UNAUTHORIZED_FRAME`, some a domain-shaped
 * empty result, some nothing at all) while `auditUnauthorized` is one shared
 * call site. It is a proxy, and worth naming as one: it shows the guard took
 * its reject branch, not that the handler returned nothing afterwards. A
 * handler that audited and then answered anyway would keep the table green.
 *
 * `ave:app:info` is additionally asserted by return value at the bottom of
 * this file, where "refused" means the caller got `UNAUTHORIZED_FRAME` and none
 * of the host fields.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { hostFrameEvent, pluginShellFrameEvent } from "../../__tests__/test-helpers.js";

const { CHANNELS } = await import("../../contract/app-contract.js");
const { ALERTS, ROUTINES, WORK_BOARD } = await import("../../shared/ipc-channels.js");
const { setIsPackaged } = await import("../../boot/dev-flags.js");
const { UNAUTHORIZED_FRAME } = await import("../gated.js");

const handleMap = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();

const { searchWorkspaceFiles, defaultSession } = vi.hoisted(() => ({
  searchWorkspaceFiles: vi.fn(async () => ({ matches: [], truncated: false })),
  defaultSession: { setSpellCheckerEnabled: vi.fn() },
}));

vi.mock("../domains/workspace-file-search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../domains/workspace-file-search.js")>()),
  searchWorkspaceFiles,
}));

vi.mock("electron", () => {
  const noopWindow = {
    id: 1,
    isDestroyed: () => false,
    webContents: { send: vi.fn(), id: 1, isDestroyed: () => false, session: { setSpellCheckerEnabled: vi.fn() } },
    minimize: vi.fn(),
    maximize: vi.fn(),
    unmaximize: vi.fn(),
    isMaximized: () => false,
    close: vi.fn(),
    setTitleBarOverlay: vi.fn(),
  };
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
        handleMap.set(channel, fn);
      }),
      on: vi.fn(),
      removeHandler: vi.fn(),
    },
    BrowserWindow: Object.assign(vi.fn(() => noopWindow), {
      getAllWindows: () => [],
      fromWebContents: () => null,
      getFocusedWindow: () => null,
    }),
    dialog: {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showSaveDialog: vi.fn(async () => ({ canceled: true })),
      showMessageBox: vi.fn(async () => ({ response: 1 })),
    },
    shell: { openExternal: vi.fn(async () => undefined), showItemInFolder: vi.fn() },
    app: { getPath: vi.fn(() => "/nonexistent-app-path"), getVersion: vi.fn(() => "0.0.0-test"), getName: vi.fn(() => "ave") },
    nativeTheme: { shouldUseDarkColors: false, on: vi.fn() },
    clipboard: { readImage: vi.fn(() => ({ isEmpty: () => true })) },
    webContents: { fromId: vi.fn(() => null), getAllWebContents: () => [] },
    session: { defaultSession, fromPartition: vi.fn(() => ({ webRequest: { onBeforeRequest: vi.fn() }, protocol: { handle: vi.fn() } })) },
    net: { fetch: vi.fn() },
  };
});

type AuditRow = { sessionId?: string; input?: string };
const auditRows: AuditRow[] = [];
const auditLogger = {
  log: vi.fn((row: AuditRow) => {
    auditRows.push(row);
  }),
  logWarn: vi.fn(),
  search: vi.fn(() => []),
  getStats: vi.fn(() => ({})),
  flush: vi.fn(async () => undefined),
  getAuditDir: vi.fn(() => "/nonexistent-audit-dir"),
  getPermissionAuditSecret: vi.fn(() => null),
};

/**
 * Enough shape for each `register*Handlers` to finish wiring. The host sender
 * reaches handler bodies, so their dependencies stay inert. Workspace search
 * returns the deterministic result above to keep this sender matrix scoped.
 */
const appWindows: Array<{ isDestroyed: () => boolean; webContents: unknown }> = [];

function registeredHostEvent(): IpcMainInvokeEvent {
  const event = hostFrameEvent();
  Object.assign(event.senderFrame!, { processId: 1, routingId: 0, detached: false, isDestroyed: () => false });
  Object.assign(event.sender, { id: 1, mainFrame: event.senderFrame, session: defaultSession,
    getType: () => "window", isDestroyed: () => false });
  appWindows.push({ isDestroyed: () => false, webContents: event.sender });
  return event;
}

function makeDeps(): never {
  return {
    auditLogger,
    getMainWindow: () => null,
    getAppWindows: () => appWindows,
    conversationLoop: {
      getSessionId: () => "test-session",
      permissionManager: undefined,
      abortCurrentTurn: vi.fn(),
      generateText: vi.fn(async () => ""),
      getActiveStreamTurn: () => null,
    },
    sideChatConversationLoop: undefined,
    approvalGate: undefined,
    settingsService: {
      get: vi.fn(() => undefined),
      getAll: vi.fn(() => ({})),
      set: vi.fn(),
      patch: vi.fn(async () => undefined),
      getSecret: vi.fn(() => null),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
      onChange: vi.fn(),
    },
    pluginRuntime: {
      retireSandboxGrantsOutsideCeiling: vi.fn(async () => []),
      getPluginManifest: vi.fn(() => null),
      getPluginRoot: vi.fn(() => null),
      getGenerationAccess: vi.fn(() => null),
      isPluginUiRevisionCurrent: vi.fn(() => false),
      resolveToolOwner: vi.fn(() => null),
      listPlugins: vi.fn(() => []),
    },
    revokePluginOperationSession: vi.fn(),
    workBoardStore: undefined,
  } as unknown as never;
}

/**
 * The sender guard's audit row is the one carrying `frameUrl`. Other
 * `ipc-guard` rows exist (payload-validation rejections inside a handler that
 * already passed its guard), and matching those would report a guard rejection
 * that never happened.
 */
function guardRowsFor(channel: string): AuditRow[] {
  return auditRows.filter((row) => {
    if (row.sessionId !== "ipc-guard" || typeof row.input !== "string") return false;
    const parsed = JSON.parse(row.input) as { channel?: string; frameUrl?: string };
    return parsed.channel === channel && typeof parsed.frameUrl === "string";
  });
}

/** What {@link invoke} returns when the handler threw. */
const THREW = Symbol("handler threw");

async function invoke(channel: string, event: IpcMainInvokeEvent, args: unknown[]): Promise<unknown> {
  const handler = handleMap.get(channel);
  expect(handler, `${channel} was never registered`).toBeDefined();
  try {
    return await handler!(event, ...args);
  } catch {
    // A throw means the handler ran past its guard into a stubbed dependency,
    // which is exactly what the host-renderer direction is asserting. Returned
    // as `THREW` rather than `undefined` so a value assertion cannot mistake a
    // crash for a handler that legitimately answered with nothing.
    return THREW;
  }
}

/** `[domain, channel, args]` — args are only what a handler needs to reach its guard. */
const HOST_ONLY_CHANNELS: ReadonlyArray<readonly [string, string, unknown[]]> = [
  // Full chat authority: sending turns, reading transcripts, editing memory.
  ["chat", CHANNELS.chat.send, [{ input: "x" }]],
  ["chat", CHANNELS.chat.sessions, []],
  ["chat", CHANNELS.chat.mainActiveState, []],
  ["chat", CHANNELS.chat.sessionHistory, ["s"]],
  ["chat", CHANNELS.chat.getTurnReview, ["s", "main"]],
  ["chat", CHANNELS.chat.listShellTasks, ["main", "11111111-1111-4111-8111-111111111111"]],
  ["chat", CHANNELS.chat.controlShellTask, ["main", "11111111-1111-4111-8111-111111111111", "background"]],
  ["chat", CHANNELS.memory.entriesList, [{}]],
  // Secret writes and the external-link opener.
  ["settings", CHANNELS.settings.update, [{}]],
  ["settings", CHANNELS.settings.setApiKey, ["anthropic", "k"]],
  ["settings", CHANNELS.shell.openExternal, ["https://example.com/"]],
  // Plugin management — the host settings screen, not the plugin bridge.
  ["plugins", CHANNELS.plugins.installLocal, []],
  ["plugins", CHANNELS.plugins.uninstall, ["p"]],
  ["plugins", CHANNELS.plugins.configSecretSet, ["p", "k", "v"]],
  ["plugins", CHANNELS.runtime.counts, []],
  ["plugins", CHANNELS.mcp.servers, []],
  ["plugins", CHANNELS.mcp.authenticate, ["server-a"]],
  // The host renderer registers plugin webviews on the shell's behalf, so this
  // one lives on the bridge channel prefix but is host-only: a shell that could
  // call it would be minting its own plugin binding.
  ["plugins", CHANNELS.pluginBridge.registerWebview, [{ webContentsId: 1, pluginId: "p", entryUrl: "file:///x" }]],
  ["plugins", CHANNELS.host.pluginThemeNotify, [{}]],
  // Draft bytes, local package selection and installation stay in the host renderer.
  ...Object.values(CHANNELS.pluginStudio).map((channel): readonly [string, string, unknown[]] => ["plugin-studio", channel, []]),
  // Side chat runs arbitrary tools on a second loop.
  ["sidechat", CHANNELS.sidechat.send, [{ input: "x" }]],
  ["sidechat", CHANNELS.sidechat.listShellTasks, ["11111111-1111-4111-8111-111111111111"]],
  ["sidechat", CHANNELS.sidechat.controlShellTask, ["11111111-1111-4111-8111-111111111111", "background"]],
  ["sidechat", CHANNELS.sidechat.getSubAgentTranscript, [{ originSessionId: "test-session", childSessionId: "child-session" }]],
  // Routines and the session tasks list.
  ["routines", ROUTINES.list, []],
  ["session-tasks", CHANNELS.sessionTasks.list, []],
  ["session-goal", CHANNELS.sessionGoal.get, []],
  ["session-goal", CHANNELS.sessionGoal.pause, []],
  // Host identity + runtime versions. Read-only, but the response carries
  // `userDataPath` and is returned unprojected.
  ["app", CHANNELS.app.info, []],
  // Work board items drive agent runs.
  ["work-board", WORK_BOARD.list, [{}]],
  ["work-board", WORK_BOARD.run, [{}]],
  // Closing an alert card keeps its identity closed; the staged cards carry
  // host-rendered prompts.
  ["alerts", ALERTS.cardClosed, ["id", "dismissed"]],
  ["alerts", ALERTS.listOpen, []],
  ["alerts", ALERTS.removePredecessor, ["fixturemail:reply"]],
  ["alerts", ALERTS.listKinds, []],
  ["alerts", ALERTS.setKind, ["@host:due-soon", { enabled: true }]],
  ["alerts", ALERTS.setOsNotificationsEnabled, [false]],
  // Saved prompts are user-authored content.
  ["prompts", CHANNELS.prompts.list, []],
  ["prompts", CHANNELS.prompts.save, [{}]],
  // Onboarding state.
  ["tour", CHANNELS.tour.getState, []],
  ["tour", CHANNELS.tour.start, ["scenario"]],
  // Filesystem reach: workspace roots, attachment picking, file preview.
  ["workspace", CHANNELS.workspace.listRoots, []],
  ["workspace", CHANNELS.workspace.listDir, [{ path: "/" }]],
  // A valid query, so the host frame reaches the search call past query
  // validation; searchWorkspaceFiles is mocked above, so no filesystem walk runs.
  ["workspace", CHANNELS.workspace.searchFiles, ["src"]],
  ["attach", CHANNELS.attach.openFile, [{}]],
  ["attach", CHANNELS.attach.readImage, ["/x"]],
  ["attach", CHANNELS.attach.registerDrop, [["/x"]]],
  ["attach", CHANNELS.attach.redeemDrop, ["token"]],
  ["preview", CHANNELS.preview.readFile, ["/x"]],
  ["preview", CHANNELS.preview.readDocument, ["/x.csv", 0]],
  ["preview", CHANNELS.preview.editXlsx, [{ action: "save", token: "a".repeat(64), row: 0, column: 1, value: 84 }]],
  ["preview", CHANNELS.preview.documentOpenAck, [{ requestId: "request", sessionId: "session", opened: true }]],
  // Usage and cost history.
  ["usage", CHANNELS.usage.range, [{}]],
  ["usage", CHANNELS.usage.pricingOverrides, []],
  // The model catalog the renderer resolves against; only the host renderer installs it.
  ["chat", CHANNELS.llm.getModelCatalog, []],
  // The preflight override is a developer switch over host behaviour.
  ["dev", CHANNELS.dev.getPreflightStatus, []],
  // Window controls act on the host BrowserWindow the shell is embedded in.
  ["window", CHANNELS.window.minimize, []],
  ["window", CHANNELS.window.openHtmlPreview, [{ html: "<p>x</p>" }]],
  // The update scheduler's status and *Check now* (design §18.9): a check syncs every source.
  ["git-marketplace", CHANNELS.gitMarketplace.updatesStatus, []],
  ["git-marketplace", CHANNELS.gitMarketplace.updatesCheck, []],
  // The folder dialogs (design §18.9): a native folder chooser, and a folder source opened in the file manager.
  ["git-marketplace", CHANNELS.gitMarketplace.sourcesPickFolder, []],
  ["git-marketplace", CHANNELS.gitMarketplace.sourcesReveal, ["team"]],
  // *Apply now* skips the idle gate; approving components runs an agent plugin's servers and hooks (§18.7.4, §18.7.5).
  ["git-marketplace", CHANNELS.gitMarketplace.updatesApplyNow, []],
  ["git-marketplace", CHANNELS.gitMarketplace.componentsApprove, [{ sourceId: "official", kind: "agent-plugin", name: "notes" }, "id", []]],
];

beforeEach(async () => {
  handleMap.clear();
  appWindows.length = 0;
  auditRows.length = 0;
  vi.clearAllMocks();
  // The dev domain refuses everything when packaged, which would hide its
  // sender guard behind an earlier return.
  setIsPackaged(false);
  const deps = makeDeps();
  const [
    { registerChatHandlers },
    { registerSettingsHandlers },
    { registerPluginsHandlers },
    { registerSideChatHandlers },
    { registerRoutineHandlers },
    { registerSessionTasksHandlers },
    { registerSessionGoalHandlers },
    { registerAppHandlers },
    { registerWorkBoardHandlers },
    { registerPromptHandlers },
    { registerTourHandlers },
    { registerWorkspaceHandlers },
    { registerAttachHandlers },
    { registerPreviewHandlers },
    { registerUsageHandlers },
    { registerDevHandlers },
    { registerWindowHandlers },
    { registerAlertsHandlers },
    { registerPluginStudioHandlers },
    { registerGitMarketplaceHandlers },
  ] = await Promise.all([
    import("../domains/chat.js"),
    import("../domains/settings.js"),
    import("../domains/plugins.js"),
    import("../domains/sidechat.js"),
    import("../domains/routines.js"),
    import("../domains/session-tasks.js"),
    import("../domains/session-goal.js"),
    import("../domains/app.js"),
    import("../domains/work-board.js"),
    import("../domains/prompts.js"),
    import("../domains/tour.js"),
    import("../domains/workspace.js"),
    import("../domains/attach.js"),
    import("../domains/preview.js"),
    import("../domains/usage.js"),
    import("../domains/dev.js"),
    import("../domains/window.js"),
    import("../domains/alerts.js"),
    import("../domains/plugin-studio.js"),
    import("../domains/git-marketplace.js"),
  ]);
  registerChatHandlers(deps);
  registerSettingsHandlers(deps);
  registerPluginsHandlers(deps);
  registerSideChatHandlers(deps);
  registerRoutineHandlers(deps);
  registerSessionTasksHandlers(deps);
  registerSessionGoalHandlers(deps);
  registerAppHandlers(deps);
  registerWorkBoardHandlers(deps);
  registerPromptHandlers(deps);
  registerTourHandlers(deps);
  registerWorkspaceHandlers(deps);
  registerAttachHandlers(deps);
  registerPreviewHandlers(deps);
  registerUsageHandlers(deps);
  registerDevHandlers(deps);
  registerWindowHandlers(deps);
  registerAlertsHandlers(deps, async () => ({} as never));
  registerPluginStudioHandlers(deps, async () => null);
  // Its other channels build the marketplace on the first request; this table drives only the scheduler's.
  registerGitMarketplaceHandlers(deps, async () => null, async () => {
    throw new Error("the git marketplace is not built in this suite");
  });
});

describe("host-renderer-only IPC channels", () => {
  it.each(HOST_ONLY_CHANNELS.filter(([domain]) => domain === "preview"))(
    "%s %s refuses a file-backed webview and an app-window subframe",
    async (_domain, channel, args) => {
      const webview = registeredHostEvent();
      Object.assign(webview.senderFrame!, { url: "file:///plugins/example/view.js" });
      Object.assign(webview.sender, { getType: () => "webview" });
      expect(await invoke(channel, webview, args)).toMatchObject({ ok: false, error: "unauthorized" });
      const subframe = registeredHostEvent();
      Object.assign(subframe, { senderFrame: { ...subframe.senderFrame, routingId: 1 } });
      expect(await invoke(channel, subframe, args)).toMatchObject({ ok: false, error: "unauthorized" });
      expect(guardRowsFor(channel)).toHaveLength(2);
    },
  );
  it.each(HOST_ONLY_CHANNELS)("%s %s refuses a plugin shell frame", async (_domain, channel, args) => {
    await invoke(channel, pluginShellFrameEvent(), args);
    expect(guardRowsFor(channel).length).toBeGreaterThan(0);
    if (channel === CHANNELS.workspace.searchFiles) {
      expect(searchWorkspaceFiles).not.toHaveBeenCalled();
    }
  });

  it.each(HOST_ONLY_CHANNELS)("%s %s does not refuse the host renderer", async (domain, channel, args) => {
    const event = domain === "preview" ? registeredHostEvent() : hostFrameEvent();
    if (channel === CHANNELS.preview.documentOpenAck) Object.assign(event.sender, { mainFrame: event.senderFrame });
    await invoke(channel, event, args);
    expect(guardRowsFor(channel)).toEqual([]);
    if (channel === CHANNELS.workspace.searchFiles) {
      expect(searchWorkspaceFiles).toHaveBeenCalledTimes(1);
      expect(searchWorkspaceFiles).toHaveBeenCalledWith(expect.objectContaining({ query: "src" }));
    }
  });
});

describe("side-chat child transcript sender refusal", () => {
  const request = { originSessionId: "test-session", childSessionId: "child-session" };

  it("returns unauthorized-frame to a plugin shell before checking side-chat availability", async () => {
    const result = await invoke(CHANNELS.sidechat.getSubAgentTranscript, pluginShellFrameEvent(), [request]);

    expect(result).toEqual(UNAUTHORIZED_FRAME);
    expect(guardRowsFor(CHANNELS.sidechat.getSubAgentTranscript)).toHaveLength(1);
  });

  it("admits the host sender before returning side-chat-unavailable", async () => {
    const result = await invoke(CHANNELS.sidechat.getSubAgentTranscript, hostFrameEvent(), [request]);

    expect(result).toEqual({ ok: false, error: "side-chat-unavailable" });
    expect(guardRowsFor(CHANNELS.sidechat.getSubAgentTranscript)).toEqual([]);
  });
});

describe("workbook editing sender refusal", () => {
  const request = { action: "save", token: "a".repeat(64), row: 0, column: 1, value: 84 };

  it("returns unauthorized to a plugin shell before consuming a workbook identity", async () => {
    expect(await invoke(CHANNELS.preview.editXlsx, pluginShellFrameEvent(), [request]))
      .toEqual({ ok: false, error: "unauthorized" });
    expect(guardRowsFor(CHANNELS.preview.editXlsx)).toHaveLength(1);
  });

  it("admits the host sender before refusing an unissued workbook identity", async () => {
    const event = registeredHostEvent();
    expect(await invoke(CHANNELS.preview.editXlsx, event, [request]))
      .toEqual({ ok: false, error: "expired" });
    expect(guardRowsFor(CHANNELS.preview.editXlsx)).toEqual([]);
  });
});

/**
 * The table above cannot assert refusal by value — the sentinels are not
 * uniform. This channel's are: `UNAUTHORIZED_FRAME` on the reject branch, a
 * plain object of host fields on the pass branch, neither of which needs a
 * stub to produce. So the one channel whose module docstring claims a refusal
 * is the one channel where the refusal itself is pinned.
 */
describe("ave:app:info — refusal by returned value, not only by audit row", () => {
  it("answers a plugin shell frame with UNAUTHORIZED_FRAME and no host fields", async () => {
    const result = await invoke(CHANNELS.app.info, pluginShellFrameEvent(), []);
    expect(result).toEqual(UNAUTHORIZED_FRAME);
    expect(Object.keys(result as Record<string, unknown>)).toEqual(["ok", "error"]);
  });

  it("answers the host renderer with the host fields", async () => {
    const result = (await invoke(CHANNELS.app.info, hostFrameEvent(), [])) as Record<string, unknown>;
    expect(result).toMatchObject({ platform: process.platform, arch: process.arch });
    expect(typeof result.version).toBe("string");
    expect(typeof result.userDataPath).toBe("string");
  });
});

describe("the model catalog channel", () => {
  it("answers a refusal, not a rejected invoke, when main has no catalog installed", async () => {
    type Slot = { source?: unknown; resolved?: unknown };
    const slot = (globalThis as Record<symbol, Slot | undefined>)[Symbol.for("ave.modelCatalog.active")] as Slot;
    const saved = { ...slot };
    delete slot.source;
    delete slot.resolved;
    try {
      expect(await invoke(CHANNELS.llm.getModelCatalog, hostFrameEvent(), [])).toEqual({ ok: false, error: "catalog-unavailable" });
    } finally {
      Object.assign(slot, saved);
    }
    expect(await invoke(CHANNELS.llm.getModelCatalog, hostFrameEvent(), [])).toMatchObject({ ok: true });
  });
});
