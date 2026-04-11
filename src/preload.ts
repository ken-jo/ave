import { contextBridge, ipcRenderer } from "electron";

const api = {
  // ─── Settings ────────────────────────────────────
  getSettings: async () => ipcRenderer.invoke("ave:settings:get"),
  updateSettings: async (partial: unknown) => ipcRenderer.invoke("ave:settings:update", partial),
  setApiKey: async (vendor: string, apiKey: string) => ipcRenderer.invoke("ave:settings:set-api-key", vendor, apiKey),
  hasApiKey: async (vendor?: string) => ipcRenderer.invoke("ave:settings:has-api-key", vendor) as Promise<boolean>,
  deleteApiKey: async (vendor: string) => ipcRenderer.invoke("ave:settings:delete-api-key", vendor),

  // ─── Chat (ConversationLoop) ─────────────────────
  chatHasProvider: async () => ipcRenderer.invoke("ave:chat:has-provider") as Promise<boolean>,
  chatSend: async (input: string) => ipcRenderer.invoke("ave:chat:send", input),
  chatNew: async () => ipcRenderer.invoke("ave:chat:new"),
  onChatStream: (handler: (event: { type: string; text?: string; name?: string; error?: string; result?: string; isError?: boolean }) => void) => {
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
  callPluginMethod: async (method: string, payload?: unknown) => ipcRenderer.invoke("ave:plugins:call", method, payload),

  // ─── Tasks ───────────────────────────────────────
  addTask: async (task: unknown) => ipcRenderer.invoke("ave:tasks:add", task),
  queryTasks: async (filter?: unknown) => ipcRenderer.invoke("ave:tasks:query", filter),
  updateTask: async (id: string, patch: unknown) => ipcRenderer.invoke("ave:tasks:update", id, patch),
  deleteTask: async (id: string) => ipcRenderer.invoke("ave:tasks:delete", id),
  getTodayTasks: async () => ipcRenderer.invoke("ave:tasks:today"),
  getOverdueTasks: async () => ipcRenderer.invoke("ave:tasks:overdue"),

  // ─── View Events ─────────────────────────────────
  onViewActivate: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string }) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("ave:view:activate", listener);
    return () => ipcRenderer.removeListener("ave:view:activate", listener);
  },
};

contextBridge.exposeInMainWorld("aveApi", api);
