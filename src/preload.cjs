const { contextBridge, ipcRenderer } = require("electron");

const api = {
  // Settings
  getSettings: async () => ipcRenderer.invoke("ave:settings:get"),
  updateSettings: async (partial) => ipcRenderer.invoke("ave:settings:update", partial),
  setApiKey: async (vendor, apiKey) => ipcRenderer.invoke("ave:settings:set-api-key", vendor, apiKey),
  hasApiKey: async (vendor) => ipcRenderer.invoke("ave:settings:has-api-key", vendor),
  deleteApiKey: async (vendor) => ipcRenderer.invoke("ave:settings:delete-api-key", vendor),
  setWebApiKey: async (provider, apiKey) => ipcRenderer.invoke("ave:settings:set-web-api-key", provider, apiKey),
  hasWebApiKey: async (provider) => ipcRenderer.invoke("ave:settings:has-web-api-key", provider),
  deleteWebApiKey: async (provider) => ipcRenderer.invoke("ave:settings:delete-web-api-key", provider),

  // Chat (ConversationLoop)
  chatHasProvider: async () => ipcRenderer.invoke("ave:chat:has-provider"),
  chatSend: async (input) => ipcRenderer.invoke("ave:chat:send", input),
  chatNew: async () => ipcRenderer.invoke("ave:chat:new"),
  onChatStream: (handler) => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on("ave:chat:stream", listener);
    return () => ipcRenderer.removeListener("ave:chat:stream", listener);
  },

  // Memory
  memoryListNotes: async () => ipcRenderer.invoke("ave:memory:notes:list"),
  memorySaveNote: async (title, content) => ipcRenderer.invoke("ave:memory:notes:save", title, content),
  memoryDeleteNote: async (filename) => ipcRenderer.invoke("ave:memory:notes:delete", filename),
  memorySearchNotes: async (query) => ipcRenderer.invoke("ave:memory:notes:search", query),
  memoryGetAveMd: async () => ipcRenderer.invoke("ave:memory:ave-md:get"),
  memoryUpdateAveMd: async (content) => ipcRenderer.invoke("ave:memory:ave-md:update", content),
  memoryGetUserPrefs: async () => ipcRenderer.invoke("ave:memory:user-prefs:get"),
  memoryUpdateUserPrefs: async (content) => ipcRenderer.invoke("ave:memory:user-prefs:update", content),

  // Plugins
  listMarketplacePlugins: async () => ipcRenderer.invoke("ave:plugins:marketplace:list"),
  installMarketplacePlugin: async (pluginId) => ipcRenderer.invoke("ave:plugins:install", pluginId),
  uninstallMarketplacePlugin: async (pluginId) => ipcRenderer.invoke("ave:plugins:uninstall", pluginId),
  listPluginUiExtensions: async () => ipcRenderer.invoke("ave:plugins:ui:list"),
  callPluginMethod: async (method, payload) => ipcRenderer.invoke("ave:plugins:call", method, payload),

  // Tasks
  addTask: async (task) => ipcRenderer.invoke("ave:tasks:add", task),
  queryTasks: async (filter) => ipcRenderer.invoke("ave:tasks:query", filter),
  updateTask: async (id, patch) => ipcRenderer.invoke("ave:tasks:update", id, patch),
  deleteTask: async (id) => ipcRenderer.invoke("ave:tasks:delete", id),
  getTodayTasks: async () => ipcRenderer.invoke("ave:tasks:today"),
  getOverdueTasks: async () => ipcRenderer.invoke("ave:tasks:overdue"),

  // View Events
  onViewActivate: (handler) => {
    const listener = (_event, payload) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("ave:view:activate", listener);
    return () => ipcRenderer.removeListener("ave:view:activate", listener);
  },
};

contextBridge.exposeInMainWorld("aveApi", api);
