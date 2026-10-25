/** Fullscreen changes presentation in this renderer while retaining the same mounted app container. */
import { useCallback, useSyncExternalStore } from "react";
import { Minimize2 } from "lucide-react";
import { McpAppView } from "./McpAppView.js";
import { useWebSurfaceOccluder } from "../preview/use-web-surface-occluder.js";
import { useTranslation } from "../../../i18n/react.js";
import {
  getSlotOccupant,
  reviveCardIfAt,
  subscribeSlotOccupant,
} from "../state/mcp-app-card-location-store.js";

export function McpAppFullscreenPanel() {
  const { t } = useTranslation();
  const subscribe = useCallback(
    (listener: () => void) => subscribeSlotOccupant("fullscreen", listener),
    [],
  );
  const getSnapshot = useCallback(() => getSlotOccupant("fullscreen"), []);
  const occupant = useSyncExternalStore(subscribe, getSnapshot);
  // The app takes over the window; no web page may paint over it.
  const occluderRef = useWebSurfaceOccluder();

  if (!occupant) return null;

  return (
    <div
      ref={occluderRef}
      data-testid="mcp-app-fullscreen-panel"
      // Below `McpAppPipPanel`'s z-50: a card in pip and a DIFFERENT card in fullscreen can occupy their slots at the same time,
      // and the floating overlay is the one that must stay on top of the surface that took over.
      className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-background"
    >
      <div className="flex items-center justify-end border-b bg-muted/(--opacity-muted) px-1 py-1">
        <button
          type="button"
          data-testid="mcp-app-fullscreen-exit"
          aria-label={t("mcpAppFullscreenPanel.exit")}
          className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => reviveCardIfAt(occupant.cardId, { kind: "fullscreen" })}
        >
          <Minimize2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <McpAppView
          key={occupant.cardId}
          payload={occupant.payload}
          displayMode="fullscreen"
          originSessionId={occupant.originSessionId}
          locationId={occupant.cardId}
        />
      </div>
    </div>
  );
}
