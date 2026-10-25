/** Main enforces gates; trusted renderer bindings, never app data, supply server, session, and card identity. */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import type { McpServerConfig } from "../mcp/types.js";
import type { AveMcpApi } from "../ui/renderer/types.js";

export const mcpApiSurface = {
  servers: async () => ipcRenderer.invoke(CHANNELS.mcp.servers),
  kill: async (id: string) => ipcRenderer.invoke(CHANNELS.mcp.kill, id),
  authenticate: async (id: string) => ipcRenderer.invoke(CHANNELS.mcp.authenticate, id),
  getConfigs: async () => ipcRenderer.invoke(CHANNELS.mcp.configGet),
  getConfigPath: async () => ipcRenderer.invoke(CHANNELS.mcp.configPath),
  addConfig: async (config: McpServerConfig) => ipcRenderer.invoke(CHANNELS.mcp.configAdd, config),
  setApiKey: async (id: string, apiKey: string) => ipcRenderer.invoke(CHANNELS.mcp.configSetApiKey, id, apiKey),
  removeConfig: async (id: string) => ipcRenderer.invoke(CHANNELS.mcp.configRemove, id),
  readUiResource: async (serverId: string, uri: string, generationId?: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiResource, serverId, uri, generationId) as ReturnType<NonNullable<AveMcpApi["readUiResource"]>>,
  // Bind the card's server in the trusted renderer; main rechecks tool ownership and returns protocol outcomes.
  callTool: async (
    serverId: string,
    name: string,
    args: Record<string, unknown>,
    generationId?: string,
  ) =>
    ipcRenderer.invoke(
      CHANNELS.mcp.callTool,
      serverId,
      name,
      args,
      generationId,
    ) as ReturnType<NonNullable<AveMcpApi["callTool"]>>,
  // Bind server and session outside the app; main checks the live session and uses notifications on mismatch.
  postUiMessage: async (serverId: string, sessionId: string, params: unknown) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiMessage, serverId, sessionId, params) as ReturnType<NonNullable<AveMcpApi["postUiMessage"]>>,
  // Return host-wrapped prompt provenance for send-time revalidation; never start turns or build envelopes here.
  getPrompt: async (serverId: string, name: string, args: Record<string, string>) =>
    ipcRenderer.invoke(CHANNELS.mcp.getPrompt, serverId, name, args) as ReturnType<NonNullable<AveMcpApi["getPrompt"]>>,
  attachResource: async (serverId: string, uri: string) =>
    ipcRenderer.invoke(CHANNELS.mcp.attachResource, serverId, uri) as ReturnType<NonNullable<AveMcpApi["attachResource"]>>,
  listResources: async () =>
    ipcRenderer.invoke(CHANNELS.mcp.listResources) as ReturnType<NonNullable<AveMcpApi["listResources"]>>,
  listResourceTemplates: async () =>
    ipcRenderer.invoke(CHANNELS.mcp.listResourceTemplates) as ReturnType<NonNullable<AveMcpApi["listResourceTemplates"]>>,
  // Accept only a published template plus user values; main constructs the URI after matching the listed template.
  attachResourceTemplate: async (
    serverId: string,
    uriTemplate: string,
    values: Record<string, string>,
  ) =>
    ipcRenderer.invoke(
      CHANNELS.mcp.attachResourceTemplate,
      serverId,
      uriTemplate,
      values,
    ) as ReturnType<NonNullable<AveMcpApi["attachResourceTemplate"]>>,
  // Decode bounded inline bytes into a save dialog; never fetch app-supplied URIs. Cancellation is a normal outcome.
  downloadFile: async (serverId: string, params: unknown) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiDownloadFile, serverId, params) as ReturnType<NonNullable<AveMcpApi["downloadFile"]>>,
  // Bind server, session, and card outside app control; update only that next-turn context slot without starting a turn.
  postUiModelContext: async (serverId: string, sessionId: string, cardId: string, params: unknown) =>
    ipcRenderer.invoke(CHANNELS.mcp.uiModelContext, serverId, sessionId, cardId, params) as ReturnType<NonNullable<AveMcpApi["postUiModelContext"]>>,
  disposeUiSession: (token: string) => { void ipcRenderer.invoke(CHANNELS.mcp.disposeUiSession, token); },
  // The receiving view must validate disconnect payloads and match its own server id.
  onServerDisconnected: (handler: (serverId: string) => void) => {
    const listener = (_event: unknown, payload: { serverId?: unknown }) => {
      if (typeof payload?.serverId === "string") handler(payload.serverId);
    };
    ipcRenderer.on(CHANNELS.mcp.serverDisconnected, listener);
    return () => ipcRenderer.removeListener(CHANNELS.mcp.serverDisconnected, listener);
  },
} as const;
