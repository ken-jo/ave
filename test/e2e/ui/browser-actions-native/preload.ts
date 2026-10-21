import { contextBridge, ipcRenderer } from "electron";
import type { BrowserTabOpRequest } from "../../../../src/shared/browser-surface.js";

contextBridge.exposeInMainWorld("nativeFixtureChrome", {
  onTabOp: (listener: (request: BrowserTabOpRequest) => void) => {
    ipcRenderer.on("native-fixture-tab-op", (_event, request: BrowserTabOpRequest) => { listener(request); });
  },
});
