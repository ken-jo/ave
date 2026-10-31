import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { SettingsPageHeader } from "../components/PageShell.js";
import { ConnectionRow, type ConnectionRowState } from "../components/ConnectionRow.js";
import { LocalApiSurfacesSection } from "./LocalApiSurfacesSection.js";
import {
  MessagingConnectionsSection,
  messagingConnectionRowForSection,
} from "./MessagingConnectionsSection.js";
import { TailnetAccessContent } from "./TailnetAccessContent.js";
import type { AveApi } from "../types.js";
import type { TailnetObserverSnapshot } from "../../../shared/tailnet-observer-config.js";

export interface RemoteSurfacesTabProps {
  api: AveApi;
  /**
   * The `data-settings-section` a deep link named, while it is still unapplied.
   *
   * The tab needs it because arrival looks its anchor up in the DOM, and an
   * anchor inside a collapsed row is not in the DOM: without this the link
   * would land the reader at the top of the page with the section they asked
   * for still folded away.
   */
  sectionTarget?: string | null;
}

const TAILNET_ROW = "connection:tailnet";
const LOCAL_API_ROW = "connection:local-api";

/** The local API binds loopback-only and cannot be made to bind anything else — the guard is in `src/api/http-server.ts`.
 * The row names the address because "on" is not one, and this is what a companion actually connects to. */
const LOCAL_API_HOST = "127.0.0.1";

/** What main answers when a switched-on remote A2A gate did not start this run. */
const REMOTE_A2A_START_FAILED = "a2a-remote-start-failed";

/** The four opt-ins the local-API row summarizes and its body switches. */
const LOCAL_API_GATE_COUNT = 4;

/**
 * Which row holds each anchor the registry lists for this tab.
 *
 * `remote-messaging-connections` is deliberately absent: it names the group of
 * installed connections, which is always mounted, so arrival finds it without
 * anything having to open.
 */
const ROW_FOR_SECTION: Readonly<Record<string, string>> = Object.freeze({
  "remote-tailnet": TAILNET_ROW,
  "remote-tailnet-observer": TAILNET_ROW,
  "remote-local-api": LOCAL_API_ROW,
});

/** What the collapsed Tailnet and local-API lines say, read from the host. */
interface HostSurfaceReadings {
  readonly tailnet: ConnectionRowState | null;
  readonly tailnetOrigin: string | null;
  readonly localApi: ConnectionRowState | null;
  /** Null when the settings could not be read, so no count is claimed. */
  readonly localApiGatesOn: number | null;
}

const UNREAD: HostSurfaceReadings = Object.freeze({
  tailnet: null,
  tailnetOrigin: null,
  localApi: null,
  localApiGatesOn: null,
});

/** Listener/probe failures mean needs attention; a running listener without external serving still needs setup rather than
 * claiming connectivity. */
function tailnetRowState(snapshot: TailnetObserverSnapshot): ConnectionRowState {
  if (snapshot.configFileError !== null
    || snapshot.lastStartError !== null
    || snapshot.pairedSharingBootstrapFailed) {
    return "attention";
  }
  if (!snapshot.effective.enabled || snapshot.listeningPort === null) return "needs-setup";
  if (snapshot.environment.state !== "ready") return "attention";
  const serveOn = snapshot.environment.serveConfigured
    && snapshot.environment.serveTargetPort === snapshot.listeningPort;
  return serveOn ? "connected" : "needs-setup";
}

/** Connection rows open independently, collapse after success, and stay open with errors after failure. */
export function RemoteSurfacesTab({ api, sectionTarget = null }: RemoteSurfacesTabProps) {
  const { t } = useTranslation();
  const [expandedRowIds, setExpandedRowIds] = useState<readonly string[]>([]);
  const [readings, setReadings] = useState<HostSurfaceReadings>(UNREAD);

  const toggleRow = useCallback((rowId: string) => {
    setExpandedRowIds((open) => (
      open.includes(rowId) ? open.filter((id) => id !== rowId) : [...open, rowId]
    ));
  }, []);

  const closeRow = useCallback((rowId: string) => {
    setExpandedRowIds((open) => open.filter((id) => id !== rowId));
  }, []);

  useEffect(() => {
    if (sectionTarget === null) return;
    const row = ROW_FOR_SECTION[sectionTarget] ?? messagingConnectionRowForSection(sectionTarget);
    // Not every anchor on this tab belongs to a row. One that does not is already in the DOM, and arrival will find it on its
    // own.
    if (row === undefined || row === null) return;
    setExpandedRowIds((open) => (open.includes(row) ? open : [...open, row]));
  }, [sectionTarget]);

  // Re-read whenever the open set changes. Neither the Tailnet listener config
  // nor the local-API gates emit a change event, and the only things that write
  // them are the controls inside these rows — so a row opening or closing is
  // exactly the moment a collapsed line could be reporting a stale answer.
  useEffect(() => {
    let alive = true;
    void (async () => {
      // Settled separately: one read failing must not leave the other row unread, and a rejected read is a state to show, not an
      // unhandled rejection that leaves both lines blank.
      const [observerRead, settingsRead, remoteA2ARead] = await Promise.allSettled([
        api.tailnetObserver.snapshot(),
        api.getSettings(),
        api.remoteA2a.status(),
      ]);
      if (!alive) return;
      const observer = observerRead.status === "fulfilled" && observerRead.value.ok
        ? observerRead.value.snapshot
        : null;
      const settings = settingsRead.status === "fulfilled" ? settingsRead.value : null;
      const gatesOn = settings === null ? null : [
        settings.system?.localApiServer,
        settings.features?.a2aLoopbackServer,
        settings.features?.a2aRemoteRouting,
        settings.features?.a2aRemoteReceiver,
      ].filter((gate) => gate === true).length;
      // The switches say what the owner asked for; this says whether the remote
      // A2A runtime behind two of them actually came up. A switch that is on
      // over a runtime that failed to start is not "connected". A status read
      // that itself failed claims nothing either way.
      const remoteA2AStartFailed = remoteA2ARead.status === "fulfilled"
        && !remoteA2ARead.value.ok
        && remoteA2ARead.value.error === REMOTE_A2A_START_FAILED;
      // A switch moved since launch is configured but not running: the owner's next move is a restart, which is what "pending"
      // means on this row.
      const remoteA2ARestartPending = remoteA2ARead.status === "fulfilled"
        && remoteA2ARead.value.restartPending === true;
      setReadings({
        tailnet: observer === null ? "attention" : tailnetRowState(observer),
        tailnetOrigin: observer?.derivedWebOrigin ?? null,
        // Off rather than "setup needed": these four are the owner's own switches, and all of them down is a resting state, not an
        // unfinished one.
        localApi: gatesOn === null || remoteA2AStartFailed
          ? "attention"
          : remoteA2ARestartPending
            ? "pending"
            : gatesOn > 0 ? "connected" : "off",
        localApiGatesOn: gatesOn,
      });
    })();
    return () => { alive = false; };
  }, [api, expandedRowIds]);

  const localApiSubline = useMemo(
    () => (readings.localApiGatesOn === null ? null : t("localApiSurfaces.rowSubline", {
      host: LOCAL_API_HOST,
      enabled: String(readings.localApiGatesOn),
      total: String(LOCAL_API_GATE_COUNT),
    })),
    [readings.localApi, readings.localApiGatesOn, t],
  );

  return (
    <div className="space-y-4" data-testid="remote-surfaces-tab">
      <SettingsPageHeader
        title={t("settingsContent.tabRemoteSurfaces")}
        description={t("remoteSurfacesTab.pageDescription")}
      />
      <div
        className="flex flex-col gap-3"
        data-testid="remote-connections-list"
      >
        <ConnectionRow
          label={t("remoteSurfacesTab.tailnetSectionTitle")}
          state={readings.tailnet}
          endpoint={readings.tailnetOrigin}
          expanded={expandedRowIds.includes(TAILNET_ROW)}
          onToggle={() => toggleRow(TAILNET_ROW)}
          testId={TAILNET_ROW}
        >
          <TailnetAccessContent api={api} onCompleted={() => closeRow(TAILNET_ROW)} />
        </ConnectionRow>

        <MessagingConnectionsSection
          api={api}

          expandedRowIds={expandedRowIds}
          onToggleRow={toggleRow}
          onRowCompleted={closeRow}
        />

        {/* Last, and this desktop's own setting rather than a vendor — but the
            place a person looks for "what can reach this machine" is this one
            list, so it is a row in it. */}
        <ConnectionRow
          label={t("localApiSurfaces.sectionTitle")}
          state={readings.localApi}
          endpoint={localApiSubline}
          expanded={expandedRowIds.includes(LOCAL_API_ROW)}
          onToggle={() => toggleRow(LOCAL_API_ROW)}
          testId={LOCAL_API_ROW}
        >
          <LocalApiSurfacesSection />
        </ConnectionRow>
      </div>
    </div>
  );
}
