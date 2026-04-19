import electron from "electron";

const { contextBridge, ipcRenderer } = electron;

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

  // ─── Chat (ConversationLoop) ─────────────────────
  chatHasProvider: async () => ipcRenderer.invoke("ave:chat:has-provider") as Promise<boolean>,
  chatSend: async (input: string) => ipcRenderer.invoke("ave:chat:send", input),
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

  // ─── Memory ──────────────────────────────────────
  memoryListNotes: async () => ipcRenderer.invoke("ave:memory:notes:list"),
  memorySaveNote: async (title: string, content: string) => ipcRenderer.invoke("ave:memory:notes:save", title, content),
  memoryDeleteNote: async (filename: string) => ipcRenderer.invoke("ave:memory:notes:delete", filename),
  memorySearchNotes: async (query: string) => ipcRenderer.invoke("ave:memory:notes:search", query),
  memoryGetAveMd: async () => ipcRenderer.invoke("ave:memory:ave-md:get") as Promise<string>,
  memoryUpdateAveMd: async (content: string) => ipcRenderer.invoke("ave:memory:ave-md:update", content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke("ave:memory:user-prefs:get") as Promise<string>,
  memoryUpdateUserPrefs: async (content: string) => ipcRenderer.invoke("ave:memory:user-prefs:update", content),

  // ─── Plugins ─────────────────────────────────────
  listMarketplacePlugins: async () => ipcRenderer.invoke("ave:plugins:marketplace:list"),
  installMarketplacePlugin: async (pluginId: string) => ipcRenderer.invoke("ave:plugins:install", pluginId),
  uninstallMarketplacePlugin: async (pluginId: string) => ipcRenderer.invoke("ave:plugins:uninstall", pluginId),
  listPluginUiExtensions: async () => ipcRenderer.invoke("ave:plugins:ui:list"),
  listPluginCards: async () => ipcRenderer.invoke("ave:plugins:cards"),
  callPluginMethod: async (method: string, payload?: unknown) => ipcRenderer.invoke("ave:plugins:call", method, payload),

  // ─── Tasks ───────────────────────────────────────
  addTask: async (task: unknown) => ipcRenderer.invoke("ave:tasks:add", task),
  queryTasks: async (filter?: unknown) => ipcRenderer.invoke("ave:tasks:query", filter),
  updateTask: async (id: string, patch: unknown) => ipcRenderer.invoke("ave:tasks:update", id, patch),
  deleteTask: async (id: string) => ipcRenderer.invoke("ave:tasks:delete", id),
  getTodayTasks: async () => ipcRenderer.invoke("ave:tasks:today"),
  getOverdueTasks: async () => ipcRenderer.invoke("ave:tasks:overdue"),

  // ─── Daily Briefing ──────────────────────────────
  getBriefing: async () => ipcRenderer.invoke("ave:briefing:get"),

  // ─── Usage Observability (Sprint 4.B) ────────────
  getUsageSummary: async (days?: number) => ipcRenderer.invoke("ave:usage:summary", days),

  // ─── Proactive (Sprint 3-A: briefing card + snooze/dismiss) ───
  onProactiveBriefing: (handler: (briefing: { generatedAt: string; items: Array<{ category: string; priority: string; title: string; detail?: string }>; summary?: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on("ave:proactive:briefing", listener);
    return () => ipcRenderer.removeListener("ave:proactive:briefing", listener);
  },
  dismissBriefing: async (feedback?: { reason: string; details?: string }) =>
    ipcRenderer.invoke("ave:proactive:dismiss-briefing", feedback) as Promise<{ ok: boolean; debounced?: boolean }>,
  snoozeBriefing: async () => ipcRenderer.invoke("ave:proactive:snooze-briefing") as Promise<{ ok: boolean; lastDismissedAt?: string }>,

  // ─── Marketplace update notifications (S8) ───────
  onMarketplaceUpdatesAvailable: (handler: (updates: Array<{ pluginId: string; installedVersion: string; latestVersion: string }>) => void) => {
    const listener = (_event: unknown, updates: Parameters<typeof handler>[0]) => handler(updates);
    ipcRenderer.on("marketplace:updates-available", listener);
    return () => ipcRenderer.removeListener("marketplace:updates-available", listener);
  },

  // ─── MCP ─────────────────────────────────────────
  mcp: {
    servers: async () => ipcRenderer.invoke("ave:mcp:servers"),
    kill: async (id: string) => ipcRenderer.invoke("ave:mcp:kill", id),
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

  // ─── View Events ─────────────────────────────────
  onViewActivate: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string }) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("ave:view:activate", listener);
    return () => ipcRenderer.removeListener("ave:view:activate", listener);
  },
};

contextBridge.exposeInMainWorld("aveApi", api);

// ─── ave 네임스페이스 (B1: Approval Gate + Permission) ──
// renderer에서 window.ave.approval / window.ave.permission으로 접근
contextBridge.exposeInMainWorld("ave", {
  permission: api.permission,
  approval: api.approval,
  policy: api.policy,
});
