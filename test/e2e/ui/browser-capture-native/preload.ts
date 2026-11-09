import { contextBridge, ipcRenderer } from "electron";
import type { BrowserTabBindRequest, BrowserTabBindResult, BrowserTabOpRequest } from "../../../../src/shared/browser-surface.js";

contextBridge.exposeInMainWorld("captureFixtureChrome", {
  bindTab: (request: BrowserTabBindRequest): Promise<BrowserTabBindResult> => ipcRenderer.invoke("capture-fixture-bind", request),
  onTabOp: (listener: (request: BrowserTabOpRequest) => void) => {
    ipcRenderer.on("capture-fixture-tab-op", (_event, request: BrowserTabOpRequest) => { listener(request); });
  },
});
