// Stable preload composition and race-window primes. The large internal API
// object lives in internal-api-surface.ts; this module retains the public
// builder exports used by preload.ts.
import { ipcRenderer } from "electron";
import { buildDocumentEngineApiSurface } from "./document-engine-api-surface.js";
import type {
  ObservationRequest, AgentObservationEvent, BrowserObservationPreviewMessage, BrowserObservationPreviewRequest,
} from "../shared/agent-observation.js";
import { parseDocumentOpenRequest, type DocumentOpenAck, type DocumentOpenRequest } from "../shared/document-open.js";
import { isE2eTestRuntime } from "../boot/dev-flags.js";
import {
  CHANNELS,
  UI,
} from "../contract/app-contract.js";
import type { InitialAppearance, InitialAppearanceResult } from "../shared/initial-appearance.js";
import { isAppearanceMode, isDarkSchemeId, isLightSchemeId, isTerminalFontSize, isTerminalLineHeight, normalizeAppearance } from "../shared/appearance-settings.js";
import { FONT_SIZE_SCALE_VALUES, isValidFontFamilyOverride } from "../shared/appearance-font.js";
import { applyAppearance } from "../ui/renderer/theme/resolve-theme.js";
import type {
  NativeContextMenuAction,
  DynamicNativeMenuAction,
  DynamicNativeMenuPayload,
  NativeContextMenuPayload,
} from "../shared/native-context-menu.js";
import {
  normalizePluginActionResult,
} from "./internal-api-surface.js";
import { ipcUserKeyboardIntent } from "./gesture-intent.js";
export { buildInternalApiSurface } from "./internal-api-surface.js";

export interface InitialWindowAppearance {
  appearance: InitialAppearance;
  /** Main created this window with the macOS material behind it; the renderer paints its tint instead of an opaque ground. */
  glass: boolean;
}

export function readInitialAppearance(): InitialWindowAppearance {
  const response = ipcRenderer.sendSync(CHANNELS.settings.initialAppearance) as InitialAppearanceResult;
  if (!response || !response.ok) throw new Error("Initial appearance unavailable");
  if (typeof response.glass !== "boolean") throw new Error("Invalid initial appearance glass flag");
  const parsed: unknown = response.appearance;
  if (!parsed || typeof parsed !== "object" || (parsed as { schemaVersion?: unknown }).schemaVersion !== 3) {
    throw new Error("Invalid initial appearance");
  }
  const appearance = parsed as Record<string, unknown>;
  const font = appearance.terminalFont as Record<string, unknown> | undefined;
  if (!isAppearanceMode(appearance.mode) || !isDarkSchemeId(appearance.darkScheme) || !isLightSchemeId(appearance.lightScheme)
    || !font || !isValidFontFamilyOverride(font.family) || !isTerminalFontSize(font.size) || !isTerminalLineHeight(font.lineHeight)) {
    throw new Error("Invalid initial appearance");
  }
  const uiFont = appearance.font as Record<string, unknown> | undefined;
  if (uiFont !== undefined && (!uiFont || typeof uiFont !== "object" || Array.isArray(uiFont)
    || (uiFont.family !== undefined && !isValidFontFamilyOverride(uiFont.family))
    || (uiFont.sizeScale !== undefined && !(FONT_SIZE_SCALE_VALUES as readonly unknown[]).includes(uiFont.sizeScale)))) {
    throw new Error("Invalid initial appearance font");
  }
  return { appearance: normalizeAppearance(parsed), glass: response.glass };
}

export function applyInitialAppearance(initial: InitialWindowAppearance | null): void {
  if (!initial || typeof document === "undefined") return;
  const apply = () => {
    applyAppearance(initial.appearance);
    // `data-glass` is set once, here, and never by applyAppearance: a scheme switch must not clear it.
    if (initial.glass) document.documentElement.setAttribute("data-glass", "");
  };
  if (document.documentElement) apply();
  else {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      apply();
    });
    observer.observe(document, { childList: true });
  }
}

export function buildAveHostWorld() {
  let hostMarketplaceApiClaimed = false;
  return {
  takePluginMarketplaceApi: () => {
    if (hostMarketplaceApiClaimed) return null;
    hostMarketplaceApiClaimed = true;
    return {
      uninstallMarketplacePlugin: async (pluginId: string) =>
        normalizePluginActionResult(await ipcRenderer.invoke(CHANNELS.plugins.uninstall, pluginId)),
    };
  },
  };
}

export function buildAvePlatformWorld() {
  return {
    isDarwin: process.platform === "darwin",
  };
}

export function buildAveWindowWorld() {
  return {
  minimize: () => ipcRenderer.invoke(CHANNELS.window.minimize),
  toggleMaximize: () => ipcRenderer.invoke(CHANNELS.window.toggleMaximize),
  close: () => ipcRenderer.invoke(CHANNELS.window.close),
  syncTitleBarTheme: (color: string, symbolColor: string) =>
    ipcRenderer.invoke(CHANNELS.window.syncTitleBarTheme, { color, symbolColor }),
  onMaximizedChanged: (handler: (maximized: boolean) => void) => {
    const listener = (_event: unknown, maximized: boolean) => handler(maximized);
    ipcRenderer.on(CHANNELS.window.maximizedChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.window.maximizedChanged, listener);
  },
  onFullscreenChanged: (handler: (fullscreen: boolean) => void) => {
    const listener = (_event: unknown, fullscreen: boolean) => handler(fullscreen);
    ipcRenderer.on(CHANNELS.window.fullscreenChanged, listener);
    return () => ipcRenderer.removeListener(CHANNELS.window.fullscreenChanged, listener);
  },
  };
}

export function buildAveNamespaceExtras() {
  return {
  plugins: {
    cards: () => ipcRenderer.invoke(CHANNELS.plugins.cards),
  },
  ui: {
    showNativeContextMenu: (payload: NativeContextMenuPayload) =>
      ipcRenderer.invoke(UI.nativeContextMenu, payload),
    onNativeContextMenuAction: (cb: (action: NativeContextMenuAction) => void) => {
      const listener = (_event: unknown, action: NativeContextMenuAction) => cb(action);
      ipcRenderer.on(UI.nativeContextAction, listener);
      return () => ipcRenderer.removeListener(UI.nativeContextAction, listener);
    },
    showDynamicMenu: (payload: DynamicNativeMenuPayload) =>
      ipcRenderer.invoke(UI.dynamicMenu, payload),
    onDynamicMenuAction: (cb: (action: DynamicNativeMenuAction) => void) => {
      const listener = (_event: unknown, action: DynamicNativeMenuAction) => cb(action);
      ipcRenderer.on(UI.dynamicMenuAction, listener);
      return () => ipcRenderer.removeListener(UI.dynamicMenuAction, listener);
    },
  },
  pluginConfig: {
    get: (pluginId: string) => ipcRenderer.invoke(CHANNELS.plugins.configGet, pluginId),
    set: (pluginId: string, config: Record<string, unknown>) => ipcRenderer.invoke(CHANNELS.plugins.configSet, pluginId, config),
    getSchema: (pluginId: string) => ipcRenderer.invoke(CHANNELS.plugins.configSchemaGet, pluginId),
    setSecret: (pluginId: string, key: string, value: string) =>
      ipcRenderer.invoke(CHANNELS.plugins.configSecretSet, pluginId, key, value),
    // US-3c.1: batch secret-presence query — returns keys for which the
    // keychain holds a value. Fewer IPC round-trips than per-key checks.
    listSecretKeys: (pluginId: string) =>
      ipcRenderer.invoke(CHANNELS.plugins.configSecretListKeys, pluginId),
  },
  env: {
    isDev: process.env.AVE_DEV === "1",
    isE2E: isE2eTestRuntime(),
    enableDevConsole: process.env.AVE_DEV_CONSOLE === "1",
    debugStream:
      process.env.VITE_DEBUG_STREAM === "1" ||
      process.env.AVE_DEBUG_STREAM === "1",
  },
  attach: {
    openFile: () => ipcRenderer.invoke(CHANNELS.attach.openFile),
    readImage: (filePath: string) =>
      ipcRenderer.invoke(CHANNELS.attach.readImage, filePath),
    saveClipboardImage: (base64: string) =>
      ipcRenderer.invoke(CHANNELS.attach.saveClipboardImage, { base64 }),
    discardClipboardImage: (filePath: string) =>
      ipcRenderer.invoke(CHANNELS.attach.discardClipboardImage, filePath),
    openExternal: (filePath: string) =>
      ipcRenderer.invoke(CHANNELS.attach.openExternal, filePath),
    // Composer drop, step 2: echo the main-owned token; main authorizes the
    // files bound to it. Step 1 lives on `aveDrop.prepareFileDrop` (File-only).
    redeemDrop: (token: string) =>
      ipcRenderer.invoke(CHANNELS.attach.redeemDrop, token),
  },
  preview: {
    onDocumentOpen: (handler: (request: DocumentOpenRequest) => void) => {
      const listener = (_event: unknown, raw: unknown) => {
        const request = parseDocumentOpenRequest(raw);
        if (request) handler(request);
      };
      ipcRenderer.on(CHANNELS.preview.documentOpenRequest, listener);
      return () => ipcRenderer.removeListener(CHANNELS.preview.documentOpenRequest, listener);
    },
    acknowledgeDocumentOpen: (ack: DocumentOpenAck) => ipcRenderer.invoke(CHANNELS.preview.documentOpenAck, ack),
    readFile: (filePath: string, window?: { offset?: number; limit?: number; workspaceRoot?: string; sessionId?: string }) =>
      ipcRenderer.invoke(CHANNELS.preview.readFile, filePath, ...(window === undefined ? [] : [window])),
    readDocument: (filePath: string, sheetIndex: number, sessionId?: string) =>
      ipcRenderer.invoke(CHANNELS.preview.readDocument, filePath, sheetIndex, ...(sessionId === undefined ? [] : [sessionId])),
    onAgentObservation: (handler: (events: AgentObservationEvent[]) => void) => {
      const listener = (_event: unknown, events: AgentObservationEvent[]) => handler(events);
      ipcRenderer.on(CHANNELS.preview.observationEvents, listener);
      return () => ipcRenderer.removeListener(CHANNELS.preview.observationEvents, listener);
    },
    acknowledgeObservation: (request: ObservationRequest) => ipcRenderer.invoke(CHANNELS.preview.observationAck, request),
    onObservationPreview: (handler: (message: BrowserObservationPreviewMessage) => void) => {
      const listener = (_event: unknown, message: BrowserObservationPreviewMessage) => handler(message);
      ipcRenderer.on(CHANNELS.preview.observationPreviewFrames, listener);
      return () => ipcRenderer.removeListener(CHANNELS.preview.observationPreviewFrames, listener);
    },
    requestObservationPreview: (request: BrowserObservationPreviewRequest) => ipcRenderer.invoke(CHANNELS.preview.observationPreview, request),
  },
  documentEngine: buildDocumentEngineApiSurface(),
  workspace: {
    listRoots: () => ipcRenderer.invoke(CHANNELS.workspace.listRoots),
    pickRoot: (opts?: { ackToken?: string }) =>
      ipcRenderer.invoke(CHANNELS.workspace.pickRoot, opts),
    listDir: (dirPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.listDir, dirPath),
    removeRoot: (dirPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.removeRoot, dirPath),
    previewRemoveRoot: (dirPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.previewRemoveRoot, dirPath),
    reveal: (targetPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.reveal, targetPath),
    // Drag-drop add-root, step 1 (#1458): submit a renderer-resolved dropped
    // folder path for Layer-0 + is-a-dir validation and a main-owned ack token.
    dropPrepare: (droppedPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.dropPrepare, droppedPath),
    // Composer `@file` autocomplete over the current workspace roots.
    searchFiles: (query: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.searchFiles, query),
    // Folder view "open in default app"; the gesture flag is read here, inside the click or key handler's task.
    openPath: (projectRoot: string, targetPath: string) =>
      ipcRenderer.invoke(CHANNELS.workspace.openPath, { projectRoot, path: targetPath, intent: ipcUserKeyboardIntent() }),
  },
  };
}
