import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseBrowserTabControlState,
  parseBrowserTabOpRequest,
  parseSessionTabBindingsState,
  type BrowserTabsApi,
} from "../shared/browser-surface.js";

/** Private browser capabilities are unavailable to remote guests. */
export function buildBrowserTabsApiSurface(): BrowserTabsApi {
  return {
    bindTab: (request) => ipcRenderer.invoke(CHANNELS.browser.bindTab, request),
    getState: async () => {
      const state = parseBrowserTabControlState(await ipcRenderer.invoke(CHANNELS.browser.getState));
      if (!state) throw new Error("invalid-browser-control-state");
      return state;
    },
    getSessionBindings: async () => {
      const state = parseSessionTabBindingsState(await ipcRenderer.invoke(CHANNELS.browser.getSessionBindings));
      if (!state) throw new Error("invalid-session-tab-bindings");
      return state;
    },
    onSessionBindingsChanged: (handler) => {
      const listener = (_event: unknown, payload: unknown) => {
        const state = parseSessionTabBindingsState(payload);
        if (!state) throw new Error("invalid-session-tab-bindings");
        handler(state);
      };
      ipcRenderer.on(CHANNELS.browser.sessionBindingsChanged, listener);
      return () => ipcRenderer.removeListener(CHANNELS.browser.sessionBindingsChanged, listener);
    },
    stop: (tabId) => ipcRenderer.invoke(CHANNELS.browser.stop, { tabId }),
    pause: (tabId) => ipcRenderer.invoke(CHANNELS.browser.pause, { tabId }),
    resume: (tabId) => ipcRenderer.invoke(CHANNELS.browser.resume, { tabId }),
    pausePopup: (tabId) => ipcRenderer.invoke(CHANNELS.browser.pausePopup, { tabId }),
    resumePopup: (tabId) => ipcRenderer.invoke(CHANNELS.browser.resumePopup, { tabId }),
    onTabOp: (handler) => {
      const listener = (_event: unknown, payload: unknown) => {
        const request = parseBrowserTabOpRequest(payload);
        if (!request) throw new Error("invalid-browser-tab-operation");
        handler(request);
      };
      ipcRenderer.on(CHANNELS.browser.tabOp, listener);
      return () => ipcRenderer.removeListener(CHANNELS.browser.tabOp, listener);
    },
    onControl: (handler) => {
      const listener = (_event: unknown, payload: unknown) => {
        const state = parseBrowserTabControlState(payload);
        if (!state) throw new Error("invalid-browser-control-state");
        handler(state);
      };
      ipcRenderer.on(CHANNELS.browser.control, listener);
      return () => ipcRenderer.removeListener(CHANNELS.browser.control, listener);
    },
  };
}
