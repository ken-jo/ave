import { clearActiveSurface, useActiveSurface, type ActiveSurface } from "../preview/active-surface.js";
import { BoundSurfaceChip } from "./BoundSurfaceChip.js";
import { directoryName, hostOf, useGuestNavigation, useWebSurfaceGuest, webPanelTitle } from "./MainSurfacePanels.js";

/**
 * The rail side chat's target chip: the terminal or page its tools act on
 * when a call names no tab — the window's active surface, which follows what
 * the user last brought into view (`preview/active-surface.ts`). × drops the
 * target until another terminal or page is shown. Nothing is drawn while there
 * is no target.
 */
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
