const { contextBridge, ipcRenderer } = require("electron");

const api = {
  scanIndex: async () => ipcRenderer.invoke("ave:index:scan"),
  listDocuments: async () => ipcRenderer.invoke("ave:index:documents"),
  chatPreview: async (question) => ipcRenderer.invoke("ave:chat:preview", question),
  startMeeting: async (sessionId, context) => ipcRenderer.invoke("ave:meeting:start", sessionId, context),
  pushMeetingChunk: async (sessionId, chunk) => ipcRenderer.invoke("ave:meeting:push-chunk", sessionId, chunk),
  stopMeeting: async (sessionId) => ipcRenderer.invoke("ave:meeting:stop", sessionId),
  getMeetingTranscript: async (sessionId) => ipcRenderer.invoke("ave:meeting:transcript", sessionId),
  listMarketplacePlugins: async () => ipcRenderer.invoke("ave:plugins:marketplace:list"),
  installMarketplacePlugin: async (pluginId) => ipcRenderer.invoke("ave:plugins:install", pluginId),
  listPluginUiExtensions: async () => ipcRenderer.invoke("ave:plugins:ui:list"),
  callPluginMethod: async (method, payload) => ipcRenderer.invoke("ave:plugins:call", method, payload),
  onViewActivate: (handler) => {
    const listener = (_event, payload) => handler(payload?.viewKey ?? "home");
    ipcRenderer.on("ave:view:activate", listener);
    return () => ipcRenderer.removeListener("ave:view:activate", listener);
  },
};

contextBridge.exposeInMainWorld("aveApi", api);
