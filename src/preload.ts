import { contextBridge, ipcRenderer } from "electron";

const api = {
  scanIndex: async () => ipcRenderer.invoke("ave:index:scan") as Promise<{ scanned: number; indexed: number }>,
  listDocuments: async () =>
    ipcRenderer.invoke("ave:index:documents") as Promise<
      Array<{ id: string; doc_name: string; type: string; path: string; line_count?: number; page_count?: number }>
    >,
  chatPreview: async (question: string) =>
    ipcRenderer.invoke("ave:chat:preview", question) as Promise<{
      question: string;
      documentCount: number;
      documentName?: string;
      preview: string;
    }>,
  startMeeting: async (
    sessionId: string,
    context?: { locale?: string; contextHint?: string; participants?: string[] },
  ) => ipcRenderer.invoke("ave:meeting:start", sessionId, context) as Promise<{ sessionId: string; started: true }>,
  pushMeetingChunk: async (
    sessionId: string,
    chunk: { pcm16leMono: number[]; sampleRate: number; startSec: number; endSec: number },
  ) =>
    ipcRenderer.invoke("ave:meeting:push-chunk", sessionId, chunk) as Promise<{ sessionId: string; added: number }>,
  stopMeeting: async (sessionId: string) =>
    ipcRenderer.invoke("ave:meeting:stop", sessionId) as Promise<{
      title: string;
      summary: string;
      highlights: string[];
      actionItems: string[];
      createdAt: string;
    }>,
  getMeetingTranscript: async (sessionId: string) =>
    ipcRenderer.invoke("ave:meeting:transcript", sessionId) as Promise<
      Array<{
        id: string;
        speaker: string;
        original: string;
        startSec: number;
        endSec: number;
        isFinal: boolean;
      }>
    >,
  listMarketplacePlugins: async () =>
    ipcRenderer.invoke("ave:plugins:marketplace:list") as Promise<
      Array<{
        id: string;
        name: string;
        description: string;
        packageSpec: string;
        installed: boolean;
        enabled: boolean;
      }>
    >,
  installMarketplacePlugin: async (pluginId: string) =>
    ipcRenderer.invoke("ave:plugins:install", pluginId) as Promise<{ pluginId: string; installed: true }>,
  listPluginUiExtensions: async () =>
    ipcRenderer.invoke("ave:plugins:ui:list") as Promise<
      Array<{
        pluginId: string;
        extension: {
          id: string;
          slot: "sidebar";
          kind: "embedded-page" | "info-card";
          displayName?: string;
          title: string;
          description?: string;
          defaults?: Record<string, unknown>;
          page?: string;
        };
        pageUrl?: string;
      }>
    >,
  callPluginMethod: async (method: string, payload?: unknown) =>
    ipcRenderer.invoke("ave:plugins:call", method, payload) as Promise<unknown>,
  onViewActivate: (handler: (viewKey: string) => void) => {
    const listener = (_event: unknown, payload: { viewKey?: string }) => {
      handler(payload?.viewKey ?? "home");
    };
    ipcRenderer.on("ave:view:activate", listener);
    return () => ipcRenderer.removeListener("ave:view:activate", listener);
  },
};

contextBridge.exposeInMainWorld("aveApi", api);
