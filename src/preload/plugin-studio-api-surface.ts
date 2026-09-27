import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import { parseStudioResult, type PluginStudioApi, type StudioResult } from "../shared/plugin-studio.js";

const channels = CHANNELS.pluginStudio;

async function call<T>(channel: string, ...args: unknown[]): Promise<StudioResult<T>> {
  try { return parseStudioResult<T>(await ipcRenderer.invoke(channel, ...args)); }
  catch { return { ok: false, code: "unavailable", message: "Studio did not answer" }; }
}

/** Host-renderer-only bridge; plugin frames receive no Studio namespace. */
export function buildPluginStudioApiSurface(): PluginStudioApi {
  return Object.freeze({
    availableParts: () => call(channels.availableParts),
    listDrafts: () => call(channels.listDrafts),
    readDraft: (name) => call(channels.readDraft, name),
    writeDraft: (request) => call(channels.writeDraft, request),
    validateDraft: (name) => call(channels.validateDraft, name),
    importPackage: () => call(channels.importPackage),
    reviewDraft: (name, treeDigest) => call(channels.reviewDraft, name, treeDigest),
    exportDraft: (name, projection) => call(channels.exportDraft, name, projection),
    exportToCheckout: (name) => call(channels.exportToCheckout, name),
    previewInstallFromFile: () => call(channels.previewInstallFromFile),
    previewInstallDraft: (name) => call(channels.previewInstallDraft, name),
    installFromFile: (previewId, approvedMcpServers) => call(channels.installFromFile, previewId, approvedMcpServers),
  } satisfies PluginStudioApi);
}
