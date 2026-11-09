import { useState } from "react";
import { ArrowDownToLine, Download, RefreshCw, Wrench, X, MoreHorizontal } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Badge } from "../../components/ui/badge.js";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from "../../components/ui/dropdown-menu.js";
import { updateViewNeedsUser } from "../../shared/git-marketplace.js";
import { ToolbarStatusMenuContext } from "./components/toolbar-status-menu.js";
import { useContainerNarrow } from "./hooks/use-container-narrow.js";
import { ZoomIndicator } from "./components/ZoomControls.js";
import { ViewHistoryNav, ViewPathBreadcrumb, type ViewPathNavProps } from "./components/ViewPathNav.js";
import { useTranslation } from "../../i18n/react.js";
import { RemoteA2AActionButton } from "./components/RemoteA2AActionButton.js";
import { ToolbarStatusPill } from "./components/ToolbarStatusPill.js";
import { BootstrapStatusPill, type BootstrapStatusPillProps } from "./components/BootstrapStatusPill.js";
import { PluginUpdatesPill, type PluginUpdatesPillProps } from "./components/PluginUpdatesPill.js";
import type { WorkApprovalsProps } from "./components/work-approvals/WorkApprovalsList.js";
import { NotificationBell } from "./components/NotificationBell.js";
import type { NoticeRecord, NotificationHistory } from "./notification-history.js";

const STATUS_OVERFLOW_WIDTH = 768;

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
  notificationHistory?: NotificationHistory;
  onOpenNotification?: (notice: NoticeRecord) => void;
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
  /** Work-level approvals share the notification centre. */
  workApprovals?: WorkApprovalsProps;
}

export function MainToolbar({
  notificationHistory,
  onOpenNotification,
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
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const { isNarrow: overflow } = useContainerNarrow(toolbar, { enter: STATUS_OVERFLOW_WIDTH, exit: STATUS_OVERFLOW_WIDTH });
  const bootstrap = bootstrapStatus?.status;
  const pillCount = Number(appUpdateState.kind !== "idle")
    + Number((pluginUpdates?.updates.filter(updateViewNeedsUser).length ?? 0) > 0)
    + Number(bootstrap !== null && bootstrap !== undefined && (bootstrap.phase !== "complete" || bootstrap.skipped !== undefined || bootstrap.failed.length > 0))
    + Number(isDevMode() && onOpenDevTools !== undefined);
  const devControl = (<>
      {isDevMode() && onOpenDevTools !== undefined && (
        <NoDrag className="shrink-0">
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
  </>);
  const statusControls = (<>
      {/* Each control owns the same visibility and action in the band and menu. */}
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

      {overflow && devControl}
  </>);
  // The toolbar content lives IN the window-control band (CustomTitleBar): back / forward and the location path on the
  // leading edge, then a spacer (it stays a drag region) that pushes the status controls to the far-right edge. Each control
  // is wrapped `no-drag` so the surrounding band stays draggable.
  return (
    <div
      ref={setToolbar}
      data-testid="main-toolbar"
      className="flex min-w-0 flex-1 items-center gap-(--chrome-gap-tight) sm:gap-(--chrome-gap)"
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
      <NoDrag className="hidden min-w-0 max-w-[45%] shrink items-center overflow-hidden md:flex">
        <ViewPathBreadcrumb segments={viewNav.segments} onSelectSegment={viewNav.onSelectSegment} />
      </NoDrag>

      <div className="min-w-0 flex-1" data-testid="main-toolbar-drag-band" />

      <ToolbarStatusMenuContext.Provider value={overflow}>
        {overflow ? (
          <NoDrag className="shrink-0">
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" className="relative h-(--chrome-control-height) w-(--chrome-control-height) shrink-0" aria-label={t("mainToolbar.statusOverflow", { count: pillCount })} data-testid="toolbar-status-overflow">
                  <MoreHorizontal className="h-4 w-4" />
                  <Badge aria-hidden="true" className="pointer-events-none absolute -right-1 -top-1 h-3.5 min-w-3.5 justify-center p-0 text-tiny leading-none" data-testid="toolbar-status-overflow-count">{pillCount}</Badge>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-w-[calc(100vw-1rem)] max-h-(--radix-dropdown-menu-content-available-height) overflow-y-auto" data-testid="toolbar-status-menu">
                {statusControls}
              </DropdownMenuContent>
            </DropdownMenu>
          </NoDrag>
        ) : <div data-testid="toolbar-status-controls" className="flex shrink-0 items-center gap-(--chrome-gap-tight)">{statusControls}</div>}
      </ToolbarStatusMenuContext.Provider>
      <NoDrag className="shrink-0">
        <NotificationBell history={notificationHistory} workApprovals={workApprovals} onOpenNotification={onOpenNotification} />
      </NoDrag>
      {!overflow && devControl}

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
