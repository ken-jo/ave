import electron from "electron";
import type { McpServerConfig } from "./mcp/types.js";
import type { ScheduleAgentId, ScheduleRoutineSchedule } from "./routines/schedule.js";

const { contextBridge, ipcRenderer } = electron;

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
  // ─── Settings ────────────────────────────────────
  getSettings: async () => ipcRenderer.invoke("ave:settings:get"),
  updateSettings: async (partial: unknown) => ipcRenderer.invoke("ave:settings:update", partial),
  setApiKey: async (vendor: string, apiKey: string) => ipcRenderer.invoke("ave:settings:set-api-key", vendor, apiKey),
  hasApiKey: async (vendor?: string) => ipcRenderer.invoke("ave:settings:has-api-key", vendor) as Promise<boolean>,
  deleteApiKey: async (vendor: string) => ipcRenderer.invoke("ave:settings:delete-api-key", vendor),
  setWebApiKey: async (provider: string, apiKey: string) => ipcRenderer.invoke("ave:settings:set-web-api-key", provider, apiKey),
  hasWebApiKey: async (provider: string) => ipcRenderer.invoke("ave:settings:has-web-api-key", provider) as Promise<boolean>,
  deleteWebApiKey: async (provider: string) => ipcRenderer.invoke("ave:settings:delete-web-api-key", provider),

  // ─── Microsoft Graph — dual-environment login ────
  lyraMailGetState: async () =>
    ipcRenderer.invoke("ave:lyra-mail:get-state") as Promise<{
      environment: "external" | "corporate";
      isAuthenticated: boolean;
      account: string | null;
      configured: boolean;
      label: string;
      environments: Array<{
        id: "external" | "corporate";
        label: string;
        description: string;
        configured: boolean;
      }>;
    }>,
  lyraMailSwitchEnvironment: async (env: "external" | "corporate") =>
    ipcRenderer.invoke("ave:lyra-mail:switch-environment", env) as Promise<{
      ok: boolean;
      state?: unknown;
    }>,
  lyraMailSignIn: async () =>
    ipcRenderer.invoke("ave:lyra-mail:sign-in") as Promise<{
      ok: boolean;
      error?: string;
      state?: unknown;
    }>,
  lyraMailSignOut: async () =>
    ipcRenderer.invoke("ave:lyra-mail:sign-out") as Promise<{
      ok: boolean;
      state?: unknown;
    }>,

  // ─── Chat (ConversationLoop) ─────────────────────
  chatHasProvider: async () => ipcRenderer.invoke("ave:chat:has-provider") as Promise<boolean>,
  chatSend: async (input: string) => ipcRenderer.invoke("ave:chat:send", input),
  chatGuide: async (input: string) => ipcRenderer.invoke("ave:chat:guide", input),
  chatNew: async () => ipcRenderer.invoke("ave:chat:new"),
  chatSessions: async () =>
    ipcRenderer.invoke("ave:chat:sessions") as Promise<{
      current: string;
      sessions: Array<{ id: string; modifiedAt: string }>;
    }>,
  chatLoadSession: async (sessionId: string) =>
    ipcRenderer.invoke("ave:chat:load-session", sessionId) as Promise<{
      ok: boolean;
      sessionId: string | null;
    }>,
  // Sprint 4.C — conversation UX
  chatGetHistory: async () => ipcRenderer.invoke("ave:chat:get-history"),
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
  onChatStream: (handler: (event: { type: string; text?: string; thought?: string; name?: string; error?: string; result?: string; isError?: boolean; input?: Record<string, unknown>; groupId?: string; toolUseId?: string; displayOrder?: number; roundIndex?: number; stopReason?: "end_turn" | "tool_use"; hasToolCalls?: boolean }) => void) => {
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
  readPluginUiModule: async (pluginId: string, viewId: string) =>
    ipcRenderer.invoke("ave:plugins:ui:read-module", { pluginId, viewId }) as Promise<string>,
  listPluginCards: async () => ipcRenderer.invoke("ave:plugins:cards"),
  callPluginMethod: async (method: string, payload?: unknown) => ipcRenderer.invoke("ave:plugins:call", method, payload),

  // ─── Plugin Performance (Observability) ──────────
  plugins: {
    getPerfStats: async () => ipcRenderer.invoke("ave:plugins:perf-stats"),
  },

  // ─── Tasks ───────────────────────────────────────
  addTask: async (task: unknown) => ipcRenderer.invoke("ave:tasks:add", task),
  queryTasks: async (filter?: unknown) => ipcRenderer.invoke("ave:tasks:query", filter),
  updateTask: async (id: string, patch: unknown) => ipcRenderer.invoke("ave:tasks:update", id, patch),
  deleteTask: async (id: string) => ipcRenderer.invoke("ave:tasks:delete", id),
  getTodayTasks: async () => ipcRenderer.invoke("ave:tasks:today"),
  getOverdueTasks: async () => ipcRenderer.invoke("ave:tasks:overdue"),

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

  // ─── Marketplace update notifications (S8) ───────
  onMarketplaceUpdatesAvailable: (handler: (updates: Array<{ pluginId: string; installedVersion: string; latestVersion: string }>) => void) => {
    const listener = (_event: unknown, updates: Parameters<typeof handler>[0]) => handler(updates);
    ipcRenderer.on("marketplace:updates-available", listener);
    return () => ipcRenderer.removeListener("marketplace:updates-available", listener);
  },

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

  // ─── Plugin Events (§35 real-time streaming) ─────
  onPluginEvent: (
    eventType: string,
    handler: (data: unknown) => void,
  ): (() => void) => {
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

  // ─── D7 — PageIndex drag & drop ──────────────────
  pageindexScanPaths: async (paths: string[]) =>
    ipcRenderer.invoke("ave:pageindex:scan-paths", { paths }) as Promise<{ ok: boolean; indexed?: number; failed?: number; jobId?: string; error?: string }>,

  // ─── View Events ─────────────────────────────────
  onViewActivate: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string }) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("ave:view:activate", listener);
    return () => ipcRenderer.removeListener("ave:view:activate", listener);
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
  },
  env: {
    isDev: process.env.AVE_DEV === "1",
    enableDevConsole: process.env.AVE_ENABLE_DEV_CONSOLE === "1",
  },
});
