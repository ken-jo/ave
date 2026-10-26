import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import { parseStudioResult, type PluginStudioApi, type StudioResult } from "../shared/plugin-studio.js";

const channels = CHANNELS.pluginStudio;

async function call<T>(channel: string, ...args: unknown[]): Promise<StudioResult<T>> {
  try { return parseStudioResult<T>(await ipcRenderer.invoke(channel, ...args)); }
  catch { return { ok: false, code: "unavailable", message: "Studio did not answer" }; }
}

/** Studio is host-renderer-only; plugin frames receive no namespace. */
export function buildPluginStudioApiSurface(): PluginStudioApi {
  return Object.freeze({
    availableParts: () => call(channels.availableParts),
    listDrafts: () => call(channels.listDrafts),
    readDraft: (name) => call(channels.readDraft, name),
    writeDraft: (request) => call(channels.writeDraft, request),
    validateDraft: (name) => call(channels.validateDraft, name),
    connectorCopyPreview: (serverId) => call(channels.connectorCopyPreview, serverId),
    confirmConnectorCopy: (name, serverId, confirmation) => call(channels.confirmConnectorCopy, name, serverId, confirmation),
    importPackage: () => call(channels.importPackage),
    reviewDraft: (name, treeDigest) => call(channels.reviewDraft, name, treeDigest),
    exportDraft: (name, projection) => call(channels.exportDraft, name, projection),
    exportInstalled: (name, projection) => call(channels.exportInstalled, name, projection),
    exportToCheckout: (name) => call(channels.exportToCheckout, name),
    previewInstallFromFile: () => call(channels.previewInstallFromFile),
    previewInstallDraft: (name) => call(channels.previewInstallDraft, name),
    installFromFile: (previewId, componentConsents) => call(channels.installFromFile, previewId, componentConsents),
  } satisfies PluginStudioApi);
}
