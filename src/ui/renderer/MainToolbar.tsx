import { ArrowDownToLine, Download, RefreshCw, Wrench, X } from "lucide-react";
import { ViewPathBreadcrumb, type ViewPathNavProps } from "./components/ViewPathNav.js";
import { useTranslation } from "../../i18n/react.js";
import { RemoteA2AActionButton } from "./components/RemoteA2AActionButton.js";
import { ToolbarStatusPill } from "./components/ToolbarStatusPill.js";
import { BootstrapStatusPill, type BootstrapStatusPillProps } from "./components/BootstrapStatusPill.js";
import { PluginUpdatesPill, type PluginUpdatesPillProps } from "./components/PluginUpdatesPill.js";

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
}

export function MainToolbar({
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
}: MainToolbarProps) {
  const { t } = useTranslation();
  // The toolbar content lives IN the window-control band (CustomTitleBar). The
  // search / star / export controls + the collapse toggle moved into the
  // floating sidebar's cluster strip next to the traffic lights, so this band
  // hosts only the RIGHT-aligned controls. A leading spacer (stays a drag
  // region) pushes them to the far-right edge; each control is wrapped `no-drag`
  // so the surrounding band stays draggable.
  return (
    <div
      data-testid="main-toolbar"
      className="flex min-w-0 flex-1 items-center gap-(--chrome-gap-tight) sm:gap-(--chrome-gap)"
    >
      {/* ── Location path, on the band's LEADING edge. The band itself reserves
          the sidebar card's width (CustomTitleBar's `leadClearance`), so this
          starts exactly where that card ends. Width-capped so a long path
          truncates rather than eating the drag region the user grabs to move
          the window. */}
      <NoDrag className="flex min-w-0 max-w-[45%] shrink-0 items-center">
        <ViewPathBreadcrumb segments={viewNav.segments} onSelectSegment={viewNav.onSelectSegment} />
      </NoDrag>

      {/* ── Spacer pushes the trailing controls to the far-right edge (stays drag) */}
      <div className="min-w-0 flex-1 sm:min-w-[64px]" aria-hidden="true" data-testid="main-toolbar-drag-band" />

      <NoDrag>
        <RemoteA2AActionButton />
      </NoDrag>

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
      <NoDrag className="empty:hidden">
        <AppUpdateBadge
          state={appUpdateState}
          inFlight={appUpdateInFlight}
          onDownload={onDownloadAppUpdate}
          onInstall={onInstallAppUpdate}
          onSkip={onSkipAppUpdate}
        />
      </NoDrag>

      {pluginUpdates && (
        <NoDrag className="empty:hidden">
          <PluginUpdatesPill {...pluginUpdates} />
        </NoDrag>
      )}

      {bootstrapStatus && (
        <NoDrag className="empty:hidden">
          <BootstrapStatusPill {...bootstrapStatus} />
        </NoDrag>
      )}

      {/* Development controls stay at the trailing edge of the title band. */}
      {isDevMode() && onOpenDevTools !== undefined && (
        <NoDrag className="hidden sm:inline-flex">
          <ToolbarStatusPill
            tone="warning"
            icon={Wrench}
            label="Dev"
            title={t("mainToolbar.devToolsTooltip")}
            ariaLabel={t("mainToolbar.devToolsTitle")}
            trailing={
              <kbd className="rounded border border-warning/(--opacity-medium) bg-warning/(--opacity-subtle) px-1 text-[9.5px]">⇧⌘D</kbd>
            }
            onClick={onOpenDevTools}
            testId="dev-tools-toggle"
          />
        </NoDrag>
      )}

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
