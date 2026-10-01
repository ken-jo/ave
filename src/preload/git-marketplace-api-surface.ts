/**
 * Narrow host-renderer bridge for the git marketplace (design §13).
 *
 * A leaf like the git runtime's: plugin frames and public surfaces never
 * receive it. Every answer is checked as a `GitMarketplaceResult` envelope;
 * a rejected invoke reads as `unavailable`, never as a thrown error.
 */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseGitMarketplaceResult,
  parseInstallProgress,
  parseSyncProgress,
  parseUpdateStatus,
  type GitMarketplaceApi,
  type GitMarketplaceResult,
} from "../shared/git-marketplace.js";

const channels = CHANNELS.gitMarketplace;

async function call<T>(channel: string, ...args: unknown[]): Promise<GitMarketplaceResult<T>> {
  try {
    return parseGitMarketplaceResult<T>(await ipcRenderer.invoke(channel, ...args));
  } catch {
    return { ok: false, code: "unavailable", message: "the marketplace did not answer" };
  }
}

function subscribe<T>(channel: string, parse: (payload: unknown) => T | null, listener: (value: T) => void): () => void {
  const handler = (_event: unknown, payload: unknown) => {
    const value = parse(payload);
    if (value !== null) listener(value);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

/** Build the private `window.aveApi.gitMarketplace` namespace. */
export function buildGitMarketplaceApiSurface(): GitMarketplaceApi {
  return Object.freeze({
    listSources: () => call(channels.sourcesList),
    previewSource: (request) => call(channels.sourcesPreview, request),
    addSource: (request) => call(channels.sourcesAdd, request),
    acknowledgeSource: (id, warnings) => call(channels.sourcesAcknowledge, id, warnings),
    removeSource: (id) => call(channels.sourcesRemove, id),
    setSourceEnabled: (id, enabled) => call(channels.sourcesSetEnabled, id, enabled),
    refreshSources: (id) => (id === undefined ? call(channels.sourcesRefresh) : call(channels.sourcesRefresh, id)),
    repairSource: (id) => call(channels.sourcesRefresh, id, "repair"),
    acceptRewrite: (id, commit) => call(channels.sourcesAcceptRewrite, id, commit),
    setToken: (host, token) => call(channels.sourcesSetToken, host, token),
    deleteToken: (host) => call(channels.sourcesDeleteToken, host),
    listCatalog: (query) => call(channels.catalogList, query),
    packageDetail: (key) => call(channels.packageDetail, key),
    planInstall: (request) => call(channels.installPlan, request),
    planUpdate: (key) => call(channels.updatePlan, key),
    executeInstall: (planId, approvedMcpServers) => call(channels.installExecute, planId, approvedMcpServers),
    uninstall: (request) => call(channels.uninstall, request),
    previewDirectMcp: (request) => call(channels.directPreview, request),
    onSyncProgress: (listener) => subscribe(channels.syncProgress, parseSyncProgress, listener),
    onCatalogChanged: (listener) => subscribe(channels.catalogChanged, () => true, () => listener()),
    onInstallProgress: (listener) => subscribe(channels.installProgress, parseInstallProgress, listener),
    takeDeepLink: () => call(channels.deepLinkTake),
    onDeepLink: (listener) => subscribe(channels.deepLink, () => true, () => listener()),
    bootInstallNotice: () => call(channels.bootInstallsNotice),
    dismissBootInstallNotice: () => call(channels.bootInstallsDismiss),
    onBootInstallsApplied: (listener) => subscribe(channels.bootInstallsApplied, () => true, () => listener()),
    updateStatus: () => call(channels.updatesStatus),
    checkUpdates: () => call(channels.updatesCheck),
    onUpdateStatus: (listener) => subscribe(channels.updateStatusChanged, parseUpdateStatus, listener),
  } satisfies GitMarketplaceApi);
}
