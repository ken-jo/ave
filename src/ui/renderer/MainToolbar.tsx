import { useLayoutEffect, useRef } from "react";
import { ArrowDownToLine, Download, RefreshCw, Wrench, X } from "lucide-react";
import { ZoomIndicator } from "./components/ZoomControls.js";
import { ViewHistoryNav, ViewPathBreadcrumb, type ViewPathNavProps } from "./components/ViewPathNav.js";
import { useTranslation } from "../../i18n/react.js";
import { RemoteA2AActionButton } from "./components/RemoteA2AActionButton.js";
import { ToolbarStatusPill } from "./components/ToolbarStatusPill.js";
import { BootstrapStatusPill, type BootstrapStatusPillProps } from "./components/BootstrapStatusPill.js";
import { PluginUpdatesPill, type PluginUpdatesPillProps } from "./components/PluginUpdatesPill.js";
import { WorkApprovalsBadge, type WorkApprovalsBadgeProps } from "./components/work-approvals/WorkApprovalsBadge.js";

/** Every toolbar control must opt out of the title band's drag region to remain clickable. */
function NoDrag({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={className}
      style={{
        // @ts-expect-error — Electron-specific CSS extension
        WebkitAppRegion: "no-drag",
      }}
    >
      {children}
    </span>
  );
}

import type { UpdateState } from "../../shared/update-state.js";
export type AppUpdateBadgeState = UpdateState;

function isDevMode(): boolean {
  return (window as unknown as { __aveDevMode?: boolean }).__aveDevMode === true;
}

export interface MainToolbarProps {
  /** Window notice in the free space between navigation and status controls. */
  notice?: React.ReactNode;
  /** Current location path. Rendered on the band's leading edge, immediately after the sidebar-clearance reserve. */
  viewNav: ViewPathNavProps;
  streaming: boolean;
  hasApiKey: boolean | null;
  onOpenDevTools?: () => void;
  /** Latest app-update state from the main process. */
  appUpdateState?: AppUpdateBadgeState;
  /** When true, the user-initiated download/install IPC is in flight — disables the badge to prevent rapid double-clicks
   * during the IPC round-trip window. */
  appUpdateInFlight?: boolean;
  /** Triggered when the badge is in "available" state and clicked. */
  onDownloadAppUpdate?: () => void | Promise<void>;
  /** Triggered when the badge is in "downloaded" state and clicked. */
  onInstallAppUpdate?: () => void | Promise<void>;
  /** Hide the current available/downloaded app update until a newer version exists. */
  onSkipAppUpdate?: () => void | Promise<void>;
  /** Plugin-update pill wiring. Omitted where no marketplace detector runs. */
  pluginUpdates?: PluginUpdatesPillProps;
  /** Managed-plugin bootstrap pill wiring. Omitted where no bootstrap runs. */
  bootstrapStatus?: BootstrapStatusPillProps;
  /** 확인 필요 badge wiring (work-level approvals only). Omitted where no work board runs. */
  workApprovals?: WorkApprovalsBadgeProps;
}

export function MainToolbar({
  notice,
  viewNav,
  streaming: _streaming,
  hasApiKey: _hasApiKey,
  onOpenDevTools,
  appUpdateState = { kind: "idle" },
  appUpdateInFlight = false,
  onDownloadAppUpdate,
  onInstallAppUpdate,
  onSkipAppUpdate,
  pluginUpdates,
  bootstrapStatus,
  workApprovals,
}: MainToolbarProps) {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const updateCompaction = () => {
      delete toolbar.dataset.compact;
      const controls = toolbar.querySelector<HTMLElement>('[data-toolbar-controls]');
      if (toolbar.scrollWidth > toolbar.clientWidth || (controls && controls.scrollWidth > controls.clientWidth)) {
        toolbar.dataset.compact = "true";
      }
    };
    updateCompaction();
    const resize = new ResizeObserver(updateCompaction);
    resize.observe(toolbar);
    const content = new MutationObserver(updateCompaction);
    content.observe(toolbar, { childList: true, characterData: true, subtree: true });
    void document.fonts?.ready.then(updateCompaction);
    return () => { resize.disconnect(); content.disconnect(); };
  }, []);
  // The toolbar content lives IN the window-control band (CustomTitleBar): back / forward and the location path on the
  // leading edge, then a spacer (it stays a drag region) that pushes the status controls to the far-right edge. Each control
  // is wrapped `no-drag` so the surrounding band stays draggable.
  return (
    <div
      ref={toolbarRef}
      data-testid="main-toolbar"
      className="flex min-w-0 flex-1 items-center gap-(--chrome-gap-tight) sm:gap-(--chrome-gap) data-[compact=true]:[&_[data-toolbar-pill-label]]:hidden data-[compact=true]:[&_[data-toolbar-pill-trailing]]:hidden data-[compact=true]:[&_[data-toolbar-pill]]:w-(--chrome-control-height) data-[compact=true]:[&_[data-toolbar-pill]]:px-0"
    >
      {/* ── Location path, on the band's LEADING edge. The band itself reserves
          the sidebar card's width (CustomTitleBar's `leadClearance`), so this
          starts exactly where that card ends. Width-capped so a long path
          truncates rather than eating the drag region the user grabs to move
          the window. */}
      {/* Back / forward move between routes, across projects too (case 10). */}
      <NoDrag className="flex shrink-0 items-center">
        <ViewHistoryNav
          canGoBack={viewNav.canGoBack}
          canGoForward={viewNav.canGoForward}
          backLabel={viewNav.backLabel}
          forwardLabel={viewNav.forwardLabel}
          onBack={viewNav.onBack}
          onForward={viewNav.onForward}
        />
      </NoDrag>
      <NoDrag className="hidden min-w-0 max-w-[45%] shrink-0 items-center overflow-hidden md:flex in-data-[compact=true]:shrink">
        <ViewPathBreadcrumb segments={viewNav.segments} onSelectSegment={viewNav.onSelectSegment} />
      </NoDrag>

      {/* The intrinsic minimum comes from the notice controls, even when its message has no width. */}
      <div className="flex min-w-min flex-1 items-center justify-end" data-testid="main-toolbar-drag-band">
        {notice}
      </div>

      <div data-toolbar-controls="" data-testid="toolbar-status-controls" className="flex min-w-0 shrink items-center gap-(--chrome-gap-tight) overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {/* ── Lifecycle status pills, app-wide first then plugin-wide: app update,
          plugin updates, managed-plugin bootstrap. Each is permanent (NOT a
          toast) until acted on, and each renders nothing in its resting state,
          so the band gains no weight on a launch where everything is current.

          Plugin updates and bootstrap status used to float over the content as
          banners in the top-right stack. They sit here because they say the
          same kind of thing the app-update badge says — something about the
          install, waiting on the user — and one row of pills costs the content
          nothing.

          A pill at rest renders nothing, and an empty `no-drag` span is still a
          flex item that claims a gap — `empty:hidden` gives that width back to
          the drag region instead of leaving three holes in the band.

          The app-update download step is the user's first explicit consent.
          Never download before the user's explicit click. */}
      <NoDrag className="shrink-0 empty:hidden">
        <AppUpdateBadge
          state={appUpdateState}
          inFlight={appUpdateInFlight}
          onDownload={onDownloadAppUpdate}
          onInstall={onInstallAppUpdate}
          onSkip={onSkipAppUpdate}
        />
      </NoDrag>

      {pluginUpdates && (
        <NoDrag className="shrink-0 empty:hidden">
          <PluginUpdatesPill {...pluginUpdates} />
        </NoDrag>
      )}

      <NoDrag className="shrink-0 empty:hidden">
        <ZoomIndicator />
      </NoDrag>
      <NoDrag className="shrink-0 empty:hidden">
        <RemoteA2AActionButton />
      </NoDrag>

      {bootstrapStatus && (
        <NoDrag className="shrink-0 empty:hidden">
          <BootstrapStatusPill {...bootstrapStatus} />
        </NoDrag>
      )}

      {/* 확인 필요: renders nothing at zero and until its first result, like the pills above. */}
      {workApprovals && (
        <NoDrag className="shrink-0 empty:hidden">
          <WorkApprovalsBadge {...workApprovals} />
        </NoDrag>
      )}

      {/* Development controls stay at the trailing edge of the title band. */}
      {isDevMode() && onOpenDevTools !== undefined && (
        <NoDrag className="hidden shrink-0 sm:inline-flex">
          <ToolbarStatusPill
            tone="warning"
            icon={Wrench}
            label="Dev"
            title={t("mainToolbar.devToolsTooltip")}
            ariaLabel={t("mainToolbar.devToolsTitle")}
            trailing={
              <kbd className="rounded border border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) px-1 text-tiny">⇧⌘D</kbd>
            }
            onClick={onOpenDevTools}
            testId="dev-tools-toggle"
          />
        </NoDrag>
      )}

      </div>

      {/* The work-panel toggle used to sit here. It moved into the chat
          group's own header: the panel shows what THAT conversation is doing,
          and one window-level button cannot mean the right thing once more
          than one conversation is on screen. */}
    </div>
  );
}

/**
 * App-update pill — three render branches:
 *
 *   available   → info pill ("↓ v0.1.5"); click fires the download.
 *   downloading → muted pill with a spinner + percent; click is a no-op.
 *   downloaded  → success pill ("v0.1.5 적용"); click quits & installs.
 *
 * Nothing renders for `idle`, so the toolbar gains zero visual weight when
 * there's no update — important because most app launches are no-op
 * (already on latest).
 */
function AppUpdateBadge({
  state,
  inFlight = false,
  onDownload,
  onInstall,
  onSkip,
}: {
  state: AppUpdateBadgeState;
  /** When true, an IPC action (download/install) is in flight — disables the button to prevent rapid double-click during the
   * round-trip window before the main process broadcasts the next state. */
  inFlight?: boolean;
  onDownload?: () => void | Promise<void>;
  onInstall?: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  if (state.kind === "idle") return null;

  const skipAction = onSkip
    ? {
        icon: X,
        title: t("mainToolbar.skipUpdateTitle", { version: state.version }),
        ariaLabel: t("mainToolbar.skipUpdateAriaLabel", { version: state.version }),
        onClick: () => void onSkip(),
        disabled: inFlight,
        testId: "app-update-skip",
      }
    : undefined;

  if (state.kind === "available") {
    return (
      <ToolbarStatusPill
        tone="info"
        icon={ArrowDownToLine}
        label={`v${state.version}`}
        title={t("mainToolbar.updateAvailableTitle", { version: state.version })}
        ariaLabel={t("mainToolbar.updateDownloadAriaLabel", { version: state.version })}
        onClick={() => void onDownload?.()}
        disabled={inFlight}
        testId="app-update-badge-available"
        secondaryAction={skipAction}
      />
    );
  }

  if (state.kind === "downloading") {
    return (
      <ToolbarStatusPill
        tone="muted"
        icon={RefreshCw}
        busy
        label={`${state.percent}%`}
        title={t("mainToolbar.downloadingTitle", { version: state.version, percent: state.percent })}
        ariaLabel={t("mainToolbar.downloadingAriaLabel", { percent: state.percent })}
        disabled
        testId="app-update-badge-downloading"
      />
    );
  }

  // downloaded
  return (
    <ToolbarStatusPill
      tone="success"
      icon={Download}
      label={t("mainToolbar.applyUpdate", { version: state.version })}
      title={t("mainToolbar.downloadedTitle", { version: state.version })}
      ariaLabel={t("mainToolbar.updateInstallAriaLabel", { version: state.version })}
      onClick={() => void onInstall?.()}
      disabled={inFlight}
      testId="app-update-badge-downloaded"
      secondaryAction={skipAction}
    />
  );
}
