/** Empty title-bar space remains draggable; interactive controls opt out. Native controls stay on their platform side. */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Minus, Maximize2, Minimize2, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useOptionalTheme } from "../theme/ThemeProvider.js";
import { useTranslation } from "../../../i18n/react.js";
import { BAND_EDGE_PAD, BAND_LEAD_PAD_DARWIN } from "../../../shared/shell-geometry.js";
import { getPlatformBridge } from "../api-client.js";

// We read the CSS variable as an HSL triple (e.g. "222.2 84% 4.9%") and
// convert it to a hex string that Electron's setTitleBarOverlay() accepts.
function hslTripleToHex(triple: string): string {
  const parts = triple.trim().split(/\s+/);
  if (parts.length < 3) {
    throw new Error(`[CustomTitleBar] invalid HSL triple from CSS variable: "${triple}"`);
  }
  const h = parseFloat(parts[0]);
  const s = parseFloat(parts[1]) / 100;
  const l = parseFloat(parts[2]) / 100;

  // HSL → RGB (standard formula)
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

function readCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name);
}

// Without a native platform bridge, render no title bar; invalid data on a present bridge must throw.

function getWindowBridge(): {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  syncTitleBarTheme: (color: string, symbolColor: string) => Promise<void>;
  onMaximizedChanged: (handler: (maximized: boolean) => void) => () => void;
  onFullscreenChanged: (handler: (fullscreen: boolean) => void) => () => void;
} {
  const w = (window as unknown as { aveWindow?: unknown }).aveWindow;
  if (!w) {
    throw new Error("[CustomTitleBar] window.aveWindow is not defined — check preload.ts");
  }
  return w as ReturnType<typeof getWindowBridge>;
}

export interface CustomTitleBarProps {
  /**
   * Band content — the app toolbar cluster (collapse toggle,
   * Dev badge, search / star / export). Rendered in the band's left + middle,
   * LEFT of the native window controls. Interactive controls inside must wrap
   * themselves `WebkitAppRegion: "no-drag"`; the band itself is a drag region
   * in the gaps between them.
   */
  children?: ReactNode;
  /** Use the larger of sidebar and native-control leading reserves, never stack both paddings. */
  leadClearance?: number;
  /** Keep a plain control band when it holds the only way to reopen navigation. */
  keepVisibleInFullscreen?: boolean;
}

// Band leading pad when nothing overlaps it: macOS clears the traffic lights
// (`BAND_LEAD_PAD_DARWIN`), the other platforms just need the band's own edge
// gutter (`BAND_EDGE_PAD`) — which is also the trailing pad on both. Both live
// in `shared/shell-geometry.ts` next to the light position they are derived
// from, rather than as literals here.

export function CustomTitleBar({ children, leadClearance = 0, keepVisibleInFullscreen = false }: CustomTitleBarProps = {}) {
  // Rules-of-hooks: all hook calls MUST come before any early return so the
  // hook order stays stable across renders. The platformBridge check is moved
  // below all hooks; the bridge-dependent useEffect bodies are gated with an
  // internal `if (!platformBridge) return;` so they noop when the bridge is
  // absent (jsdom / Storybook / SSR) without affecting hook count.
  const { t } = useTranslation();
  const platformBridge = getPlatformBridge();
  const isDarwin = platformBridge?.isDarwin ?? false;
  const [isMaximized, setIsMaximized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const optionalTheme = useOptionalTheme();

  // Listen for maximize / fullscreen state from main process.
  useEffect(() => {
    if (!platformBridge) return;
    const bridge = getWindowBridge();
    const unsubMax = bridge.onMaximizedChanged((maximized) => setIsMaximized(maximized));
    const unsubFull = bridge.onFullscreenChanged((fullscreen) => setIsFullscreen(fullscreen));
    return () => { unsubMax(); unsubFull(); };
  }, [platformBridge]);

  // Sync titlebar overlay colors whenever the applied theme values change (Win/Linux only).
  useEffect(() => {
    if (!platformBridge) return;
    if (isDarwin) return;
    if (typeof document === "undefined") return;
    try {
      const bg = readCssVar("--background");
      const fg = readCssVar("--foreground");
      if (!bg.trim() || !fg.trim()) return;
      const color = hslTripleToHex(bg);
      const symbolColor = hslTripleToHex(fg);
      void getWindowBridge().syncTitleBarTheme(color, symbolColor);
    } catch (err) {
      console.warn("[CustomTitleBar] theme sync failed:", err);
    }
    // appliedRevision is the dependency: it changes after ThemeProvider has
    // written the new values to :root — another theme, or the same theme
    // updated in place — so the colors read here are the new ones.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platformBridge, isDarwin, optionalTheme?.appliedRevision]);

  const handleMinimize = useCallback(() => { void getWindowBridge().minimize(); }, []);
  const handleMaximize = useCallback(() => { void getWindowBridge().toggleMaximize(); }, []);
  const handleClose = useCallback(() => { void getWindowBridge().close(); }, []);
  const handleDoubleClick = useCallback(() => { void getWindowBridge().toggleMaximize(); }, []);

  // Early returns (all AFTER hooks have been called):
  // - No preload bridge → non-Electron environment (jsdom / Storybook / SSR).
  //   When band content is passed we still render a plain band hosting it
  //   (no native window buttons, no drag region — there is no OS chrome to
  //   integrate with) so the toolbar is never silently dropped. When no
  //   children are passed there is nothing to show, so render nothing.
  // - Fullscreen → OS/Electron draws fullscreen chrome.
  if (isFullscreen && !keepVisibleInFullscreen) return null;
  if (!platformBridge || isFullscreen) {
    if (children === undefined || children === null) return null;
    return (
      <div
        data-testid="custom-titlebar-plain"
        className="flex h-(--chrome-band-height) shrink-0 items-center gap-(--chrome-gap) border-b border-border/(--opacity-half) bg-background text-foreground select-none"
        style={{
          paddingLeft: `${Math.max(BAND_EDGE_PAD, leadClearance)}px`,
          paddingRight: `${BAND_EDGE_PAD}px`,
        }}
      >
        {children}
      </div>
    );
  }

  if (isDarwin) {
    // Keep chrome dimensions in pixels to align native controls across font scales; move band height and traffic-light
    // geometry together.
    return (
      <div
        data-testid="custom-titlebar-darwin"
        className="flex h-(--chrome-band-height) shrink-0 items-center gap-(--chrome-gap) border-b border-border/(--opacity-half) bg-background text-foreground select-none"
        style={{
          paddingLeft: `${Math.max(BAND_LEAD_PAD_DARWIN, leadClearance)}px`,
          paddingRight: `${BAND_EDGE_PAD}px`,
          // @ts-expect-error — Electron-specific CSS extension
          WebkitAppRegion: "drag",
        }}
        onDoubleClick={handleDoubleClick}
      >
        {children}
      </div>
    );
  }

  // Win / Linux: band hosts the toolbar content on the left + middle, with the native − □ × cluster pinned to the trailing
  // corner.
  return (
    <div
      data-testid="custom-titlebar"
      className="flex h-(--chrome-band-height) shrink-0 items-center gap-(--chrome-gap) border-b border-border/(--opacity-half) bg-background text-foreground select-none"
      style={{
        paddingLeft: `${Math.max(BAND_EDGE_PAD, leadClearance)}px`,
        // @ts-expect-error — Electron-specific CSS extension
        WebkitAppRegion: "drag",
      }}
      onDoubleClick={handleDoubleClick}
    >
      {children}
      {/* No spacer here: `children` (MainToolbar) is `flex-1` and already grows
          to fill the band, with its OWN inner spacer right-aligning its trailing
          cluster (chat/action toggle last). A second flex-1 spacer here split
          the free space 50/50 with MainToolbar, stranding the toggle mid-band
          instead of flush against the − □ × controls. MainToolbar's empty area
          inherits the band's drag region, so dragging is preserved. */}
      {/* no-drag wrapper so buttons receive mouse events. The band vertically
          centers its content (items-center); the native window buttons must
          still span the FULL band height so their hover fill reaches the
          band's top and bottom edges. `ml-auto` pins the cluster to the trailing
          corner directly — robust whether or not `children` are present. The
          main window passes a `flex-1` MainToolbar that eats the leading slack;
          without children, `ml-auto` still prevents the cluster from stranding
          flush-left. */}
      <div
        className="ml-auto flex h-(--chrome-band-height) items-stretch"
        style={{
          // @ts-expect-error — Electron-specific CSS extension
          WebkitAppRegion: "no-drag",
        }}
      >
        <Button
          data-testid="titlebar-minimize"
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleMinimize}
          title={t("customTitleBar.minimize")}
          className="titlebar-btn titlebar-btn-minimize h-full w-11 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Minus size={14} />
        </Button>
        <Button
          data-testid="titlebar-maximize"
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleMaximize}
          title={isMaximized ? t("customTitleBar.restore") : t("customTitleBar.maximize")}
          className="titlebar-btn titlebar-btn-maximize h-full w-11 rounded-none text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </Button>
        <Button
          data-testid="titlebar-close"
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleClose}
          title={t("customTitleBar.close")}
          className="titlebar-btn titlebar-btn-close h-full w-11 rounded-none text-muted-foreground hover:bg-destructive hover:text-destructive-foreground"
        >
          <X size={14} />
        </Button>
      </div>
    </div>
  );
}
