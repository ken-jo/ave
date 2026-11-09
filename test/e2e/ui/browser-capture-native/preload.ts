import { contextBridge, ipcRenderer } from "electron";
import { parseSessionTabBindingsState, type BrowserTabBindRequest, type BrowserTabBindResult, type BrowserTabOpRequest, type SessionTabBindingsState } from "../../../../src/shared/browser-surface.js";
import { parseBrowserNativeSurfaceChanged, parseBrowserNativeSurfaceResult, type BrowserNativeSurfaceChanged, type BrowserNativeSurfaceRequest } from "../../../../src/shared/browser-native-surface.js";

contextBridge.exposeInMainWorld("captureFixtureChrome", {
  bindTab: (request: BrowserTabBindRequest): Promise<BrowserTabBindResult> => ipcRenderer.invoke("capture-fixture-bind", request),
  getSessionBindings: async () => {
    const state = parseSessionTabBindingsState(await ipcRenderer.invoke("capture-fixture-session-bindings"));
    if (!state) throw new Error("Invalid capture session bindings");
    return state;
  },
  onSessionBindingsChanged: (listener: (state: SessionTabBindingsState) => void) => {
    const handle = (_event: unknown, payload: unknown) => {
      const state = parseSessionTabBindingsState(payload);
      if (!state) throw new Error("Invalid capture session bindings event");
      listener(state);
    };
    ipcRenderer.on("capture-fixture-session-bindings-changed", handle);
    return () => ipcRenderer.removeListener("capture-fixture-session-bindings-changed", handle);
  },
  nativeSurface: async (request: BrowserNativeSurfaceRequest) => {
    const result = parseBrowserNativeSurfaceResult(await ipcRenderer.invoke("capture-fixture-native-surface", request));
    if (!result) throw new Error("Invalid capture native surface result");
    return result;
  },
  onNativeSurfaceChanged: (listener: (event: BrowserNativeSurfaceChanged) => void) => {
    const handle = (_event: unknown, payload: unknown) => {
      const state = parseBrowserNativeSurfaceChanged(payload);
      if (!state) throw new Error("Invalid capture native surface event");
      listener(state);
    };
    ipcRenderer.on("capture-fixture-native-state", handle);
    return () => ipcRenderer.removeListener("capture-fixture-native-state", handle);
  },
  onTabOp: (listener: (request: BrowserTabOpRequest) => void) => {
    ipcRenderer.on("capture-fixture-tab-op", (_event, request: BrowserTabOpRequest) => { listener(request); });
  },
});
