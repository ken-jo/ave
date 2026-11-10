import { createRoot } from "react-dom/client";
import { WebSurfaceLayer } from "../../../../src/ui/renderer/components/WebSurfaceLayer.js";
import { publishLiveWebTabs, setWebSurfaceSlot, setWebSurfaceUrl } from "../../../../src/ui/renderer/preview/web-surfaces.js";
import type { AveApi } from "../../../../src/ui/renderer/types.js";

const api: AveApi = window.aveApi;
const tabs = api.browserTabs;
const parameters = new URLSearchParams(location.search);
const requestId = parameters.get("requestId");
const root = document.getElementById("root");
const slot = document.getElementById("slot");
if (!requestId || !root || !slot || !tabs) throw new Error("Capture fixture chrome is incomplete");
publishLiveWebTabs(Symbol("capture-fixture"), new Set(["capture-native-tab"]));
setWebSurfaceSlot("capture-native-tab", slot);
setWebSurfaceUrl("capture-native-tab", "about:blank", requestId);
createRoot(root).render(<WebSurfaceLayer api={api} />);
