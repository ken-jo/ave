import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Separator } from "../../../components/ui/separator.js";
import { Switch } from "../../../components/ui/switch.js";
import { sanitizePluginConfig, sanitizePluginConfigKey } from "../../../shared/plugin-config.js";
import { getApi } from "../api-client.js";
import { getHostMarketplaceApi } from "../host-marketplace-api.js";
import type {
  AveApi,
  PluginCardSummary,
  PluginContributionTrustRow,
} from "../types.js";
import { PluginAuthSection } from "../components/PluginAuthSection.js";
import { usePluginAuthStatuses } from "../hooks/use-plugin-auth-status.js";
import { PluginUninstallDialog } from "../dialogs/PluginUninstallDialog.js";
import {
  getPluginDoctorInstallKey,
  repairPluginFromMarketplace,
  resolvePluginProtocolUpdatePath,
  type PluginProtocolUpdatePath,
} from "./plugin-doctor-match.js";
import { requestDirectInstall, requestUpdateReview } from "./git-marketplace/update-review-request.js";
import { requestNewChatDraft } from "../chat-draft-request.js";
import { buildProtocol4MigrationPrompt } from "./plugin-migration-prompt.js";
import { PluginConfigSchemaForm } from "./PluginConfigSchemaForm.js";
import { PluginPerfTab } from "./PluginPerfTab.js";
import { DEFAULT_TOAST_TTL_MS } from "../constants.js";
import { useNotifySaved } from "../context/SavedToastContext.js";
import { MARKDOWN_REMARK_PLUGINS } from "../utils/markdown-plugins.js";
import { isPluginInstallKey } from "../utils/plugin-install-aliases.js";
import { SettingsPageHeader } from "../components/PageShell.js";
import { useTranslation } from "../../../i18n/react.js";
import { isReinstallFixableFailureKind } from "../../../shared/plugin-install-failure.js";
import { errorMessage } from "../../../shared/error-message.js";

import { useAlertKinds } from "../hooks/use-alert-kinds.js";
import { PluginAlertsSection } from "./PluginAlertsSection.js";
import { ALERT_HOST_PLUGIN_ID } from "../../../shared/alerts-types.js";

type KV = { key: string; value: string };
type BannerType = "error" | "success" | "warning";

const PREPARATION_PHASE_I18N_KEY: Record<string, string> = {
  pending: "pluginConfigTab.prepPhasePending",
  "installing-python": "pluginConfigTab.prepPhaseInstallingPython",
  "installing-deps": "pluginConfigTab.prepPhaseInstallingDeps",
  verifying: "pluginConfigTab.prepPhaseVerifying",
  ready: "pluginConfigTab.prepPhaseReady",
  error: "pluginConfigTab.prepPhaseError",
};

/** Doctor text for the arm a plugin's factory came from (§9.8 A1, decision 51). */
const ARM_I18N_KEY: Record<NonNullable<PluginCardSummary["arm"]>, string> = {
  child: "pluginConfigTab.armChild",
  "in-process": "pluginConfigTab.armInProcess",
};

/** Doctor text for each confinement a plugin can report — one per value. */
const CONFINEMENT_I18N_KEY: Record<NonNullable<PluginCardSummary["confinement"]>, string> = {
  "macos-sandbox": "pluginConfigTab.confinementMacosSandbox",
  "linux-bubblewrap": "pluginConfigTab.confinementLinuxBubblewrap",
  "windows-srt": "pluginConfigTab.confinementWindowsSrt",
  unconfined: "pluginConfigTab.confinementUnconfined",
  "not-spawned": "pluginConfigTab.confinementNotSpawned",
};

/** Where a plugin runs and under which wrap: shown by the Doctor panel for a failed plugin and by the loaded-plugin row for
 * a running one. Renders nothing when the card carries no arm — a failure before routing. */
function PluginRuntimeArm({ plugin, surface }: { plugin: PluginCardSummary; surface: "row" | "doctor" }) {
  const { t } = useTranslation();
  if (!plugin.arm || !plugin.confinement) return null;
  const line = t("pluginConfigTab.runtimeArmLine", {
    arm: t(ARM_I18N_KEY[plugin.arm]),
    confinement: t(CONFINEMENT_I18N_KEY[plugin.confinement]),
  });
  if (surface === "row") {
    return (
      <div
        data-testid={`plugin-config:row-arm:${plugin.id}`}
        data-arm={plugin.arm}
        data-confinement={plugin.confinement}
        className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground"
      >
        {line}
      </div>
    );
  }
  return (
    <p
      data-testid={`plugin-config:doctor-arm:${plugin.id}`}
      data-arm={plugin.arm}
      data-confinement={plugin.confinement}
      className="mt-1 break-words text-[11px] text-destructive/(--opacity-intense)"
    >
      <span className="font-medium">{t("pluginConfigTab.runtimeArmLabel")}</span>: {line}
    </p>
  );
}

/** The last refused update or restart of a RUNNING plugin (decision 52): one muted line on the loaded row. The plugin stays
 * loaded at its running version, so this is not a failure state and the Doctor panel does not open. */
function PluginLastAttemptRefusal({ plugin }: { plugin: PluginCardSummary }) {
  const { t } = useTranslation();
  const refusal = plugin.lastAttemptRefusal;
  if (plugin.loadStatus !== "loaded" || !refusal) return null;
  return (
    <div
      data-testid={`plugin-config:row-refusal:${plugin.id}`}
      data-attempt={refusal.attempt}
      className="mt-0.5 line-clamp-2 break-words text-[10px] text-muted-foreground"
    >
      {refusal.attempt === "update"
        ? t("pluginConfigTab.lastUpdateRefused", { message: refusal.message })
        : t("pluginConfigTab.lastRestartRefused", { message: refusal.message })}
    </div>
  );
}

function isRuntimeCallablePlugin(plugin: PluginCardSummary): boolean {
  return plugin.runtimeLoaded ?? (plugin.loadStatus === "loaded");
}

function findRefreshedDoctorPlugin(
  cards: readonly PluginCardSummary[],
  plugin: PluginCardSummary,
  additionalKeys: readonly string[] = [],
): PluginCardSummary | undefined {
  const lookupKeys = [plugin.id, ...(plugin.installAliases ?? []), ...additionalKeys];
  return cards.find((card) =>
    lookupKeys.some((key) => isPluginInstallKey(card.id, key, card.installAliases)),
  );
}

function isDoctorRepairLoaded(plugin: PluginCardSummary | undefined): boolean {
  return plugin?.loadStatus === "loaded" && isRuntimeCallablePlugin(plugin);
}

function clampProgressPct(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function PluginPreparationStatusPanel({ plugin }: { plugin: PluginCardSummary }) {
  const { t } = useTranslation();
  if (plugin.loadStatus !== "preparing") return null;
  const status = plugin.preparationStatus;
  const progressPct = clampProgressPct(status?.progressPct);
  const phaseLabel = status?.phase
    ? (PREPARATION_PHASE_I18N_KEY[status.phase] ? t(PREPARATION_PHASE_I18N_KEY[status.phase]) : status.phase)
    : t("pluginConfigTab.prepPhasePending");
  const message = status?.message ?? t("pluginConfigTab.preparingRuntime");
  return (
    <div className="space-y-2 rounded-sm bg-warning/(--opacity-subtle) px-3 py-2" aria-live="polite">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <div className="text-[10px] font-medium uppercase text-warning">{t("pluginConfigTab.preparationStatusLabel")}</div>
          <div className="text-xs font-medium text-foreground">{phaseLabel}</div>
          <div className="break-words text-[11px] text-muted-foreground">{message}</div>
        </div>
        {progressPct !== null && (
          <div className="shrink-0 font-mono text-[11px] text-warning tabular-nums">{progressPct}%</div>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-warning/(--opacity-light)">
        {/* Determinate fill flows through --progress so the geometry stays
            in classes; the indeterminate state keeps the pulsing w-1/3. */}
        <div
          className={`h-full rounded-full bg-warning transition-all ${progressPct === null ? "w-1/3 animate-pulse" : "w-[var(--progress)]"}`}
          style={progressPct === null ? undefined : ({ "--progress": `${progressPct}%` } as CSSProperties)}
        />
      </div>
      <div className="text-[10px] text-muted-foreground">
        {t("pluginConfigTab.preparationAutoLoad")}
      </div>
    </div>
  );
}

function configToEntries(config: Record<string, unknown>): KV[] {
  return Object.entries(config).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

function entriesToConfig(entries: KV[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { key, value } of entries) {
    const k = sanitizePluginConfigKey(key.trim());
    if (!k) continue;
    // Try to parse JSON values (numbers, booleans, objects); fall back to string.
    try {
      out[k] = JSON.parse(value);
    } catch {
      out[k] = value;
    }
  }
  return sanitizePluginConfig(out);
}

export function PluginConfigTab({ api, initialPluginId, onNavigate }: { api?: AveApi; initialPluginId?: string | null; onNavigate?: (tab: string) => void } = {}) {
  const alertsApi = api ?? (() => { try { return getApi(); } catch { return null; } })();
  const alerts = useAlertKinds(alertsApi);
  const { t } = useTranslation();
  // Pull the dialog-wide "저장되었습니다" notifier so every successful
  // plugin-config write — manual key/value editor save, schema-form save,
  // and per-secret writes — surfaces a uniform toast next to the user's
  // gaze without each tab having to roll its own banner.
  const notifySaved = useNotifySaved();
  const [plugins, setPlugins] = useState<PluginCardSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { if (initialPluginId) setSelectedId(initialPluginId); }, [initialPluginId]);
  const unseen = new Map<string, number>();
  for (const row of alerts.rows) { if (!row.choice.seenByUser) unseen.set(row.pluginId, (unseen.get(row.pluginId) ?? 0) + 1); }
  const [uninstallTarget, setUninstallTarget] = useState<PluginCardSummary | null>(null);
  // Tools list is collapsed by default — plugins that declare many tools would otherwise dominate the detail panel. Reset to
  // collapsed on plugin switch.
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [contributionTrust, setContributionTrust] = useState<PluginContributionTrustRow[]>([]);
  const [contributionTrustError, setContributionTrustError] = useState<string | null>(null);
  const contributionTrustRefreshRef = useRef(0);
  const [trustUpdating, setTrustUpdating] = useState<string | null>(null);
  useEffect(() => {
    setToolsExpanded(false);
  }, [selectedId]);
  // Memoize the preload API once so auth listeners stay stable; absent bridges disable the hook for isolated tests.
  const apiForAuthHook = useMemo(() => {
    try { return getApi(); } catch { return null; }
  }, []);
  const { statuses: authStatuses, refresh: refreshAuthStatus } = usePluginAuthStatuses(
    apiForAuthHook,
    plugins,
  );
  const [entries, setEntries] = useState<KV[]>([]);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [doctoringId, setDoctoringId] = useState<string | null>(null);
  const [protocolUpdatePath, setProtocolUpdatePath] = useState<PluginProtocolUpdatePath | null>(null);
  const [banner, setBanner] = useState<{ type: BannerType; msg: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showBanner = useCallback((type: BannerType, msg: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ type, msg });
    bannerTimerRef.current = setTimeout(() => setBanner(null), DEFAULT_TOAST_TTL_MS);
  }, []);

  const refreshContributionTrust = useCallback(async (pluginId: string | null): Promise<void> => {
    const refreshId = ++contributionTrustRefreshRef.current;
    if (!pluginId) {
      setContributionTrust([]);
      setContributionTrustError(null);
      return;
    }
    setContributionTrust([]);
    setContributionTrustError(null);
    try {
      const result = await getApi().listPluginContributionTrust(pluginId);
      if (refreshId !== contributionTrustRefreshRef.current) return;
      if (!result.ok) {
        setContributionTrustError(t("pluginConfigTab.contributionTrustError"));
        return;
      }
      setContributionTrust(result.rows);
    } catch {
      if (refreshId !== contributionTrustRefreshRef.current) return;
      setContributionTrustError(t("pluginConfigTab.contributionTrustError"));
    }
  }, []);

  useEffect(() => {
    void refreshContributionTrust(selectedId);
  }, [refreshContributionTrust, selectedId]);

  const handleContributionTrust = useCallback(async (
    row: PluginContributionTrustRow,
    approved: boolean,
  ): Promise<void> => {
    const key = `${row.kind}:${row.localId}`;
    setTrustUpdating(key);
    try {
      // An approval binds to the generation and digest this row showed (design §18.7.5).
      const result = await getApi().setPluginContributionTrust({
        pluginId: row.pluginId,
        localId: row.localId,
        kind: row.kind,
        approved,
        ...(approved ? { generationId: row.generationId, approvalDigest: row.approvalDigest } : {}),
      });
      if (!result.ok) {
        if (result.error === "contribution-trust-review-stale") {
          // The package changed since this list was read: say so, and show what is installed now.
          showBanner("error", t("gitMarketplace.error.planExpired.packageChanged"));
          await refreshContributionTrust(row.pluginId);
          return;
        }
        showBanner("error", result.message ?? t("pluginConfigTab.contributionTrustError"));
        return;
      }
      await refreshContributionTrust(row.pluginId);
    } catch (error) {
      showBanner("error", errorMessage(error) || t("pluginConfigTab.contributionTrustError"));
    } finally {
      setTrustUpdating(null);
    }
  }, [refreshContributionTrust, showBanner]);

  useEffect(() => {
    return () => {
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    };
  }, []);

  // Refresh cards on install/uninstall results; only the latest read may replace visible state, while callers still receive
  // their own result.
  const cardsReadTokenRef = useRef(0);
  const refreshPlugins = useCallback(async (
    options?: { preferInstallKey?: string },
  ): Promise<PluginCardSummary[] | null> => {
    const token = ++cardsReadTokenRef.current;
    try {
      const cards = await window.ave.plugins.cards();
      if (token !== cardsReadTokenRef.current) return cards;
      setPlugins(cards);
      setSelectedId((current) => {
        const preferredInstallKey = options?.preferInstallKey;
        if (preferredInstallKey) {
          const preferred = cards.find((card) =>
            isPluginInstallKey(card.id, preferredInstallKey, card.installAliases),
          );
          if (preferred) return preferred.id;
        }
        if (current && cards.some((c) => c.id === current)) return current;
        const failed = cards.find((card) => card.loadStatus === "failed");
        if (failed) return failed.id;
        return cards.length > 0 ? cards[0].id : null;
      });
      return cards;
    } catch (e) {
      if (token === cardsReadTokenRef.current) {
        showBanner("error", errorMessage(e) || t("pluginConfigTab.errorLoadPlugins"));
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, [showBanner, t]);

  // #1176 — toggle a plugin active/inactive. Inactive plugins stay loaded but their tools are hidden from the model.
  // Optimistically reflects the new loadStatus, then refreshes from the runtime (which is the source of truth).
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const handleToggleEnabled = useCallback(
    async (pluginId: string, nextEnabled: boolean) => {
      setTogglingId(pluginId);
      try {
        const res = await getApi().setPluginEnabled(pluginId, nextEnabled);
        if (!res.ok) {
          showBanner("error", res.message ?? t("pluginConfigTab.errorToggleEnabled"));
          return;
        }
        await refreshPlugins();
      } catch (e) {
        showBanner("error", errorMessage(e) || t("pluginConfigTab.errorToggleEnabled"));
      } finally {
        setTogglingId(null);
      }
    },
    [refreshPlugins, showBanner, t],
  );

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  // Sync with main-process lifecycle events. Both install (via `ave://`
  // deep link) and uninstall (via this tab or any other surface) emit
  // result events that the renderer subscribes to in App.tsx for plugin view
  // refresh — wire the same hooks here so the settings list stays in sync.
  useEffect(() => {
    // `getApi()` throws if `window.aveApi` isn't initialized — that path is
    // taken by jsdom unit tests that mock only `window.ave`. Skip the
    // subscriptions in that case so the existing tests pass without forcing
    // every consumer test to provide both namespaces.
    let api: ReturnType<typeof getApi>;
    try {
      api = getApi();
    } catch {
      return;
    }
    const unsubs: Array<() => void> = [];
    if (typeof api.onPluginInstallResult === "function") {
      unsubs.push(
        // A failed install can still change a card: a refused update of a running plugin is recorded on its loaded row
        // (`lastAttemptRefusal`, §9.8 A1), so both outcomes re-read the cards.
        api.onPluginInstallResult(() => {
          void refreshPlugins();
        }),
      );
    }
    if (typeof api.onPluginUninstallResult === "function") {
      unsubs.push(
        api.onPluginUninstallResult(({ success }) => {
          if (success) {
            void refreshPlugins();
          }
        }),
      );
    }
    // #1176 — refresh when a plugin's active/inactive state changes from any surface so the list badges + tools panel reflect
    // the toggle.
    if (typeof api.onPluginEnabledChanged === "function") {
      unsubs.push(
        api.onPluginEnabledChanged(() => {
          void refreshPlugins();
        }),
      );
    }
    return () => {
      for (const u of unsubs) u();
    };
  }, [refreshPlugins]);

  useEffect(() => {
    if (!plugins.some((plugin) => plugin.loadStatus === "preparing")) return;
    const interval = window.setInterval(() => {
      void refreshPlugins();
    }, 750);
    return () => window.clearInterval(interval);
  }, [plugins, refreshPlugins]);

  // Load config for selected plugin
  const [savedConfig, setSavedConfig] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (!selectedId) {
      setEntries([]);
      setSavedConfig({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await window.ave.pluginConfig.get(selectedId);
        if (cancelled) return;
        if (!result.ok) {
          setEntries([]);
          setSavedConfig({});
          showBanner("error", result.message ?? t("pluginConfigTab.errorLoadConfig"));
          return;
        }
        setEntries(configToEntries(result.config));
        setSavedConfig(result.config as Record<string, unknown>);
      } catch (e) {
        if (!cancelled) showBanner("error", errorMessage(e) || t("pluginConfigTab.errorLoadConfig"));
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId, showBanner]);

  const handleAddEntry = useCallback(() => {
    let k: string;
    try {
      k = sanitizePluginConfigKey(newKey.trim());
    } catch (e) {
      showBanner("error", errorMessage(e));
      return;
    }
    if (entries.some((e) => e.key === k)) {
      showBanner("error", t("pluginConfigTab.errorKeyExists", { key: k }));
      return;
    }
    setEntries((prev) => [...prev, { key: k, value: newValue }]);
    setNewKey("");
    setNewValue("");
  }, [newKey, newValue, entries, showBanner, t]);

  const handleRemoveEntry = useCallback((key: string) => {
    setEntries((prev) => prev.filter((e) => e.key !== key));
  }, []);

  const handleUpdateValue = useCallback((key: string, value: string) => {
    setEntries((prev) => prev.map((e) => (e.key === key ? { ...e, value } : e)));
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedId) return;
    setSaving(true);
    try {
      const config = entriesToConfig(entries);
      const result = await window.ave.pluginConfig.set(selectedId, config);
      if (!result.ok) {
        showBanner("error", result.message ?? t("pluginConfigTab.errorSave"));
        return;
      }
      setEntries(configToEntries(result.config));
      showBanner("success", t("pluginConfigTab.successSaved"));
      notifySaved();
    } catch (e) {
      showBanner("error", errorMessage(e) || t("pluginConfigTab.errorSave"));
    } finally {
      setSaving(false);
      // A save restarts the plugin, and the restart's outcome is on its card: a refusal recorded, or a recorded one cleared by
      // the commit.
      void refreshPlugins();
    }
  }, [selectedId, entries, showBanner, notifySaved, refreshPlugins, t]);

  const selectedPlugin = plugins.find((p) => p.id === selectedId);
  useEffect(() => {
    let current = true;
    setProtocolUpdatePath(null);
    const legacyLoaded = selectedPlugin?.loadStatus !== "failed" && selectedPlugin?.hostProtocol === "3";
    if (legacyLoaded || (selectedPlugin?.loadStatus === "failed" && selectedPlugin.installFailureKind === "incompatible-host-protocol")) {
      void resolvePluginProtocolUpdatePath((api ?? getApi()).gitMarketplace, selectedPlugin)
        .then((path) => { if (current) setProtocolUpdatePath(path); })
        .catch(() => { if (current) setProtocolUpdatePath({ kind: "unavailable" }); });
    }
    return () => { current = false; };
  }, [api, selectedId, selectedPlugin?.loadStatus, selectedPlugin?.installFailureKind, selectedPlugin?.hostProtocol]);
  const selectedPluginActive = selectedPlugin
    ? (selectedPlugin.active ?? selectedPlugin.loadStatus !== "disabled")
    : false;
  const selectedPluginRuntimeLoaded = selectedPlugin ? isRuntimeCallablePlugin(selectedPlugin) : false;
  // The active-state switch is shown for a callable runtime AND for a disabled
  // plugin. Disable retires the plugin's generation, so a disabled plugin has
  // no runtime (`runtimeLoaded: false`), and this switch is the only way to
  // enable it again. A failed or preparing plugin has neither, and no switch.
  const selectedPluginToggleable = selectedPlugin
    ? selectedPluginRuntimeLoaded || selectedPlugin.loadStatus === "disabled"
    : false;
  // §9.2 — merge schema-declared defaults with the saved config so the typed form always shows the value the plugin will
  // actually receive (defaults first, saved overrides win).
  const mergedConfigValues = useMemo(() => {
    const schema = selectedPlugin?.configSchema;
    if (!schema?.properties) return savedConfig;
    const merged: Record<string, unknown> = { ...savedConfig };
    for (const [key, prop] of Object.entries(schema.properties)) {
      if (merged[key] === undefined && prop.default !== undefined) {
        merged[key] = prop.default;
      }
    }
    return merged;
  }, [selectedPlugin, savedConfig]);
  // US-3c.1: build secretsPresent map for PluginConfigSchemaForm. Batches a single IPC call per plugin selection to find
  // which secret fields already have a value in the keychain, so the masked input shows

  const [secretsPresent, setSecretsPresent] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!selectedId) {
      setSecretsPresent({});
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const result = await window.ave.pluginConfig.listSecretKeys(selectedId);
        if (cancelled) return;
        if (result && result.ok && Array.isArray(result.keys)) {
          const map: Record<string, boolean> = {};
          for (const k of result.keys as string[]) {
            map[k] = true;
          }
          setSecretsPresent(map);
        } else {
          setSecretsPresent({});
        }
      } catch {
        if (!cancelled) setSecretsPresent({});
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  const isDevMode = window.ave?.env?.isDev === true;
  const [localInstalling, setLocalInstalling] = useState(false);

  const handleInstallLocal = useCallback(async () => {
    let api: ReturnType<typeof getApi>;
    try {
      api = getApi();
    } catch {
      showBanner("error", t("pluginConfigTab.errorApiUnavailable"));
      return;
    }
    setLocalInstalling(true);
    try {
      const result = await api.installLocalPlugin?.();
      if (!result) {
        // user canceled the dialog
        return;
      }
      showBanner("success", t("pluginConfigTab.successLocalInstall", { pluginId: result.pluginId }));
      void refreshPlugins();
    } catch (e) {
      const message = errorMessage(e);
      showBanner("error", message.includes("process-entry-requires-pinned-artifact")
        ? t("formatIpcError.processEntryRequiresPinnedArtifact")
        : message.includes("process-entry-unconfined")
          ? t("formatIpcError.processEntryUnconfined")
          : message || t("pluginConfigTab.errorLocalInstall"));
    } finally {
      setLocalInstalling(false);
    }
  }, [showBanner, refreshPlugins, t]);

  const handleDoctorPlugin = useCallback(async (plugin: PluginCardSummary) => {
    setDoctoringId(plugin.id);
    try {
      // Cause-aware Doctor. NOT-reinstall-fixable failures (sandbox grant outside
      // its ceiling, app-version incompatibility) cannot be repaired by reinstalling — a
      // reinstall re-fetches the same broken/too-new package and re-fails. Refresh
      // the source of truth, but keep the outcome explicitly unresolved unless the
      // runtime now reports a loaded card.
      if (!isReinstallFixableFailureKind(plugin.installFailureKind)) {
        const refreshedCards = await refreshPlugins();
        if (!refreshedCards) return;
        const refreshedPlugin = findRefreshedDoctorPlugin(refreshedCards, plugin);
        if (isDoctorRepairLoaded(refreshedPlugin)) {
          showBanner("success", t("pluginConfigTab.successDoctor", { displayName: plugin.name }));
        } else {
          showBanner("warning", t("pluginConfigTab.doctorDiagnosticUnresolved", { displayName: plugin.name }));
        }
        return;
      }

      // Reinstall-fixable failure (stale/pre-v6 on-disk manifest, missing/corrupt
      // files, generic load error) → reinstall the version on disk from the
      // plugin's own marketplace source. One attempt, no loop: on failure we
      // surface the cause and the Remove button in the Doctor panel stays
      // available as the fallback.
      const repair = await repairPluginFromMarketplace(getApi().gitMarketplace, plugin);
      if (repair.status === "unbound") {
        showBanner("warning", t("pluginConfigTab.doctorNoSource", { displayName: plugin.name }));
        return;
      }
      if (repair.status === "failed") {
        showBanner("error", repair.message || t("pluginConfigTab.errorDoctor"));
        return;
      }

      const installKey = getPluginDoctorInstallKey(plugin);
      const refreshedCards = await refreshPlugins({ preferInstallKey: installKey });
      if (!refreshedCards) return;
      const refreshedPlugin = findRefreshedDoctorPlugin(refreshedCards, plugin, [installKey]);
      if (!isDoctorRepairLoaded(refreshedPlugin)) {
        // The same bytes went back on disk and still do not load: the fix is the publisher's, not a retry.
        showBanner("warning", t("pluginConfigTab.doctorDiagnosticUnresolved", { displayName: plugin.name }));
        return;
      }
      showBanner("success", t("pluginConfigTab.successDoctor", { displayName: plugin.name }));
    } catch (e) {
      showBanner("error", errorMessage(e) || t("pluginConfigTab.errorDoctor"));
    } finally {
      setDoctoringId(null);
    }
  }, [refreshPlugins, showBanner, t]);

  const handleUninstall = useCallback(async (pluginId: string, displayName: string) => {
    setSaving(true);
    try {
      const result = await getHostMarketplaceApi().uninstallMarketplacePlugin(pluginId);
      if (!result.ok) {
        showBanner("error", result.message ?? t("pluginConfigTab.errorUninstall"));
        return;
      }
      setPlugins((prev) => prev.filter((p) => p.id !== pluginId));
      setSelectedId((current) => (current === pluginId ? null : current));
      showBanner("success", t("pluginConfigTab.successUninstall", { displayName }));
    } catch (e) {
      showBanner("error", errorMessage(e) || t("pluginConfigTab.errorUninstall"));
    } finally {
      setSaving(false);
      setUninstallTarget(null);
    }
  }, [showBanner, t]);

  return (
    <div className="flex min-w-0 flex-1 min-h-0 flex-col gap-3">
      <SettingsPageHeader
        title={t("pluginConfigTab.pageTitle")}
        description={t("pluginConfigTab.pageDescription")}
      />
      {/* The installed-plugin list and its detail card are one deep-link
          anchor: every per-plugin switch lives inside the pair. */}
      <div
        className="flex flex-1 min-h-0 flex-col gap-3"
        data-settings-section="plugin-config-installed"
        tabIndex={-1}
      >
      <PluginUninstallDialog
        target={uninstallTarget}
        working={saving}
        onClose={() => {
          if (!saving) setUninstallTarget(null);
        }}
        onConfirm={(id) => handleUninstall(id, uninstallTarget?.name ?? id)}
      />
      {banner && (
        <div
          data-testid="plugin-config:banner"
          className={`rounded-md px-3 py-2 text-sm ${
            banner.type === "error"
              ? "bg-destructive/(--opacity-soft) text-destructive"
              : banner.type === "warning"
                ? "bg-warning/(--opacity-soft) text-warning"
                : "bg-success/(--opacity-soft) text-success"
          }`}
        >
          {banner.msg}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        {isDevMode && (
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-warning"
            data-testid="plugin-config:install-unreviewed"
            onClick={() => void handleInstallLocal()}
            disabled={localInstalling}
          >
            {localInstalling ? t("pluginConfigTab.phaseInstalling") : t("pluginConfigTab.installUnreviewedDev")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          data-testid="plugin-config:install-folder"
          onClick={() => {
            requestDirectInstall();
            onNavigate?.("marketplace");
          }}
        >
          {t("pluginConfigTab.installFromFolder")}
        </Button>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">{t("pluginConfigTab.loading")}</p>
      ) : plugins.length === 0 ? (
        <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
          {t("pluginConfigTab.noPluginsInstalled")}
        </div>
      ) : (
        // Split height fills to the viewport bottom. The 180px reserve
        // matches the actual non-split chrome above:
        //   CustomTitleBar 36 + right-pane pt-2 8 + TabsContent mt-2 8 +
        //   page header (94) + right-pane pb-8 32 ≈ 178.
        // Right detail card stretches to fill the split height; its own
        // `overflow-y-auto` is the single scroll surface for the card so
        // the entire 환경 설정 list is reachable by scrolling.
        <div className="flex min-w-0 flex-col gap-3 sm:h-[calc(100dvh-180px)] sm:min-h-[350px] sm:flex-row">
          {/* Left: plugin list (sub-sidebar — fixed width) */}
          <div className="w-full min-w-0 shrink-0 rounded-md border bg-card sm:w-60">
            <ScrollArea className="max-h-52 sm:h-full">
              <div className="p-1 space-y-0.5">
                {plugins.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`plugin-config:row:${p.id}`}
                    onClick={() => setSelectedId(p.id)}
                    className={`w-full text-left rounded px-2 py-1.5 text-xs hover:bg-accent ${
                      selectedId === p.id ? "bg-accent font-semibold" : ""
                    }`}
                  >
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="min-w-0 line-clamp-1">{p.name}</span>
                      {!!unseen.get(p.id) && <span data-testid={`alert-unseen:${p.id}`} aria-label={t("alerts.unseenCount", { count: unseen.get(p.id)! })} className="shrink-0 rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground">{unseen.get(p.id)}</span>}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5">
                      {p.loadStatus === "loaded" && (
                        <span
                          data-testid={`plugin-config:row-status:${p.id}`}
                          className="inline-block rounded-full bg-success/(--opacity-soft) px-1.5 py-px text-[9px] font-medium text-success"
                        >
                          {t("pluginConfigTab.statusLoaded")}
                        </span>
                      )}
                      {p.loadStatus === "preparing" && (
                        <span
                          data-testid={`plugin-config:row-status:${p.id}`}
                          className="inline-block rounded-full bg-warning/(--opacity-soft) px-1.5 py-px text-[9px] font-medium text-warning"
                        >
                          {t("pluginConfigTab.statusPreparing")}
                        </span>
                      )}
                      {p.loadStatus === "failed" && (
                        <span
                          data-testid={`plugin-config:row-status:${p.id}`}
                          className="inline-block rounded-full bg-destructive/(--opacity-soft) px-1.5 py-px text-[9px] font-medium text-destructive"
                        >
                          {t("pluginConfigTab.statusFailed")}
                        </span>
                      )}
                      {p.loadStatus === "disabled" && (
                        <span
                          data-testid={`plugin-config:row-status:${p.id}`}
                          className="inline-block rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground"
                        >
                          {t("pluginConfigTab.statusDisabled")}
                        </span>
                      )}
                      {/* Auth status — only when manifest declares `auth` AND the runtime is
                          callable (inactive plugins remain callable for auth/config).
                          The list-level badge is a "you need to do something here"
                          surface; we render only `unauthed` (red) so the row stays visually
                          quiet for the happy-path. Click → detail panel handles login flow. */}
                      {p.auth && isRuntimeCallablePlugin(p) && authStatuses.get(p.id)?.kind === "unauthed" && (
                        <span
                          className="inline-block rounded-full bg-destructive/(--opacity-soft) px-1.5 py-px text-[9px] font-medium text-destructive"
                          title={t("pluginConfigTab.unauthTitle")}
                        >
                          🔒 {t("pluginConfigTab.statusUnauthed")}
                        </span>
                      )}
                    </div>
                    {p.loadStatus === "preparing" && p.preparationStatus?.message && (
                      <div className="mt-1 line-clamp-2 text-[10px] text-warning/(--opacity-intense)">
                        {p.preparationStatus.message}
                      </div>
                    )}
                    {p.loadStatus === "loaded" && <PluginRuntimeArm plugin={p} surface="row" />}
                    <PluginLastAttemptRefusal plugin={p} />
                  </button>
                ))}
              </div>
            </ScrollArea>
          </div>

          {/* Right: detail card. The card itself is the ONE scroll surface
              for everything inside (header + 인증 + 제공 툴 + 환경 설정),
              so the user can scroll past the auth/tools sections to reach
              the full list of config fields. */}
          <div className="min-w-0 flex flex-col gap-2 rounded-md border bg-card p-3 overflow-visible sm:flex-1 sm:min-h-0 sm:overflow-y-auto">
            {selectedPlugin ? (
              <>
                <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1">
                      <h3 className="min-w-0 break-words text-sm font-semibold">{selectedPlugin.name}</h3>
                      {selectedPlugin.loadStatus && (
                        selectedPlugin.loadStatus === "loaded" ? (
                          <span
                            data-testid={`plugin-config:detail-status:${selectedPlugin.id}`}
                            className="inline-block rounded-full bg-success/(--opacity-soft) px-1.5 py-px text-[9px] font-medium text-success"
                          >
                            {t("pluginConfigTab.statusLoaded")}
                          </span>
                        ) : selectedPlugin.loadStatus === "preparing" ? (
                          <span
                            data-testid={`plugin-config:detail-status:${selectedPlugin.id}`}
                            className="inline-block rounded-full bg-warning/(--opacity-soft) px-1.5 py-px text-[9px] font-medium text-warning"
                          >
                            {t("pluginConfigTab.statusPreparing")}
                          </span>
                        ) : selectedPlugin.loadStatus === "failed" ? (
                          <span
                            data-testid={`plugin-config:detail-status:${selectedPlugin.id}`}
                            className="inline-block rounded-full bg-destructive/(--opacity-soft) px-1.5 py-px text-[9px] font-medium text-destructive"
                          >
                            {t("pluginConfigTab.statusFailed")}
                          </span>
                        ) : (
                          <span
                            data-testid={`plugin-config:detail-status:${selectedPlugin.id}`}
                            className="inline-block rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground"
                          >
                            {t("pluginConfigTab.statusDisabled")}
                          </span>
                        )
                      )}
                    </div>
                    <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                      <span className="font-mono text-[10px] text-muted-foreground">{selectedPlugin.id}</span>
                      {selectedPlugin.version && (
                        <span className="text-[10px] text-muted-foreground">· v{selectedPlugin.version}</span>
                      )}
                      {selectedPlugin.hostProtocol === "3" && (
                        <span
                          className="rounded border border-warning/40 px-1 text-[10px] text-warning"
                          data-testid={`plugin-config:legacy-protocol:${selectedPlugin.id}`}
                          title={t("pluginConfigTab.legacyProtocolTitle")}
                        >
                          {t("pluginConfigTab.legacyProtocolBadge")}
                        </span>
                      )}
                    </div>
                    {selectedPlugin.description && (
                      <p className="mt-1 break-words text-xs text-muted-foreground">{selectedPlugin.description}</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {selectedPluginToggleable ? (
                      <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                        <span>{selectedPluginActive ? t("pluginConfigTab.activeLabel") : t("pluginConfigTab.inactiveLabel")}</span>
                        <Switch
                          size="sm"
                          data-testid={`plugin-config:enabled-toggle:${selectedPlugin.id}`}
                          checked={selectedPluginActive}
                          disabled={togglingId === selectedPlugin.id}
                          onCheckedChange={(next) => void handleToggleEnabled(selectedPlugin.id, next)}
                          aria-label={t("pluginConfigTab.toggleAriaLabel", { name: selectedPlugin.name })}
                        />
                      </label>
                    ) : (
                      <span className="text-[10px] text-muted-foreground">
                        {selectedPlugin.loadStatus === "preparing" ? t("pluginConfigTab.statusPreparing") : t("pluginConfigTab.notRunnable")}
                      </span>
                    )}
                    {(selectedPlugin.loadStatus === "failed" || selectedPlugin.hostProtocol === "3") && (
                      (selectedPlugin.installFailureKind === "incompatible-host-protocol" || selectedPlugin.hostProtocol === "3")
                        && protocolUpdatePath?.kind === "catalog" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2"
                          data-testid={`plugin-config:protocol-update-button:${selectedPlugin.id}`}
                          onClick={() => {
                            requestUpdateReview([{ key: protocolUpdatePath.key }]);
                            onNavigate?.("marketplace");
                          }}
                        >
                          {t("pluginConfigTab.protocolUpdateButton", { version: protocolUpdatePath.version })}
                        </Button>
                      ) : selectedPlugin.installFailureKind === "incompatible-host-protocol" || selectedPlugin.hostProtocol === "3" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2"
                          data-testid={`plugin-config:doctor-migrate:${selectedPlugin.id}`}
                          onClick={() => requestNewChatDraft(buildProtocol4MigrationPrompt(selectedPlugin, protocolUpdatePath))}
                        >
                          {t("pluginConfigTab.doctorMigrateButton")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs px-2"
                          data-testid={`plugin-config:doctor:${selectedPlugin.id}`}
                          onClick={() => void handleDoctorPlugin(selectedPlugin)}
                          disabled={doctoringId === selectedPlugin.id}
                        >
                          {doctoringId === selectedPlugin.id
                            ? t("pluginConfigTab.phaseInstalling")
                            : t("pluginConfigTab.doctorButton")}
                        </Button>
                      )
                    )}
                    <Button
                      size="sm"
                      variant="destructive"
                      className="h-7 text-xs px-2"
                      data-testid={`plugin-config:remove:${selectedPlugin.id}`}
                      onClick={() => setUninstallTarget(selectedPlugin)}
                      disabled={saving}
                    >
                      {t("pluginConfigTab.uninstallButton")}
                    </Button>
                  </div>
                </div>

                <PluginPreparationStatusPanel plugin={selectedPlugin} />

                {selectedPlugin.loadStatus === "failed" && (
                  <div
                    data-testid={`plugin-config:doctor-panel:${selectedPlugin.id}`}
                    className="rounded-md border border-destructive/(--opacity-muted) bg-destructive/(--opacity-subtle) px-3 py-2"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <p className="text-xs font-medium text-destructive">
                          {selectedPlugin.installFailureKind === "incompatible-app-version"
                            ? t("pluginConfigTab.doctorIncompatibleAppTitle")
                            : selectedPlugin.installFailureKind === "process-entry-unconfined"
                              ? t("pluginConfigTab.doctorProcessEntryUnconfinedTitle")
                            : selectedPlugin.installFailureKind === "process-entry-requires-pinned-artifact"
                              ? t("pluginConfigTab.doctorProcessEntryUnpinnedTitle")
                            : selectedPlugin.installFailureKind === "incompatible-host-protocol"
                              ? t("pluginConfigTab.doctorIncompatibleProtocolTitle")
                              : selectedPlugin.installFailureKind === "sandbox-grant-outside-ceiling"
                                ? t("pluginConfigTab.doctorSandboxGrantTitle")
                              : selectedPlugin.installFailureKind === "manifest-validation-error"
                                ? t("pluginConfigTab.doctorManifestValidationTitle")
                                : selectedPlugin.installFailureKind === "plugin-revoked"
                                  ? t("pluginConfigTab.doctorRevokedTitle")
                                  : selectedPlugin.installFailureKind === "untrusted-manifest-path"
                                    ? t("pluginConfigTab.doctorUntrustedManifestPathTitle")
                                    : selectedPlugin.installFailureKind === "load-crash"
                                      ? t("pluginConfigTab.doctorLoadCrashTitle")
                                      : t("pluginConfigTab.doctorTitle")}
                        </p>
                        <p className="text-[11px] text-destructive/(--opacity-intense)">
                          {selectedPlugin.installFailureKind === "incompatible-app-version"
                            ? t("pluginConfigTab.doctorIncompatibleAppDescription")
                            : selectedPlugin.installFailureKind === "process-entry-unconfined"
                              ? t("pluginConfigTab.doctorProcessEntryUnconfinedDescription")
                            : selectedPlugin.installFailureKind === "process-entry-requires-pinned-artifact"
                              ? t("pluginConfigTab.doctorProcessEntryUnpinnedDescription")
                            : selectedPlugin.installFailureKind === "incompatible-host-protocol"
                              ? t("pluginConfigTab.doctorIncompatibleProtocolDescription")
                              : selectedPlugin.installFailureKind === "sandbox-grant-outside-ceiling"
                                ? t("pluginConfigTab.doctorSandboxGrantDescription")
                              : selectedPlugin.installFailureKind === "manifest-validation-error"
                                ? t("pluginConfigTab.doctorManifestValidationDescription")
                                : selectedPlugin.installFailureKind === "plugin-revoked"
                                  ? t("pluginConfigTab.doctorRevokedDescription")
                                  : selectedPlugin.installFailureKind === "untrusted-manifest-path"
                                    ? t("pluginConfigTab.doctorUntrustedManifestPathDescription")
                                    : selectedPlugin.installFailureKind === "load-crash"
                                      ? t("pluginConfigTab.doctorLoadCrashDescription")
                                      : t("pluginConfigTab.doctorDescription")}
                        </p>
                        <PluginRuntimeArm plugin={selectedPlugin} surface="doctor" />
                        {selectedPlugin.installFailureMessage ? (
                          <div className="mt-2 rounded border border-destructive/(--opacity-muted) bg-background/(--opacity-muted) px-2 py-1.5">
                            <p className="text-[10px] font-medium uppercase tracking-wide text-destructive">
                              {t("pluginConfigTab.doctorFailureDetailLabel")}
                            </p>
                            <p className="mt-1 break-words font-mono text-[10.5px] leading-snug text-destructive/(--opacity-intense)">
                              {selectedPlugin.installFailureKind === "process-entry-unconfined"
                                ? t("formatIpcError.processEntryUnconfined")
                                : selectedPlugin.installFailureKind === "process-entry-requires-pinned-artifact"
                                  ? t("formatIpcError.processEntryRequiresPinnedArtifact")
                                  : selectedPlugin.installFailureMessage}
                            </p>
                          </div>
                        ) : null}
                        {selectedPlugin.installFailureKind === "incompatible-host-protocol" && protocolUpdatePath && protocolUpdatePath.kind !== "catalog" && (
                          <div className="mt-2 text-xs" data-testid={`plugin-config:protocol-update:${selectedPlugin.id}`}>
                            {protocolUpdatePath.kind === "repository" ? (
                              <>
                                <p>{t("pluginConfigTab.protocolUpdateRepository", { source: protocolUpdatePath.sourceLabel })}</p>
                                <p className="break-all font-mono">{protocolUpdatePath.url}</p>
                              </>
                            ) : <p>{t("pluginConfigTab.protocolUpdateUnavailable")}</p>}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Auth section — only when manifest declares `auth`, the
                    runtime is callable, and the api bridge is available.
                    See architecture.md §9.4a. */}
                {selectedPlugin.auth &&
                  selectedPluginRuntimeLoaded &&
                  apiForAuthHook && (
                  <>
                    <Separator />
                    {/* PluginAuthSection renders its own "인증" header
                        internally — no outer label needed. */}
                    <PluginAuthSection
                      // `key` forces React to remount the section when the
                      // user switches between plugins in the list. Without
                      // it the same instance is reused across plugin
                      // selections and stale internal state (`working`,
                      // `localError`) carries over between plugins.
                      key={selectedPlugin.id}
                      api={apiForAuthHook}
                      pluginId={selectedPlugin.id}
                      pluginName={selectedPlugin.name}
                      auth={selectedPlugin.auth}
                      state={authStatuses.get(selectedPlugin.id) ?? { kind: "loading" }}
                      onRefresh={() => refreshAuthStatus(selectedPlugin.id)}
                    />
                  </>
                )}

                {(contributionTrustError || contributionTrust.length > 0) && (
                  <>
                    <Separator />
                    <div className="space-y-2" data-testid={`plugin-config:contribution-trust:${selectedPlugin.id}`}>
                      <div>
                        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t("pluginConfigTab.contributionTrustLabel")}
                        </p>
                        <p className="text-[11px] text-muted-foreground">
                          {t("pluginConfigTab.contributionTrustDescription")}
                        </p>
                      </div>
                      {contributionTrustError && (
                        <p
                          role="alert"
                          className="text-[11px] text-destructive"
                          data-testid={`plugin-config:contribution-trust-error:${selectedPlugin.id}`}
                        >
                          {contributionTrustError}
                        </p>
                      )}
                      {contributionTrust.map((row) => {
                        const approved = row.status === "approved";
                        const key = `${row.kind}:${row.localId}`;
                        return (
                          <div key={key} className="flex items-center justify-between gap-3 rounded border border-border/(--opacity-medium) px-2 py-1.5">
                            <div className="min-w-0">
                              <p className="truncate font-mono text-[11px] font-semibold">
                                {row.kind === "hook" ? "Hook" : "MCP"} · {row.localId}
                              </p>
                              <p className="truncate font-mono text-[9px] text-muted-foreground" title={row.fingerprint}>
                                {row.fingerprint.slice(0, 12)} · v{row.pluginVersion}
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant={approved ? "outline" : "default"}
                              className="h-7 px-2 text-xs"
                              disabled={trustUpdating === key}
                              onClick={() => void handleContributionTrust(row, !approved)}
                            >
                              {approved
                                ? t("pluginConfigTab.contributionTrustRevoke")
                                : t("pluginConfigTab.contributionTrustApprove")}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}

                {/* Tools section — tool descriptions are markdown (plugin
                    manifests routinely include `**bold**`, code spans, lists,
                    and line breaks). Rendered through the shared ReactMarkdown
                    surface (chat cards) for consistent typography.

                    Collapsed by default with a tool-count badge so the detail
                    panel stays scannable for plugins with many tools. Click
                    the row to expand. */}
                {(selectedPlugin.tools.length > 0 || !selectedPluginActive) && (
                  <>
                    <Separator />
                    <div className="space-y-1">
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-2 rounded text-left hover:bg-muted/(--opacity-muted) -mx-1 px-1 py-1"
                        aria-expanded={toolsExpanded}
                        aria-controls={`plugin-tools-list-${selectedPlugin.id}`}
                        onClick={() => setToolsExpanded((prev) => !prev)}
                      >
                        <span className="flex items-center gap-2">
                          <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{t("pluginConfigTab.providedToolsLabel")}</span>
                          <span className="inline-flex items-center justify-center min-w-[1.25rem] rounded-full bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground tabular-nums">
                            {selectedPlugin.tools.length}
                          </span>
                          {!selectedPluginActive && (
                            <span className="rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground">
                              {t("pluginConfigTab.toolsHiddenFromModel")}
                            </span>
                          )}
                        </span>
                        <span aria-hidden="true" className="text-[10px] text-muted-foreground">
                          {toolsExpanded ? "▾" : "▸"}
                        </span>
                      </button>
                      {!selectedPluginActive && selectedPlugin.tools.length === 0 && (
                        <p
                          data-testid={`plugin-config:tools-hidden-note:${selectedPlugin.id}`}
                          className="px-1 text-[11px] text-muted-foreground"
                        >
                          {t("pluginConfigTab.toolsHiddenNote")}
                        </p>
                      )}
                      {toolsExpanded && selectedPlugin.tools.length > 0 && (
                        <div
                          id={`plugin-tools-list-${selectedPlugin.id}`}
                          className="space-y-2 max-h-48 overflow-y-auto pr-1"
                        >
                          {selectedPlugin.tools.map((tool) => {
                            const desc = selectedPlugin.toolDescriptions?.[tool];
                            return (
                              <div key={tool} className="flex flex-col gap-0.5 rounded border border-border/(--opacity-medium) bg-muted/(--opacity-light) px-2 py-1.5">
                                <span className="font-mono text-[11px] font-semibold">{tool}</span>
                                {desc && (
                                  <div className="prose prose-sm ave-prose max-w-none break-words text-[11px] text-muted-foreground [&_p]:my-0.5 [&_ul]:my-0.5 [&_ol]:my-0.5 [&_code]:text-[10px]">
                                    <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS}>
                                      {desc}
                                    </ReactMarkdown>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}
                <Separator />

                {selectedPlugin.configSchema ? (
                  // §9.2 — declarative form. Cleartext fields go
                  // through pluginConfig.set; format:'secret' fields go
                  // through pluginConfig.setSecret so values land in the
                  // encrypted keychain instead of cleartext settings.json.
                  // The form renders inline (no internal ScrollArea) — the
                  // PARENT right-detail card has `overflow-y-auto`, so all
                  // env-config items are reachable by scrolling the card.
                  <div className="space-y-1.5">
                    <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{t("pluginConfigTab.configSectionLabel")}</span>
                    <PluginConfigSchemaForm
                        pluginId={selectedPlugin.id}
                        schema={selectedPlugin.configSchema}
                        values={mergedConfigValues}
                        secretsPresent={secretsPresent}
                        onSave={async (values) => {
                          setSaving(true);
                          try {
                            const result = await window.ave.pluginConfig.set(
                              selectedPlugin.id,
                              values,
                            );
                            if (!result.ok) {
                              showBanner("error", result.message ?? t("pluginConfigTab.errorSave"));
                              return;
                            }
                            setSavedConfig(result.config as Record<string, unknown>);
                            setEntries(configToEntries(result.config));
                            showBanner("success", t("pluginConfigTab.successSaved"));
                            notifySaved();
                          } catch (e) {
                            showBanner("error", errorMessage(e) || t("pluginConfigTab.errorSave"));
                          } finally {
                            setSaving(false);
                            void refreshPlugins();
                          }
                        }}
                        onSetSecret={async (key, value) => {
                          const result = await window.ave.pluginConfig.setSecret(
                            selectedPlugin.id,
                            key,
                            value,
                          );
                          // A secret save may restart the plugin; its card carries the outcome either way.
                          void refreshPlugins();
                          if (!result.ok) {
                            showBanner("error", result.message ?? t("pluginConfigTab.errorSaveSecret"));
                            return;
                          }
                          // Optimistically mark the key as present so the masked "**** (저장됨)" placeholder appears immediately.
                          setSecretsPresent((prev) => ({ ...prev, [key]: true }));
                          showBanner("success", t("pluginConfigTab.successSaveSecret", { key }));
                          notifySaved();
                        }}
                      />
                  </div>
                ) : (
                  <>
                    {/* Environment variables section — schema-less plugins use the raw
                        key/value editor. Without an explicit heading the
                        user can't tell what this list represents (missing
                        environment-variable header), so anchor it visually with a label and
                        a hint that the value box accepts JSON. The row
                        list caps at ~5 rows (220px ≈ row height × 5 +
                        gaps) and scrolls beyond that so a plugin with 20
                        env vars doesn't push the Save button off-screen. */}
                    <div className="flex items-baseline justify-between">
                      <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
                        {t("pluginConfigTab.envVarsLabel")}
                      </p>
                      <span className="text-[10px] text-muted-foreground">
                        {t("pluginConfigTab.envVarsCount", { count: entries.length })}
                      </span>
                    </div>
                    <ScrollArea className="w-full rounded-md border bg-background/(--opacity-medium) p-2" style={{ maxHeight: 220 }}>
                      <div className="space-y-1.5 pr-2">
                        {entries.length === 0 && (
                          <p className="text-xs text-muted-foreground">
                            {t("pluginConfigTab.noEntriesHint")}
                          </p>
                        )}
                        {entries.map((entry) => (
                          <div key={entry.key} className="flex items-center gap-2">
                            <Input
                              className="h-7 text-xs font-mono flex-[0_0_30%]"
                              value={entry.key}
                              readOnly
                            />
                            <Input
                              className="h-7 text-xs font-mono flex-1"
                              value={entry.value}
                              onChange={(e) => handleUpdateValue(entry.key, e.target.value)}
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs px-2 text-destructive border-destructive/(--opacity-medium)"
                              onClick={() => handleRemoveEntry(entry.key)}
                            >
                              {t("pluginConfigTab.deleteButton")}
                            </Button>
                          </div>
                        ))}
                      </div>
                    </ScrollArea>

                    <Separator />

                    <div className="flex items-center gap-2">
                      <Input
                        className="h-7 text-xs font-mono flex-[0_0_30%]"
                        placeholder="key"
                        value={newKey}
                        onChange={(e) => setNewKey(e.target.value)}
                      />
                      <Input
                        className="h-7 text-xs font-mono flex-1"
                        placeholder={t("pluginConfigTab.valuePlaceholder")}
                        value={newValue}
                        onChange={(e) => setNewValue(e.target.value)}
                      />
                      <Button size="sm" className="h-7 text-xs px-2" onClick={handleAddEntry}>
                        {t("pluginConfigTab.addButton")}
                      </Button>
                    </div>

                    <div className="flex justify-end">
                      <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
                        {saving ? t("pluginConfigTab.savingLabel") : t("pluginConfigTab.saveButton")}
                      </Button>
                    </div>
                  </>
                )}
                {alertsApi?.alerts && <PluginAlertsSection pluginId={selectedPlugin.id} rows={alerts.rows} api={alertsApi.alerts} osEnabled={alerts.osEnabled} refresh={alerts.refresh} />}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{t("pluginConfigTab.selectPluginHint")}</p>
            )}
          </div>
        </div>
      )}
      {alerts.failed && <div role="alert" className="text-xs text-destructive">{t("alerts.loadFailed")} <Button size="sm" variant="outline" onClick={() => void alerts.refresh()}>{t("alerts.retry")}</Button></div>}
      {alertsApi?.alerts && alerts.loaded && <PluginAlertsSection pluginId={ALERT_HOST_PLUGIN_ID} rows={alerts.rows} api={alertsApi.alerts} osEnabled={alerts.osEnabled} refresh={alerts.refresh} completionSound={{
        enabled: alerts.turnCompletionSoundEnabled,
        onChange: async (enabled) => {
          const result = await alertsApi.updateSettings({ system: { turnCompletionSoundEnabled: enabled } });
          if ("error" in result) throw new Error("Completion sound setting could not be saved");
        },
      }} />}
      {/* Performance section — the former standalone plugin-perf tab was
          merged here ("성능만 병합"); it renders as a section below the
          config content and pulls its own perf stats via the api. */}
      {api && (
        <div className="shrink-0 border-t border-border/(--opacity-medium) pt-6">
          <PluginPerfTab api={api} />
        </div>
      )}
      </div>
    </div>
  );
}
