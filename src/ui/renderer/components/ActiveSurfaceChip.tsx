import { useGuestNavigation, useWebSurfaceGuest } from "../hooks/use-browser-navigation.js";
import { clearActiveSurface, useActiveSurface, type ActiveSurface } from "../preview/active-surface.js";
import { BoundSurfaceChip } from "./BoundSurfaceChip.js";
import { hostOf, webPanelTitle } from "./MainSurfacePanels.js";
import { directoryName } from "./TerminalPaneHeader.js";

/** Unbound side-chat tools target the last shown terminal/page; clearing the chip holds it empty until another surface is
 * shown. */
export function ActiveSurfaceChip() {
  const surface = useActiveSurface();
  if (!surface) return null;
  return surface.kind === "browser" ? <BrowserChip surface={surface} /> : <TerminalChip surface={surface} />;
}

function BrowserChip({ surface }: { surface: ActiveSurface }) {
  const navigation = useGuestNavigation(useWebSurfaceGuest(surface.tabId));
  const title = webPanelTitle(navigation, null, surface.label);
  const host = hostOf(navigation.url);
  return (
    <BoundSurfaceChip
      surface={{ kind: "browser", tabId: surface.tabId, name: title, detail: host && host !== title ? host : null, detailTitle: navigation.url }}
      onRemove={clearActiveSurface}
    />
  );
}

function TerminalChip({ surface }: { surface: ActiveSurface }) {
  const cwd = surface.cwd ?? null;
  return (
    <BoundSurfaceChip
      surface={{ kind: "terminal", tabId: surface.tabId, name: surface.label, detail: cwd ? directoryName(cwd) : null, detailTitle: cwd }}
      onRemove={clearActiveSurface}
    />
  );
}
