import { createRoot } from "react-dom/client";
import { WebSurfaceLayer } from "../../../../src/ui/renderer/components/WebSurfaceLayer.js";
import { routeBrowserTabOp } from "../../../../src/ui/renderer/preview/agent-browser-bridge.js";
import { publishLiveWebTabs, setWebSurfaceSlot, setWebSurfaceUrl } from "../../../../src/ui/renderer/preview/web-surfaces.js";
import type { AveApi } from "../../../../src/ui/renderer/types.js";
import type { BrowserTabBindRequest, BrowserTabBindResult, BrowserTabOpRequest, SessionTabBindingsState } from "../../../../src/shared/browser-surface.js";
import type { BrowserNativeSurfaceChanged, BrowserNativeSurfaceRequest, BrowserNativeSurfaceResult } from "../../../../src/shared/browser-native-surface.js";

const chrome = (window as unknown as { captureFixtureChrome: {
  bindTab(request: BrowserTabBindRequest): Promise<BrowserTabBindResult>;
  getSessionBindings(): Promise<SessionTabBindingsState>;
  onSessionBindingsChanged(listener: (state: SessionTabBindingsState) => void): () => void;
  nativeSurface(request: BrowserNativeSurfaceRequest): Promise<BrowserNativeSurfaceResult>;
  onNativeSurfaceChanged(listener: (event: BrowserNativeSurfaceChanged) => void): () => void;
  onTabOp(listener: (request: BrowserTabOpRequest) => void): void;
} }).captureFixtureChrome;
const parameters = new URLSearchParams(location.search);
const requestId = parameters.get("requestId");
const root = document.getElementById("root");
const slot = document.getElementById("slot");
if (!requestId || !root || !slot) throw new Error("Capture fixture chrome is incomplete");
const api = { browserTabs: {
  bindTab: chrome.bindTab,
  getSessionBindings: chrome.getSessionBindings,
  onSessionBindingsChanged: chrome.onSessionBindingsChanged,
  nativeSurface: chrome.nativeSurface,
  onNativeSurfaceChanged: chrome.onNativeSurfaceChanged,
} } as AveApi;
chrome.onTabOp((request) => { routeBrowserTabOp(request); });
publishLiveWebTabs(Symbol("capture-fixture"), new Set(["capture-native-tab"]));
setWebSurfaceSlot("capture-native-tab", slot);
setWebSurfaceUrl("capture-native-tab", "about:blank", requestId);
createRoot(root).render(<WebSurfaceLayer api={api} />);
