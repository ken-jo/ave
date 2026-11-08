/** Empty title-bar space remains draggable; interactive controls opt out. Native controls stay on their platform side. */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { BAND_EDGE_PAD, BAND_LEAD_PAD_DARWIN, BAND_LEAD_PAD_LINUX } from "../../../shared/shell-geometry.js";
import { getPlatformBridge } from "../api-client.js";

// Without a native platform bridge, render no title bar; invalid data on a present bridge must throw.

function getWindowBridge(): {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
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
// (`BAND_LEAD_PAD_DARWIN`), Linux clears its leading buttons
// (`BAND_LEAD_PAD_LINUX`), Windows just needs the band's own edge gutter
// (`BAND_EDGE_PAD`) — which is also the pad on the side away from any
// buttons. All live in `shared/shell-geometry.ts` next to the geometry they
// are derived from, rather than as literals here.

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

  // Listen for maximize / fullscreen state from main process.
  useEffect(() => {
    if (!platformBridge) return;
    const bridge = getWindowBridge();
    const unsubMax = bridge.onMaximizedChanged((maximized) => setIsMaximized(maximized));
    const unsubFull = bridge.onFullscreenChanged((fullscreen) => setIsFullscreen(fullscreen));
    return () => { unsubMax(); unsubFull(); };
  }, [platformBridge]);

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
  // No variant draws a bottom rule: the band is part of the window ground, and the shell cards below it carry their own edges.
  if (isFullscreen && !keepVisibleInFullscreen) return null;
  if (!platformBridge || isFullscreen) {
    if (children === undefined || children === null) return null;
    return (
      <div
        data-testid="custom-titlebar-plain"
        className="flex h-(--chrome-band-height) shrink-0 items-center gap-(--chrome-gap) bg-background text-foreground select-none"
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
        className="ave-glass-clear flex h-(--chrome-band-height) shrink-0 items-center gap-(--chrome-gap) bg-background text-foreground select-none"
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

  // Each button is `--chrome-window-button-width` (px, not rem), so the cluster is exactly the run the Linux lead pad reserves.
  // The buttons span the FULL band height so their hover fill reaches the band's top and bottom edges; the wrapper is no-drag
  // so they receive mouse events while the rest of the band drags.
  const buttonClass = "titlebar-btn h-full w-(--chrome-window-button-width) rounded-none text-muted-foreground";
  const minimize = (
    <Button key="minimize" data-testid="titlebar-minimize" type="button" variant="ghost" size="icon" onClick={handleMinimize}
      title={t("customTitleBar.minimize")} aria-label={t("customTitleBar.minimize")} className={`${buttonClass} titlebar-btn-minimize hover:bg-accent hover:text-foreground`}>
      <Minus size={14} />
    </Button>
  );
  const maximize = (
    <Button key="maximize" data-testid="titlebar-maximize" type="button" variant="ghost" size="icon" onClick={handleMaximize}
      title={isMaximized ? t("customTitleBar.restore") : t("customTitleBar.maximize")}
      aria-label={isMaximized ? t("customTitleBar.restore") : t("customTitleBar.maximize")}
      className={`${buttonClass} titlebar-btn-maximize hover:bg-accent hover:text-foreground`}>
      {/* Windows caption convention (VS Code chrome-maximize / chrome-restore): one square, two overlapping when maximized. */}
      {isMaximized ? <Copy size={12} /> : <Square size={12} />}
    </Button>
  );
  const close = (
    <Button key="close" data-testid="titlebar-close" type="button" variant="ghost" size="icon" onClick={handleClose}
      title={t("customTitleBar.close")} aria-label={t("customTitleBar.close")} className={`${buttonClass} titlebar-btn-close hover:bg-destructive hover:text-destructive-foreground`}>
      <X size={14} />
    </Button>
  );
  // Linux: the buttons lead, in the GNOME/macOS order (close, minimize, maximize), overlaying the band's lead pad the way the
  // macOS lights overlay theirs; content starts past them (`BAND_LEAD_PAD_LINUX`) or at the caller's clearance.
  // Windows: the − □ × cluster is pinned to the trailing corner with `ml-auto` — robust whether or not `children` are present.
  // There is no spacer before it: `children` (MainToolbar) is `flex-1` with its OWN inner spacer right-aligning its trailing
  // cluster; a second flex-1 spacer here would split the free space 50/50 and strand the toggle mid-band. MainToolbar's empty
  // area inherits the band's drag region, so dragging is preserved on both.
  // `ave-glass-clear` lets Windows Mica show through the band as macOS vibrancy does; it is inert without `data-glass`.
  const leading = platformBridge.windowControls === "leading";
  const controls = (
    <div
      data-testid="titlebar-controls"
      className={`${leading ? "absolute top-0 left-0" : "ml-auto"} flex h-(--chrome-band-height) items-stretch`}
      style={{
        // @ts-expect-error — Electron-specific CSS extension
        WebkitAppRegion: "no-drag",
      }}
    >
      {leading ? <>{close}{minimize}{maximize}</> : <>{minimize}{maximize}{close}</>}
    </div>
  );
  return (
    <div
      data-testid="custom-titlebar"
      data-window-controls={leading ? "leading" : "trailing"}
      className={`ave-glass-clear ${leading ? "relative " : ""}flex h-(--chrome-band-height) shrink-0 items-center gap-(--chrome-gap) bg-background text-foreground select-none`}
      style={{
        paddingLeft: `${Math.max(leading ? BAND_LEAD_PAD_LINUX : BAND_EDGE_PAD, leadClearance)}px`,
        paddingRight: leading ? `${BAND_EDGE_PAD}px` : undefined,
        // @ts-expect-error — Electron-specific CSS extension
        WebkitAppRegion: "drag",
      }}
      onDoubleClick={handleDoubleClick}
    >
      {leading ? controls : null}
      {children}
      {leading ? null : controls}
    </div>
  );
}
