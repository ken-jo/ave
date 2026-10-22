import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  BROWSER_WORKSPACE_ERRORS,
  parseBrowserWorkspacePreview,
  parseBrowserWorkspaceState,
  type BrowserWorkspaceApi,
  type BrowserWorkspaceResult,
  type BrowserWorkspaceState,
} from "../shared/browser-workspace.js";

const errors: ReadonlySet<string> = new Set(BROWSER_WORKSPACE_ERRORS);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function result<T>(value: unknown, valid: (value: unknown) => value is T): BrowserWorkspaceResult<T> {
  const data = record(value);
  if (data && Object.keys(data).length === 2) {
    if (data.ok === false && typeof data.error === "string" && errors.has(data.error)) {
      return data as unknown as BrowserWorkspaceResult<T>;
    }
    if (data.ok === true && valid(data.value)) return { ok: true, value: data.value };
  }
  throw new Error("invalid-browser-workspace-result");
}

const state = (value: unknown): value is BrowserWorkspaceState => parseBrowserWorkspaceState(value) !== null;
const requestId = (value: unknown): value is { requestId: number } => {
  const data = record(value);
  return data !== null && Object.keys(data).length === 1 && Number.isSafeInteger(data.requestId) && Number(data.requestId) >= 1;
};
const factor = (value: unknown): value is { factor: number } => {
  const data = record(value);
  return data !== null && Object.keys(data).length === 1 && typeof data.factor === "number"
    && Number.isFinite(data.factor) && data.factor >= 0.5 && data.factor <= 3;
};

/** Host-only browser chrome returns validated snapshots, never raw IPC objects. */
export function buildBrowserWorkspaceApiSurface(): BrowserWorkspaceApi {
  return {
    getState: async () => result(await ipcRenderer.invoke(CHANNELS.browserWorkspace.getState), state),
    setBookmark: async (request) => result(await ipcRenderer.invoke(CHANNELS.browserWorkspace.setBookmark, request), state),
    clearHistory: async () => result(await ipcRenderer.invoke(CHANNELS.browserWorkspace.clearHistory), state),
    setSitePermission: async (request) => result(await ipcRenderer.invoke(CHANNELS.browserWorkspace.setSitePermission, request), state),
    find: async (request) => result(await ipcRenderer.invoke(CHANNELS.browserWorkspace.find, request), requestId),
    stopFind: async (request) => result(await ipcRenderer.invoke(CHANNELS.browserWorkspace.stopFind, request), (value): value is null => value === null),
    zoom: async (request) => result(await ipcRenderer.invoke(CHANNELS.browserWorkspace.zoom, request), factor),
    preview: async (request) => result(await ipcRenderer.invoke(CHANNELS.browserWorkspace.preview, request),
      (value): value is NonNullable<ReturnType<typeof parseBrowserWorkspacePreview>> => parseBrowserWorkspacePreview(value) !== null),
    onChanged: (handler) => {
      const listener = (_event: unknown, payload: unknown) => {
        const parsed = parseBrowserWorkspaceState(payload);
        if (!parsed) throw new Error("invalid-browser-workspace-state");
        handler(parsed);
      };
      ipcRenderer.on(CHANNELS.browserWorkspace.changed, listener);
      return () => ipcRenderer.removeListener(CHANNELS.browserWorkspace.changed, listener);
    },
  };
}
