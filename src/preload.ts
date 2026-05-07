// Named imports — esbuild bundles these as direct property access on the CJS
// module (no `__toESM` wrapper, no `.default` indirection). Aligned with
// plugin-preload.ts for the same reason: Electron 41 sandboxed webview preload
// contexts fail silently when the bundled output goes through
// `__toESM(require("electron"), 1).default.contextBridge`.
import { contextBridge, ipcRenderer } from "electron";
import { resolve as pathResolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { McpServerConfig } from "./mcp/types.js";
import type { ScheduleAgentId, ScheduleRoutineSchedule } from "./routines/schedule.js";
import type { SerializedHistoryMessage } from "./shared/chat-history.js";
import { PLUGIN_PRIVATE_NAMESPACES } from "./plugins/capabilities.js";

// ─── Deterministic plugin webview asset URLs ────────────────────────────────
// `__dirname` here resolves to the host preload's bundled location
// (`dist/src/`). Compute the plugin shell + preload URLs once on preload boot
// instead of deriving them from `window.location.href`, which can be the
// splash phase's `data:text/html;...` URL when the host renderer queries it.
// Producing `file://` strings means Electron always finds the assets even
// across reloads / drag-drop / dev-mode navigation.
function safeResolveFileUrl(relative: string): string {
  try {
    return pathToFileURL(pathResolve(__dirname, relative)).toString();
  } catch {
    return "";
  }
}
const pluginPreloadUrl = safeResolveFileUrl("plugin-preload.cjs");
const pluginShellUrl = safeResolveFileUrl("plugin-ui-shell.html");

type PluginActionResult =
  | { ok: true; pluginId: string; installed?: true; uninstalled?: true; version?: string }
  | { ok: false; error: string; message?: string };

function invalidPluginActionResult(): PluginActionResult {
  return {
    ok: false,
    error: "invalid-result",
    message: "플러그인 작업 결과가 올바르지 않습니다.",
  };
}

function normalizePluginActionResult(result: unknown): PluginActionResult {
  if (result && typeof result === "object" && "ok" in result && result.ok === false) {
    return result as PluginActionResult;
  }

  const payload = result && typeof result === "object"
    ? result as { pluginId?: unknown; installed?: unknown; uninstalled?: unknown; version?: unknown }
    : {};
  const pluginId = typeof payload.pluginId === "string" ? payload.pluginId.trim() : "";
  const installed = payload.installed === true;
  const uninstalled = payload.uninstalled === true;
  if (!pluginId || (!installed && !uninstalled)) {
    return invalidPluginActionResult();
  }
  const normalized: PluginActionResult = {
    ok: true,
    pluginId,
  };
  if (installed) {
    normalized.installed = true;
  }
  if (uninstalled) {
    normalized.uninstalled = true;
  }
  if (typeof payload.version === "string") {
    normalized.version = payload.version;
  }
  return normalized;
}

const api = {
  // ─── Plugin webview asset URLs (deterministic file://) ────────────────────
  // Static strings, NOT functions — the host renderer reads these directly
  // when mounting the plugin <webview>. Computed once at preload boot from
  // `__dirname` (= dist/src/) so they survive splash-phase data: URLs.
  pluginPreloadUrl,
  pluginShellUrl,

  // ─── Settings ────────────────────────────────────
  getSettings: async () => ipcRenderer.invoke("ave:settings:get"),
  updateSettings: async (partial: unknown) => ipcRenderer.invoke("ave:settings:update", partial),
  setApiKey: async (vendor: string, apiKey: string) => ipcRenderer.invoke("ave:settings:set-api-key", vendor, apiKey),
  hasApiKey: async (vendor?: string) => ipcRenderer.invoke("ave:settings:has-api-key", vendor) as Promise<boolean>,
  deleteApiKey: async (vendor: string) => ipcRenderer.invoke("ave:settings:delete-api-key", vendor),
  setWebApiKey: async (provider: string, apiKey: string) => ipcRenderer.invoke("ave:settings:set-web-api-key", provider, apiKey),
  hasWebApiKey: async (provider: string) => ipcRenderer.invoke("ave:settings:has-web-api-key", provider) as Promise<boolean>,
  deleteWebApiKey: async (provider: string) => ipcRenderer.invoke("ave:settings:delete-web-api-key", provider),
  setMarketplaceApiKey: async (apiKey: string) => ipcRenderer.invoke("ave:settings:marketplace:set-api-key", apiKey),
  hasMarketplaceApiKey: async () => ipcRenderer.invoke("ave:settings:marketplace:has-api-key") as Promise<boolean>,
  deleteMarketplaceApiKey: async () => ipcRenderer.invoke("ave:settings:marketplace:delete-api-key"),
  // Open an http(s) URL in the system browser. Main-side validates the
  // scheme and rejects file://, javascript:, and any other handler.
  openExternalUrl: async (url: string) =>
    ipcRenderer.invoke("ave:shell:open-external", url) as Promise<{
      ok: boolean;
      error?: string;
      protocol?: string;
      message?: string;
    }>,
  // #FU259 — MCP marketplace catalog + install
  listMcpCatalog: async () => ipcRenderer.invoke("ave:mcp:catalog:list"),
  installMcpFromMarketplace: async (slug: string) =>
    ipcRenderer.invoke("ave:mcp:install-from-marketplace", slug),
  // #FU262 — Claude Desktop config import (two-phase: preview → apply).
  previewClaudeDesktopMcpImport: async (raw: string) =>
    ipcRenderer.invoke("ave:mcp:import:claude-desktop:preview", raw),
  applyClaudeDesktopMcpImport: async (payload: { raw: string; conflictPolicy?: "skip" | "overwrite" }) =>
    ipcRenderer.invoke("ave:mcp:import:claude-desktop:apply", payload),

  notifyPluginTheme: (payload: { theme: string; chatTheme: string; codeTheme: string; tokens?: Record<string, string> }) =>
    ipcRenderer.invoke("ave:host:plugin-theme-notify", payload),

  // PR 3c: ave:lyra-mail:* IPC 채널 + bridge 메서드 제거 — lyra-mail
  // 플러그인이 자체 인증을 소유한다.

  // ─── Chat (ConversationLoop) ─────────────────────
  chatHasProvider: async () => ipcRenderer.invoke("ave:chat:has-provider") as Promise<boolean>,
  chatSend: async (input: string, attachments?: unknown[]) =>
    ipcRenderer.invoke("ave:chat:send", input, attachments),
  chatGuide: async (input: string) => ipcRenderer.invoke("ave:chat:guide", input),
  chatNew: async () => ipcRenderer.invoke("ave:chat:new"),
  chatSessions: async (opts?: { limit?: number; before?: string; beforeId?: string; after?: string }) =>
    ipcRenderer.invoke("ave:chat:sessions", opts) as Promise<{
      current: string;
      sessions: Array<{ id: string; modifiedAt: string; title: string }>;
    }>,
  chatLoadSession: async (sessionId: string) =>
    ipcRenderer.invoke("ave:chat:load-session", sessionId) as Promise<{
      ok: boolean;
      sessionId: string | null;
    }>,
  // Sprint 4.C — conversation UX
  chatGetHistory: async () =>
    ipcRenderer.invoke("ave:chat:get-history") as Promise<{ sessionId: string; messages: SerializedHistoryMessage[] }>,
  chatSessionHistory: async (sessionId: string) =>
    ipcRenderer.invoke("ave:chat:session-history", sessionId) as Promise<{
      ok: boolean;
      messages: SerializedHistoryMessage[];
      /** §457 PR-A: chars in the rolling summary preamble inherited from parent. 0 = no preamble. */
      preambleChars?: number;
      /** §457 PR-A: parent session id when this session is a rotation child. */
      parentSessionId?: string;
    }>,
  chatEditResend: async (messageIndex: number, newText: string) =>
    ipcRenderer.invoke("ave:chat:edit-resend", messageIndex, newText),
  chatFork: async (messageIndex: number) => ipcRenderer.invoke("ave:chat:fork", messageIndex),
  chatRetryEffort: async (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) =>
    ipcRenderer.invoke("ave:chat:retry-effort", opts),
  chatExport: async (format: "markdown" | "json") => ipcRenderer.invoke("ave:chat:export", format),
  chatCompact: async () => ipcRenderer.invoke("ave:chat:compact"),
  chatSessionResume: async (sessionId: string) => ipcRenderer.invoke("ave:chat:session-resume", sessionId),
  chatAbort: async () => ipcRenderer.invoke("ave:chat:abort") as Promise<{ ok: boolean }>,
  starredList: async () => ipcRenderer.invoke("ave:starred:list"),
  starredAdd: async (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) =>
    ipcRenderer.invoke("ave:starred:add", entry),
  starredRemove: async (opts: { id?: string; sessionId?: string; messageIndex?: number }) =>
    ipcRenderer.invoke("ave:starred:remove", opts),
  onChatStream: (handler: (event: { type: string; text?: string; thought?: string; name?: string; error?: string; result?: string; isError?: boolean; input?: Record<string, unknown>; groupId?: string; toolUseId?: string; displayOrder?: number; roundIndex?: number; stopReason?: "end_turn" | "tool_use"; hasToolCalls?: boolean; removedMessages?: number; freedTokens?: number; tier?: "hard-token" | "semantic-llm" | "soft-time"; revertSessionId?: string; summary?: string; turnDurationMs?: number; toolCount?: number; cumulativeToolMs?: number; tokensIn?: number; tokensOut?: number; breakdown?: Record<string, { count: number; ms: number }> }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:chat:stream", listener);
    return () => ipcRenderer.removeListener("ave:chat:stream", listener);
  },
  onChatFallback: (handler: (payload: { from: string; to: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:chat:fallback", listener);
    return () => ipcRenderer.removeListener("ave:chat:fallback", listener);
  },

  // ─── Memory ──────────────────────────────────────
  memoryListEntries: async () => ipcRenderer.invoke("ave:memory:entries:list"),
  memorySaveEntry: async (title: string, content: string) => ipcRenderer.invoke("ave:memory:entries:save", title, content),
  memoryDeleteEntry: async (filename: string) => ipcRenderer.invoke("ave:memory:entries:delete", filename),
  memorySearchEntries: async (query: string) => ipcRenderer.invoke("ave:memory:entries:search", query),
  memoryListSessions: async () => ipcRenderer.invoke("ave:memory:sessions:list"),
  memorySearchSessions: async (query: string) => ipcRenderer.invoke("ave:memory:sessions:search", query),
  memoryGetAveMd: async () => ipcRenderer.invoke("ave:memory:ave-md:get") as Promise<string>,
  memoryUpdateAveMd: async (content: string) => ipcRenderer.invoke("ave:memory:ave-md:update", content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke("ave:memory:user-prefs:get") as Promise<string>,
  memoryUpdateUserPrefs: async (content: string) => ipcRenderer.invoke("ave:memory:user-prefs:update", content),

  // ─── Plugins ─────────────────────────────────────
  listMarketplacePlugins: async () => ipcRenderer.invoke("ave:plugins:marketplace:list"),
  listPluginUiExtensions: async () => ipcRenderer.invoke("ave:plugins:ui:list"),
  // #237 — host renderer pre-binds (webContents.id → pluginId, entryUrl)
  // before each plugin webview navigates. Main rejects unknown pluginId
  // and any non-host frame.
  registerPluginWebview: async (payload: { webContentsId: number; pluginId: string; entryUrl: string }) =>
    ipcRenderer.invoke("ave:plugin:register-webview", payload) as Promise<{ ok: boolean; error?: string }>,
  readPluginUiModule: async (pluginId: string, viewId: string) =>
    ipcRenderer.invoke("ave:plugins:ui:read-module", { pluginId, viewId }) as Promise<string>,
  listPluginCards: async () => ipcRenderer.invoke("ave:plugins:cards"),
  callPluginMethod: async (method: string, payload?: unknown) => ipcRenderer.invoke("ave:plugins:call", method, payload),

  // ─── Plugin Performance (Observability) ──────────
  plugins: {
    getPerfStats: async () => ipcRenderer.invoke("ave:plugins:perf-stats"),
  },

  listRoutines: async () => ipcRenderer.invoke("ave:routines:list"),
  updateRoutine: async (
    routineId: string,
    patch: {
      enabled?: boolean;
      scheduleTimeKst?: string;
      contextPrompt?: string;
      scheduleEntries?: Array<{
        id: string;
        enabled: boolean;
        agentId: ScheduleAgentId;
        schedule: ScheduleRoutineSchedule;
        prompt: string;
      }>;
    },
  ) => ipcRenderer.invoke("ave:routines:update", routineId, patch),
  startRoutineSession: async (routineId: string) =>
    ipcRenderer.invoke("ave:routines:start-session", routineId) as Promise<{ ok: boolean; sessionId?: string; error?: string }>,
  getLatestRoutineResult: async () =>
    ipcRenderer.invoke("ave:routine:get-latest-result") as Promise<{
      routineId: string;
      trigger: string;
      summary: string;
      generatedAt: string;
    } | null>,
  triggerWakeupRoutineDev: async () =>
    ipcRenderer.invoke("ave:routines:dev-trigger-wakeup") as Promise<{ ok: boolean; summary?: string; error?: string }>,
  triggerScheduleRoutineDev: async () =>
    ipcRenderer.invoke("ave:routines:dev-trigger-schedule") as Promise<{ ok: boolean; summary?: string; error?: string }>,
  triggerShutdownRoutineDev: async () =>
    ipcRenderer.invoke("ave:routines:dev-trigger-shutdown") as Promise<{ ok: boolean; summary?: string; error?: string }>,

  // ─── Routine started event ────────────────────────────────────────────────
  onRoutineStarted: (handler: (payload: { routineId: string; trigger: string; startedAt: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:routine:started", listener);
    return () => ipcRenderer.removeListener("ave:routine:started", listener);
  },

  // ─── Usage Observability (Sprint 4.B) ────────────
  getUsageSummary: async (days?: number) => ipcRenderer.invoke("ave:usage:summary", days),
  getUsageRange: async (opts: { dateFrom: string; dateTo: string }) => ipcRenderer.invoke("ave:usage:range", opts),
  exportUsageCsv: async (rows: Array<Record<string, string | number>>) => ipcRenderer.invoke("ave:usage:export-csv", rows),

  // ─── Routine completed event (신규: RoutineResult 전달) ──────────────────
  onRoutineCompleted: (handler: (result: { routineId: string; trigger: string; summary: string; generatedAt: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:routine:completed", listener);
    return () => ipcRenderer.removeListener("ave:routine:completed", listener);
  },

  // ─── Brain — proactive trigger lifecycle ────────────────────────────────
  onTriggerStarted: (
    handler: (payload: {
      sessionId: string;
      pluginId: string;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
      startedAt: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:trigger:started", listener);
    return () => ipcRenderer.removeListener("ave:trigger:started", listener);
  },
  onTriggerCompleted: (
    handler: (result: {
      sessionId: string;
      pluginId: string;
      source: string;
      visibility: "silent" | "summary-only" | "user-visible";
      priority: "low" | "normal" | "high";
      prompt: string;
      summary: string;
      completedAt: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:trigger:completed", listener);
    return () => ipcRenderer.removeListener("ave:trigger:completed", listener);
  },
  onTriggerFailed: (
    handler: (payload: {
      sessionId: string;
      pluginId: string;
      source: string;
      reason: "provider_error" | "tool_error" | "abort" | "unknown";
      errorId: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:trigger:failed", listener);
    return () => ipcRenderer.removeListener("ave:trigger:failed", listener);
  },
  onTriggerExpired: (
    handler: (payload: { sessionId: string; pluginId: string; source: string }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:trigger:expired", listener);
    return () => ipcRenderer.removeListener("ave:trigger:expired", listener);
  },
  onTriggerImported: (
    handler: (payload: {
      sessionId: string;
      source: string;
      prompt: string;
      summary: string;
      toolCallCount: number;
      importedAt: string;
      wrappedPrompt: string;
    }) => void,
  ) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:trigger:imported", listener);
    return () => ipcRenderer.removeListener("ave:trigger:imported", listener);
  },
  dismissTrigger: async (sessionId: string) =>
    ipcRenderer.invoke("ave:trigger:dismiss", sessionId) as Promise<{
      ok: boolean;
      removed?: boolean;
      error?: string;
    }>,
  importTrigger: async (sessionId: string) =>
    ipcRenderer.invoke("ave:trigger:import", sessionId) as Promise<{
      ok: boolean;
      imported?: number;
      reason?: string;
      error?: string;
    }>,

  // ─── Marketplace update notifications (S8) ───────
  onMarketplaceUpdatesAvailable: (handler: (updates: Array<{ pluginId: string; installedVersion: string; latestVersion: string }>) => void) => {
    const listener = (_event: unknown, updates: Parameters<typeof handler>[0]) => handler(updates);
    ipcRenderer.on("marketplace:updates-available", listener);
    return () => ipcRenderer.removeListener("marketplace:updates-available", listener);
  },

  // ─── Phase 2d — managed bootstrap status ─────────
  // The host emits these around `ensureManagedInstalled()` so the renderer
  // can show a banner / toast during startup install. Three lifecycle states:
  //   - { phase: "start" }
  //   - { phase: "complete", installed[], failed[], skippedReason? }
  //   - { phase: "error", message }
  // Best-effort: the host swallows send errors, so the renderer must
  // tolerate missing events (page reload during startup, etc.).
  onBootstrapStatus: (
    handler: (status:
      | { phase: "start" }
      | { phase: "complete"; installed: string[]; failed: Array<{ id: string; error: string }>; skippedReason?: string }
      | { phase: "error"; message: string }
    ) => void,
  ) => {
    const listener = (_event: unknown, status: Parameters<typeof handler>[0]) => handler(status);
    ipcRenderer.on("ave:bootstrap:status", listener);
    return () => ipcRenderer.removeListener("ave:bootstrap:status", listener);
  },
  // Phase 2d FU — banner-driven retry. Re-emits the start/complete/error
  // status sequence so the banner subscriber updates without needing a
  // separate result channel.
  retryBootstrap: () => ipcRenderer.invoke("ave:bootstrap:retry"),

  // ─── ave:// deep-link install lifecycle ─────────
  // Fires when a marketplace install triggered via ave://install/{slug} has
  // finished installing + restartAll() in the main process. Renderer uses
  // this to refresh its plugin UI list so newly-installed sidebar views
  // appear without requiring an app restart.
  onPluginInstallResult: (handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:plugins:install-result", listener);
    return () => ipcRenderer.removeListener("ave:plugins:install-result", listener);
  },

  /**
   * Dev-only: install a plugin from a local directory (AVE_DEV=1 required).
   *
   * Return shape:
   *   - `null` — the user cancelled the folder picker. NOT an error.
   *   - `{ pluginId, installed: true }` — install succeeded.
   *   - throws — auth/dev-mode/IO error. Callers should surface this as a
   *     toast/alert rather than collapsing it into `null`, otherwise users
   *     can't distinguish "didn't run" from "ran but failed". See
   *     `installLocal` in `src/plugins/marketplace.ts` for the error
   *     producer side.
   */
  installLocalPlugin: async () => {
    const r = await ipcRenderer.invoke("ave:plugins:install-local") as
      | { pluginId: string; installed: true }
      | { ok: false; error: string }
      | null;
    if (!r) return null; // user cancelled the folder picker
    if ("ok" in r) {
      throw new Error(`installLocalPlugin: ${r.error}`);
    }
    return r;
  },

  // Sibling of onPluginInstallResult — fires after PluginConfigTab or any
  // other surface drives uninstall through the IPC handler. Renderer uses
  // this to drop the removed plugin's sidebar tab + marketplace card.
  onPluginUninstallResult: (handler: (payload: { slug: string; success: boolean; error?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:plugins:uninstall-result", listener);
    return () => ipcRenderer.removeListener("ave:plugins:uninstall-result", listener);
  },

  // Phase progress for in-flight installs. Granular phases fire from inside
  // installFromMarketplace: downloading (byte-level) → verifying → registering.
  // The callers (handleAveUri, ave:plugins:install) emit `installing` at the
  // start and `restarting` after the install completes. The result event clears
  // the in-flight state. Renderer renders a skeleton card / sidebar placeholder.
  onPluginInstallProgress: (handler: (payload:
    | { slug: string; phase: "installing" | "restarting" | "verifying" | "registering" }
    | { slug: string; phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  ) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:plugins:install-progress", listener);
    return () => ipcRenderer.removeListener("ave:plugins:install-progress", listener);
  },

  // Status bar — aggregated runtime counters (tools / plugins / mcps).
  getRuntimeCounts: async () =>
    ipcRenderer.invoke("ave:runtime:counts") as Promise<{
      tools: number;
      plugins: number;
      mcps: number;
    }>,
  // Status bar — static environment info (platform / hostname / user).
  // Static enough to fetch once on mount; values don't change while the
  // process is alive. Cwd is intentionally NOT exposed — least-privilege
  // for plugin UI panels that share this contextBridge.
  getRuntimeEnv: async () =>
    ipcRenderer.invoke("ave:runtime:env") as Promise<{
      platform: string;
      hostname: string;
      user: string;
    }>,
  // Status bar — marketplace reachability probe. Returns `configured: false`
  // when the user is on the mock backend (nothing to ping).
  pingMarketplace: async () =>
    ipcRenderer.invoke("ave:marketplace:ping") as Promise<{
      configured: boolean;
      online: boolean;
    }>,

  // ─── Plugin Events (§35 real-time streaming) ─────
  onPluginEvent: (
    eventType: string,
    handler: (data: unknown) => void,
  ): (() => void) => {
    // Reject subscriptions to private-namespace events at the preload boundary.
    // PLUGIN_PRIVATE_NAMESPACES entries are dot-separated prefixes; an event
    // type matches when it equals a namespace or starts with "<namespace>.".
    // This prevents renderer code from subscribing to sensitive host state
    // (memory contents, secrets, audit trails, DLP decisions) even if the IPC
    // channel delivers them. Mirrors capability enforcement in
    // plugins/capabilities.ts.
    const isPrivate = [...PLUGIN_PRIVATE_NAMESPACES].some(
      (ns) => eventType === ns || eventType.startsWith(`${ns}.`),
    );
    if (isPrivate) {
      // Return a no-op unsubscribe — the subscription is silently rejected.
      return () => undefined;
    }
    const listener = (_event: unknown, type: string, data: unknown) => {
      if (type === eventType) handler(data);
    };
    ipcRenderer.on("ave:plugin:event", listener);
    return () => ipcRenderer.removeListener("ave:plugin:event", listener);
  },

  // ─── MCP ─────────────────────────────────────────
  mcp: {
    servers: async () => ipcRenderer.invoke("ave:mcp:servers"),
    kill: async (id: string) => ipcRenderer.invoke("ave:mcp:kill", id),
    getConfigs: async () => ipcRenderer.invoke("ave:mcp:config:get"),
    getConfigPath: async () => ipcRenderer.invoke("ave:mcp:config:path"),
    addConfig: async (config: McpServerConfig) => ipcRenderer.invoke("ave:mcp:config:add", config),
    removeConfig: async (id: string) => ipcRenderer.invoke("ave:mcp:config:remove", id),
    readUiResource: async (serverId: string, uri: string) => ipcRenderer.invoke("ave:mcp:ui-resource", serverId, uri) as Promise<string>,
  },

  // ─── Permission ───────────────────────────────────
  permission: {
    getMode: async () => ipcRenderer.invoke("ave:permission:get-mode"),
    setMode: async (mode: string) => ipcRenderer.invoke("ave:permission:set-mode", mode),
    listRules: async () => ipcRenderer.invoke("ave:permission:list-rules"),
    addRule: async (pattern: string, action: string) =>
      ipcRenderer.invoke("ave:permission:add-rule", pattern, action),
    removeRule: async (pattern: string, action: string) =>
      ipcRenderer.invoke("ave:permission:remove-rule", pattern, action),
  },

  // ─── Policy (Governance) ─────────────────────────
  policy: {
    get: async () => ipcRenderer.invoke("ave:policy:get"),
    set: async (patch: unknown) => ipcRenderer.invoke("ave:policy:set", patch),
  },

  // ─── Approval Gate (§6.3 Layer 3 + §8) ─────────
  approval: {
    /** main→renderer 단방향 이벤트 구독 */
    onRequest: (cb: (req: unknown) => void) => {
      const listener = (_event: unknown, req: unknown) => cb(req);
      ipcRenderer.on("ave:approval:request", listener);
      return () => ipcRenderer.removeListener("ave:approval:request", listener);
    },
    /** 사용자 결정을 main으로 전송 */
    respond: async (decision: unknown) =>
      ipcRenderer.invoke("ave:approval:respond", decision),
  },

  // ─── DLP Hit Statistics (Observability) ─────────
  dlp: {
    getStats: async (days: number) => ipcRenderer.invoke("ave:dlp:stats", days),
  },

  // ─── Audit Log Search (Observability) ────────────
  audit: {
    search: async (filter: {
      dateFrom?: string;
      dateTo?: string;
      type?: string;
      textSearch?: string;
      limit?: number;
      offset?: number;
    }) => ipcRenderer.invoke("ave:audit:search", filter),
    getStats: async (lastDays: number) => ipcRenderer.invoke("ave:audit:stats", lastDays),
  },

  // ─── D6 — Message feedback ───────────────────────
  submitFeedback: async (payload: { sessionId: string; messageIndex: number; rating: "up" | "down"; reason?: string }) =>
    ipcRenderer.invoke("ave:feedback:submit", payload) as Promise<{ ok: boolean; error?: string }>,

  // ─── D7 — file drag & drop indexing ───────────────
  fileScanPaths: async (paths: string[]) =>
    ipcRenderer.invoke("ave:file:scan-paths", { paths }) as Promise<{ ok: boolean; indexed?: number; failed?: number; jobId?: string; error?: string }>,

  // ─── View Events ─────────────────────────────────
  onViewActivate: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string }) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("ave:view:activate", listener);
    return () => ipcRenderer.removeListener("ave:view:activate", listener);
  },

  // ─── Workflow tools (S1+S2) ──────────────────────
  // ask_user_question — main process pushes inline question requests; the
  // renderer card resolves via the respond channel.
  onAskUserQuestion: (
    handler: (req: {
      id: string;
      questions: Array<{
        question: string;
        choices?: string[];
        allowFreeText: boolean;
        suggestedAnswers?: string[];
      }>;
      createdAt: number;
    }) => void,
  ) => {
    const listener = (_e: unknown, req: Parameters<typeof handler>[0]) => handler(req);
    ipcRenderer.on("ave:ask-user-question:request", listener);
    return () => ipcRenderer.removeListener("ave:ask-user-question:request", listener);
  },
  respondAskUserQuestion: async (response: {
    requestId: string;
    answers?: Array<{ choice?: string; freeText?: string }>;
    dismissed?: boolean;
  }) => ipcRenderer.invoke("ave:ask-user-question:respond", response),
  // M2: timeout side-channel — main process notifies the renderer when an
  // ask_user_question request expired (5 min default) so the card can drop
  // the stale prompt before the user clicks into a no-op.
  onAskUserQuestionTimeout: (
    handler: (payload: { requestId: string }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on("ave:ask-user-question:timeout", listener);
    return () => ipcRenderer.removeListener("ave:ask-user-question:timeout", listener);
  },

  // remind_at — persistent reminder list + lifecycle
  listReminders: async () => ipcRenderer.invoke("ave:reminders:list"),
  dismissReminder: async (id: string) => ipcRenderer.invoke("ave:reminders:dismiss", id),
  removeReminder: async (id: string) => ipcRenderer.invoke("ave:reminders:remove", id),
  onReminderFired: (
    handler: (reminder: {
      id: string;
      at: string;
      title: string;
      body?: string;
      repeat: "daily" | "weekly" | "none";
    }) => void,
  ) => {
    const listener = (_e: unknown, r: Parameters<typeof handler>[0]) => handler(r);
    ipcRenderer.on("ave:reminder:fired", listener);
    return () => ipcRenderer.removeListener("ave:reminder:fired", listener);
  },

  // todo_session_write — assistant's per-session checklist
  listSessionTodos: async (sessionId?: string) =>
    ipcRenderer.invoke("ave:session-todo:list", sessionId),
  onSessionTodoChanged: (
    handler: (payload: {
      sessionId: string;
      items: Array<{ id: string; content: string; status: string }>;
    }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on("ave:session-todo:changed", listener);
    return () => ipcRenderer.removeListener("ave:session-todo:changed", listener);
  },

  // agent_spawn — sub-agent lifecycle event stream
  onAgentSpawnEvent: (
    handler: (event: {
      spawnId: string;
      type: "start" | "turn" | "done" | "error";
      title?: string;
      turn?: number;
      text?: string;
      summary?: string;
      toolCallCount?: number;
      message?: string;
      toolUseId?: string;
    }) => void,
  ) => {
    const listener = (_e: unknown, ev: Parameters<typeof handler>[0]) => handler(ev);
    ipcRenderer.on("ave:agent-spawn:event", listener);
    return () => ipcRenderer.removeListener("ave:agent-spawn:event", listener);
  },

  // skill_load — chat-side badge event
  onSkillLoaded: (
    handler: (event: {
      name: string;
      description: string;
      source: "user" | "builtin";
    }) => void,
  ) => {
    const listener = (_e: unknown, ev: Parameters<typeof handler>[0]) => handler(ev);
    ipcRenderer.on("ave:skill-load:event", listener);
    return () => ipcRenderer.removeListener("ave:skill-load:event", listener);
  },

  // ─── Notifications (#260) ────────────────────────
  // Main process pushes in-app toast payloads when the window is focused;
  // OS notifications fire when backgrounded/minimized. Renderer also signals
  // back when an in-app toast / OS notification is clicked so main can focus
  // the window and the renderer can scroll/navigate to the source surface.
  onNotificationToast: (
    handler: (payload: {
      kind: "turn-end" | "routine" | "ask-user" | "approval";
      title: string;
      body: string;
      contextRef?: {
        sessionId?: string;
        routineId?: string;
        questionId?: string;
        approvalId?: string;
      };
    }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on("ave:notification:toast", listener);
    return () => ipcRenderer.removeListener("ave:notification:toast", listener);
  },
  onNotificationClicked: (
    handler: (payload: {
      kind: "turn-end" | "routine" | "ask-user" | "approval";
      contextRef?: {
        sessionId?: string;
        routineId?: string;
        questionId?: string;
        approvalId?: string;
      };
    }) => void,
  ) => {
    const listener = (_e: unknown, p: Parameters<typeof handler>[0]) => handler(p);
    ipcRenderer.on("ave:notification:clicked", listener);
    return () => ipcRenderer.removeListener("ave:notification:clicked", listener);
  },
  notifyClick: async (payload: {
    kind: "turn-end" | "routine" | "ask-user" | "approval";
    contextRef?: {
      sessionId?: string;
      routineId?: string;
      questionId?: string;
      approvalId?: string;
    };
  }) => ipcRenderer.invoke("ave:notification:clicked", payload),

  // ─── Window management (tab detach + magnetic snap) ──────────────────────
  window: {
    /** Open viewKey in a new detached BrowserWindow. */
    openDetached: async (viewKey: string) =>
      ipcRenderer.invoke("ave:window:open-detached", viewKey) as Promise<
        { ok: true; windowId: number } | { ok: false; error: string }
      >,
    /** Close the current detached window (no-op in main window). */
    closeDetached: async () =>
      ipcRenderer.invoke("ave:window:close-detached") as Promise<{ ok: true } | { ok: false; error: string }>,
    /** List all currently open detached windows. */
    listDetached: async () =>
      ipcRenderer.invoke("ave:window:list-detached") as Promise<
        Array<{ windowId: number; viewKey: string; snapped: boolean }>
      >,
    /**
     * Subscribe to snap-edge highlight events sent from the main process
     * when a child window enters/exits the snap zone.
     * edge: "n"|"s"|"e"|"w" when entering, null when leaving.
     */
    onSnapEdge: (handler: (edge: "n" | "s" | "e" | "w" | null) => void) => {
      const listener = (_event: unknown, edge: "n" | "s" | "e" | "w" | null) => handler(edge);
      ipcRenderer.on("ave:window:snap-edge", listener);
      return () => ipcRenderer.removeListener("ave:window:snap-edge", listener);
    },
    /**
     * Subscribe to in-place navigation events sent by WindowManager when a
     * second plugin is clicked while the detached shell is already open.
     * The detached shell calls this to swap its displayed content without
     * closing and reopening a window.
     */
    onDetachedNavigate: (handler: (viewKey: string) => void) => {
      const listener = (_event: unknown, payload: { viewKey?: string }) => {
        if (typeof payload?.viewKey === "string") handler(payload.viewKey);
      };
      ipcRenderer.on("ave:detached:navigate", listener);
      return () => ipcRenderer.removeListener("ave:detached:navigate", listener);
    },
  },
};

contextBridge.exposeInMainWorld("aveApi", api);

let hostMarketplaceApiClaimed = false;
contextBridge.exposeInMainWorld("aveHost", {
  takePluginMarketplaceApi: () => {
    if (hostMarketplaceApiClaimed) return null;
    hostMarketplaceApiClaimed = true;
    return {
      installMarketplacePlugin: async (pluginId: string) =>
        normalizePluginActionResult(await ipcRenderer.invoke("ave:plugins:install", pluginId)),
      uninstallMarketplacePlugin: async (pluginId: string) =>
        normalizePluginActionResult(await ipcRenderer.invoke("ave:plugins:uninstall", pluginId)),
    };
  },
});

// ─── Window control bridge (custom titlebar) ─────────────────────────────
// Exposed unconditionally so the renderer can branch at runtime.
// On macOS the windowControl methods are never called (traffic lights
// are OS-managed). isDarwin lets the renderer suppress Win/Linux buttons.
contextBridge.exposeInMainWorld("avePlatform", {
  isDarwin: process.platform === "darwin",
});
contextBridge.exposeInMainWorld("aveWindow", {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  close: () => ipcRenderer.invoke("window:close"),
  syncTitleBarTheme: (color: string, symbolColor: string) =>
    ipcRenderer.invoke("window:syncTitleBarTheme", { color, symbolColor }),
  onMaximizedChanged: (handler: (maximized: boolean) => void) => {
    const listener = (_event: unknown, maximized: boolean) => handler(maximized);
    ipcRenderer.on("window:maximizedChanged", listener);
    return () => ipcRenderer.removeListener("window:maximizedChanged", listener);
  },
  onFullscreenChanged: (handler: (fullscreen: boolean) => void) => {
    const listener = (_event: unknown, fullscreen: boolean) => handler(fullscreen);
    ipcRenderer.on("window:fullscreenChanged", listener);
    return () => ipcRenderer.removeListener("window:fullscreenChanged", listener);
  },
});

// ─── ave 네임스페이스 (B1: Approval Gate + Permission) ──
// renderer에서 window.ave.approval / window.ave.permission으로 접근
contextBridge.exposeInMainWorld("ave", {
  permission: api.permission,
  approval: api.approval,
  policy: api.policy,
  mcp: api.mcp,
  plugins: {
    cards: () => ipcRenderer.invoke("ave:plugins:cards"),
  },
  pluginConfig: {
    get: (pluginId: string) => ipcRenderer.invoke("ave:plugins:config:get", pluginId),
    set: (pluginId: string, config: Record<string, unknown>) => ipcRenderer.invoke("ave:plugins:config:set", pluginId, config),
    getSchema: (pluginId: string) => ipcRenderer.invoke("ave:plugins:config:schema:get", pluginId),
    setSecret: (pluginId: string, key: string, value: string) =>
      ipcRenderer.invoke("ave:plugins:config:secret:set", pluginId, key, value),
    // US-3c.1: batch secret-presence query — returns keys for which the
    // keychain holds a value. Fewer IPC round-trips than per-key checks.
    listSecretKeys: (pluginId: string) =>
      ipcRenderer.invoke("ave:plugins:config:secret:list-keys", pluginId),
  },
  env: {
    isDev: process.env.AVE_DEV === "1",
    enableDevConsole: process.env.AVE_DEV_CONSOLE === "1",
    debugStream:
      process.env.VITE_DEBUG_STREAM === "1" ||
      (process.env.AVE_DEV === "1" && process.env.AVE_DEV_CONSOLE === "1"),
  },
  attach: {
    openFile: () => ipcRenderer.invoke("ave:attach:openFile"),
    readImage: (filePath: string) =>
      ipcRenderer.invoke("ave:attach:readImage", filePath),
    saveClipboardImage: (base64: string) =>
      ipcRenderer.invoke("ave:attach:saveClipboardImage", { base64 }),
    openExternal: (filePath: string) =>
      ipcRenderer.invoke("ave:attach:openExternal", filePath),
  },
});
