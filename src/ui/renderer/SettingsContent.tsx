import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n/react.js";
import { Button } from "../../components/ui/button.js";
import { Tabs, VerticalTabsList, TabsTrigger, TabsContent } from "../../components/ui/tabs.js";
import {
  Brain,
  Palette,
  MessageSquare,
  Globe,
  Shield,
  UserCog,
  BarChart3,
  FileSearch,
  Server,
  Puzzle,
  Store,
  Info,
  Rocket,
  Network,
  ChevronLeft,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import { useContainerNarrow } from "./hooks/use-container-narrow.js";
import { SETTINGS_NARROW_ENTER_WIDTH, SETTINGS_NARROW_EXIT_WIDTH } from "../../shared/shell-geometry.js";
import { SavedToastFloating, SavedToastProvider } from "./context/SavedToastContext.js";
import type { AveApi } from "./types.js";
import { RolesTab } from "./tabs/RolesTab.js";
import { PermissionsTab } from "./tabs/PermissionsTab.js";
import { AuditTab } from "./tabs/AuditTab.js";
import { RemoteSurfacesTab } from "./tabs/RemoteSurfacesTab.js";
import { UsageDashboard } from "./components/UsageDashboard.js";
import { LlmTab } from "./tabs/LlmTab.js";
import { AppearanceTab } from "./tabs/AppearanceTab.js";
import { ChatTab } from "./tabs/ChatTab.js";
import { WebTab } from "./tabs/WebTab.js";
import { McpTab } from "./tabs/McpTab.js";
import { PluginConfigTab } from "./tabs/PluginConfigTab.js";
import { GitMarketplaceTab } from "./tabs/git-marketplace/GitMarketplaceTab.js";
import { AboutTab, useAppInfo } from "./tabs/AboutTab.js";
import { StartupTab } from "./tabs/StartupTab.js";
import { useSettingsOrchestration } from "./hooks/use-settings-orchestration.js";
import { useSettingsSectionArrival } from "./hooks/use-settings-tab.js";
import { useDebouncedSave } from "./hooks/use-debounced-save.js";
import { normalizeSettingsTab, SETTINGS_TAB_LABEL_KEYS, type SettingsTab } from "../../shared/settings-tabs.js";
import type { PackageKind } from "../../shared/git-marketplace.js";
import type { ExactDenyDraft } from "./exact-permission-decision.js";
import { TEST_IDS } from "../../shared/test-ids.js";

type SettingsNavItem = { value: SettingsTab; icon: LucideIcon; labelKey: string };

/**
 * Grouped, data-driven settings navigation. Re-grouping or re-ordering is a
 * pure data edit here — the wide sidebar and the narrow mobile depth-1 list
 * both iterate this single array, so the two layouts can never drift. The
 * former "general" tab was split (account → Model, stats → Usage, system info
 * → the "about" tab appended to the Advanced group).
 */
const SETTINGS_NAV: { group: string; items: SettingsNavItem[] }[] = [
  {
    group: "settingsContent.groupAccountModel",
    items: [
      { value: "llm", icon: Brain, labelKey: SETTINGS_TAB_LABEL_KEYS["llm"] },
      { value: "usage", icon: BarChart3, labelKey: SETTINGS_TAB_LABEL_KEYS["usage"] },
    ],
  },
  {
    group: "settingsContent.groupApp",
    items: [
      { value: "appearance", icon: Palette, labelKey: SETTINGS_TAB_LABEL_KEYS["appearance"] },
      { value: "chat", icon: MessageSquare, labelKey: SETTINGS_TAB_LABEL_KEYS["chat"] },
      { value: "web", icon: Globe, labelKey: SETTINGS_TAB_LABEL_KEYS["web"] },
      { value: "startup", icon: Rocket, labelKey: SETTINGS_TAB_LABEL_KEYS["startup"] },
    ],
  },
  {
    group: "settingsContent.groupConnections",
    items: [
      { value: "remote-surfaces", icon: Network, labelKey: SETTINGS_TAB_LABEL_KEYS["remote-surfaces"] },
    ],
  },
  {
    group: "settingsContent.groupPermRoles",
    items: [
      { value: "permissions", icon: Shield, labelKey: SETTINGS_TAB_LABEL_KEYS["permissions"] },
      { value: "roles", icon: UserCog, labelKey: SETTINGS_TAB_LABEL_KEYS["roles"] },
    ],
  },
  {
    // The config/performance tabs read code-package runtime cards. Their DTO has no catalog kind; entry-free bundles will not
    // appear in these tabs.
    group: "settingsContent.groupPlugins",
    items: [
      { value: "marketplace", icon: Store, labelKey: SETTINGS_TAB_LABEL_KEYS["marketplace"] },
      { value: "plugin-config", icon: Puzzle, labelKey: SETTINGS_TAB_LABEL_KEYS["plugin-config"] },
      { value: "mcp", icon: Server, labelKey: SETTINGS_TAB_LABEL_KEYS["mcp"] },
    ],
  },
  {
    group: "settingsContent.groupAdvanced",
    items: [
      { value: "audit", icon: FileSearch, labelKey: SETTINGS_TAB_LABEL_KEYS["audit"] },
    ],
  },
  // About is app/system info, not an "Advanced" setting — it sits on its own as a divider-separated footer item (empty group
  // string ⇒ headerless render) rather than under the Advanced header.
  {
    group: "",
    items: [
      { value: "about", icon: Info, labelKey: SETTINGS_TAB_LABEL_KEYS["about"] },
    ],
  },
];

/**
 * Inline save bar rendered at the bottom of each tab that holds a
 * deferred-save form (llm / chat / web / marketplace). Replaces the
 * single page-level footer Save button so the action lives next to
 * the inputs it persists, matching the per-section save policy used
 * by the rest of the settings route.
 */
function TabSaveBar({
  onSave,
  saving,
  settingsLoaded,
}: {
  onSave: () => void;
  saving: boolean;
  settingsLoaded: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="mt-4 flex justify-end border-t border-border/(--opacity-medium) pt-3">
      <Button onClick={onSave} disabled={saving || !settingsLoaded}>
        {saving ? t("settingsContent.saving") : t("settingsContent.save")}
      </Button>
    </div>
  );
}

// `./context/SavedToastContext.tsx` so PluginConfigTab can import the consumer hook without forming a circular import with
// SettingsContent (which itself imports PluginConfigTab in this file).

export function SettingsContent({
  api,
  chatGroupId,
  onSaved,
  initialTab = "llm",
  sectionTarget = null,
  onSectionApplied,
  onTabChange,
  exactDenyDraft = null,
  onExactDenySaved,
  onDiscardExactDeny,
}: {
  api: AveApi;
  /** The tile the away-authority grant would bind to — the focused conversation. Threaded from the window because settings
   * has no conversation of its own, and main refuses a grant that names no tile. */
  chatGroupId: string;
  onSaved: () => void;
  initialTab?: string;
  /**
   * The section inside `initialTab` a deep link named — one of the ids
   * `SETTINGS_SECTIONS` lists for that tab — or `null` for an ordinary open.
   *
   * A one-shot, and never persisted: it means "the user was just sent here",
   * which stops being true the moment they arrive. `onSectionApplied` fires
   * once the panel has consumed it.
   */
  sectionTarget?: string | null;
  onSectionApplied?: () => void;
  /** Keep tab state local for coupled depth/filter transitions; notify embedders of normalized changes instead of controlling
   * the tab externally. */
  onTabChange?: (tab: string) => void;
  exactDenyDraft?: ExactDenyDraft | null;
  onExactDenySaved?: (requestId: string) => void;
  onDiscardExactDeny?: () => void;
}) {
  const { t } = useTranslation();
  const appInfo = useAppInfo(api);
  const [tab, setTab] = useState(() => normalizeSettingsTab(initialTab));
  const [pluginSettingsTarget, setPluginSettingsTarget] = useState<string | null>(null);
  const [marketplaceKind, setMarketplaceKind] = useState<PackageKind | null>(null);
  const [pendingPermissions, setPendingPermissions] = useState(0);

  // Count save notifications monotonically so two saves in one millisecond still retrigger the toast.
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const notifySaved = useCallback(() => setSavedAt((n) => (n ?? 0) + 1), []);
  const handleSaved = useCallback(() => {
    notifySaved();
    onSaved();
  }, [notifySaved, onSaved]);
  const s = useSettingsOrchestration(api, handleSaved);

  // Cancel pending debounce before explicit Save to avoid duplicate writes; flush pending changes before route unmount or
  // shutdown.
  const llmSave = useDebouncedSave(() => void s.save("llm"), 200, { flushOnUnmount: true });

  const chatSave = useDebouncedSave(() => void s.save("chat"), 200, { flushOnUnmount: true });
  const webSave = useDebouncedSave(() => void s.save("web"), 200, { flushOnUnmount: true });
  const flushPendingSaves = useCallback(() => {
    llmSave.flush();
    chatSave.flush();
    webSave.flush();
  }, [llmSave, chatSave, webSave]);
  // Single writer for the tab so every in-panel move is reported outward; a second `setTab` call site would be a silent hole
  // in that contract.
  const selectTab = useCallback((nextTab: string) => {
    const normalized = normalizeSettingsTab(nextTab);
    setTab(normalized);
    onTabChange?.(normalized);
  }, [onTabChange]);
  const openMarketplaceTab = useCallback((kind: PackageKind | null = null) => {
    setMarketplaceKind(kind);
    selectTab("marketplace");
  }, [selectTab]);
  const handleTabValueChange = useCallback((nextTab: string) => {
    const normalized = normalizeSettingsTab(nextTab);
    if (normalized === "marketplace") setMarketplaceKind(null);
    selectTab(normalized);
    // Committing a category (click, or Enter in manual/narrow mode) drops into depth-2 detail on narrow; inert on wide (both
    // regions stay visible).
    setMobileDepth("detail");
  }, [selectTab]);

  // Flush pending debounced saves before shutdown so an immediate quit cannot lose a just-toggled setting.
  useEffect(() => {
    window.addEventListener("beforeunload", flushPendingSaves);
    window.addEventListener("pagehide", flushPendingSaves);
    return () => {
      window.removeEventListener("beforeunload", flushPendingSaves);
      window.removeEventListener("pagehide", flushPendingSaves);
    };
  }, [flushPendingSaves]);

  // Reset tab + clear stale error banner whenever a new `initialTab` arrives
  // (mount or IPC-driven tab change). Depending on the whole `s` orchestration
  // object would re-fire this effect every render and clear the error banner
  // the moment it is set; depending on the stable `clearLastSaveError`
  // identity (`useCallback([])` inside the hook) keeps the dep list explicit.
  const clearLastSaveError = s.clearLastSaveError;
  useEffect(() => {
    setTab(normalizeSettingsTab(initialTab));
    clearLastSaveError();
  }, [initialTab, clearLastSaveError]);

  // Deep-link arrival. Ordered after the tab reset above so the anchor it looks for belongs to the tab the link named: Radix
  // mounts only the active pane, so a lookup run before that commit would find nothing.
  const noteSectionApplied = useCallback(() => onSectionApplied?.(), [onSectionApplied]);
  useSettingsSectionArrival(sectionTarget, noteSectionApplied);

  useEffect(() => {
    let alive = true;
    const refreshPending = async () => {
      try {
        const result = await api.permission.deferredList();
        if (alive && result.ok) setPendingPermissions(result.pending.length);
      } catch {
        if (alive) setPendingPermissions(0);
      }
    };
    void refreshPending();
    const unsubscribe = api.permission.onDeferredPending((summary) => {
      setPendingPermissions(summary.pending);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);

  // Scroll-reset: when the user switches tabs, reset the right pane to top
  // so they always land at the page header rather than the previous tab's
  // scroll position. `behavior: "instant"` avoids the animated scroll
  // fighting the tab transition animation on fast tab-switchers.
  const rightPaneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rightPaneRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [tab]);

  // Measure panel width rather than viewport width; split panes can be narrow on wide displays. The dead band prevents
  // resize oscillation.
  const [rootElement, setRootElement] = useState<HTMLDivElement | null>(null);
  const { isNarrow } = useContainerNarrow(rootElement, { enter: SETTINGS_NARROW_ENTER_WIDTH, exit: SETTINGS_NARROW_EXIT_WIDTH });

  // Retain narrow navigation depth across resize; a category selected while wide should remain the detail page when
  // narrowed.
  const [mobileDepth, setMobileDepth] = useState<"list" | "detail">("list");
  const mobileBackRef = useRef<HTMLButtonElement>(null);

  // Focus hand-off across the narrow depth transition so keyboard focus never
  // lands in a `display:none` region. Entering detail focuses the back button;
  // returning to the list focuses the active category trigger. The prev-depth
  // guard means resizing into narrow (or first mount) never steals focus — only
  // a real user-driven depth change moves it.
  const prevDepthRef = useRef(mobileDepth);
  useEffect(() => {
    const prev = prevDepthRef.current;
    prevDepthRef.current = mobileDepth;
    if (!isNarrow || prev === mobileDepth) return;
    if (mobileDepth === "detail") {
      mobileBackRef.current?.focus();
    } else {
      rootElement
        ?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
        ?.focus();
    }
  }, [mobileDepth, isNarrow, rootElement]);

  // Override primitive active/alignment styles for vertical rows; keep scaled labels on one clipped line.
  const sideTriggerCls =
    "flex w-full items-center justify-start gap-2.5 overflow-hidden whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium " +
    "text-muted-foreground hover:bg-accent/(--opacity-strong) hover:text-foreground " +
    "data-[state=active]:bg-accent data-[state=active]:text-accent-foreground " +
    "data-[state=active]:shadow-none";
  // The active panel must grow with ordinary overflowing content. Keeping it
  // as a fixed `flex-1 min-h-0` item lets descendants overflow beyond the
  // panel's layout box, so the outer scroll pane's bottom padding is consumed
  // and the last control lands flush against the window edge. Active panels
  // are flex columns so split-pane children can still use `flex-1 min-h-0`.
  const tabContentCls =
    "min-h-full min-w-0 w-full shrink-0 outline-none data-[state=active]:flex data-[state=active]:flex-col";
  // Common icon class so the 12 nav entries render at a uniform 16px.
  const navIconCls = "size-4 shrink-0";

  return (
    <SavedToastProvider value={notifySaved}>
    <div ref={setRootElement} className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden">
    <Tabs
      orientation="vertical"
      // Keyboard activation: automatic on wide (arrowing a trigger instantly
      // reveals its pane beside the list). Manual on narrow so arrowing browses
      // the depth-1 category list without committing into a pane on every key —
      // Enter/click commits and drops into depth-2 detail.
      activationMode={isNarrow ? "manual" : "automatic"}
      value={tab}
      onValueChange={handleTabValueChange}
      // `data-settings-layout` exposes the panel-width layout mode for tests.
      data-settings-layout={isNarrow ? "narrow" : "wide"}
      // No gap: sidebar and content share a single border (right edge of the sidebar) so the layout reads as two regions of the
      // settings route, not two stacked cards. Simplified per user direction

      className="relative flex h-full min-h-0 min-w-0 flex-1"
    >
      {/* Dialog-wide save feedback — anchored to the Tabs root (not the
          right pane) so the user sees it even after scrolling deep into
          a tab. Top-center placement keeps it in the spot the eye lands
          immediately after clicking Save. */}
      <SavedToastFloating at={savedAt} />

      {/* Nav column. Wide: fixed sidebar (w-48 + border-r) that scrolls
          independently and stays put while the right pane scrolls. Narrow: the
          full-width depth-1 category list (no divider — it is the whole view),
          hidden at depth-2 detail.
          Outer div owns the column width so the version footer can sit below
          the nav list as a sibling (Radix TabsList only accepts TabsTrigger
          children). */}
      <div
        data-testid={isNarrow ? "settings-mobile-list" : undefined}
        className={cn(
          "flex h-full flex-col",
          isNarrow ? "w-full" : "w-48 shrink-0 border-r",
          isNarrow && mobileDepth === "detail" && "hidden",
        )}
      >
      {/* No heading above this list. The pane's header carries "Settings" —
          the same 36px band every other pane gets — so a second title here
          would name the place twice, once large and once small. The list's own
          `p-2` now sets its top, matching the right pane's `pt-2`. */}
      {/* VerticalTabsList bakes in the shadcn vertical-sidebar override
          (flex-col + justify-start + rounded-none + bg-transparent); only
          the instance-specific column behaviour stays here. */}
      <VerticalTabsList
        aria-label={t("settingsContent.sidebarAriaLabel")}
        className="flex-1 overflow-y-auto"
      >
        {SETTINGS_NAV.map((group) => (
          <Fragment key={group.items[0]?.value ?? group.group}>
            {/* Group header: uppercase, muted, small mono. Non-focusable (a
                plain generic element, skipped by the tablist roving focus) so
                arrow keys still move only between triggers. A group with an
                empty header string (the trailing About item) renders a thin
                divider instead, separating it as a standalone footer entry. */}
            {group.group ? (
              <div className="select-none px-3 pb-1 pt-3 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground first:pt-0">
                {t(group.group)}
              </div>
            ) : (
              <div className="mx-3 my-2 border-t border-border/(--opacity-medium)" aria-hidden="true" />
            )}
            {group.items.map((item) => {
              const Icon = item.icon;
              const isPermissions = item.value === "permissions";
              return (
                <TabsTrigger
                  key={item.value}
                  value={item.value}
                  className={sideTriggerCls}
                  // Radix fires `onValueChange` only when the value actually
                  // changes, so tapping the ALREADY-active category in the
                  // narrow list would never drill in. Drill on any activation
                  // (TabsTrigger is a button, so this also covers keyboard
                  // Enter/Space); inert on wide.
                  onClick={() => { if (isNarrow) setMobileDepth("detail"); }}
                >
                  <Icon className={navIconCls} aria-hidden="true" />
                  <span className="min-w-0 truncate">{t(item.labelKey)}</span>
                  {isPermissions && pendingPermissions > 0 && (
                    <span
                      className={cn(
                        "rounded-full bg-destructive px-1.5 py-0.5 text-[10px] leading-none text-destructive-foreground",
                        !isNarrow && "ml-auto",
                      )}
                    >
                      {pendingPermissions}
                    </span>
                  )}
                  {/* Narrow depth-1 rows read as a drill-in list: trailing
                      chevron cues the tap-to-detail affordance. */}
                  {isNarrow && (
                    <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                </TabsTrigger>
              );
            })}
          </Fragment>
        ))}
      </VerticalTabsList>
      {/* Version footer — the running app's version as main reports it,
          the same reader the About tab uses; a literal here went stale for
          every release after the one it was typed in. */}
      <div className="shrink-0 border-t px-3 py-2.5">
        <span
          className="text-[11px] tabular-nums text-muted-foreground/(--opacity-strong) select-none"
          data-testid="settings-nav-app-version"
        >
          {appInfo ? `v${appInfo.version}` : null}
        </span>
      </div>
      </div>

      {/* Right pane — two-layer layout so split-pane tabs (PluginConfigTab,
          McpTab) can use h-full reliably.
          Outer: `overflow-hidden flex-col flex-1` — gives a fixed height
            to the column so children can fill it with h-full / flex-1.
          Inner scroll: `overflow-y-auto [scrollbar-gutter:stable]` —
            scrolls only when content overflows AND reserves the gutter
            via the CSS `scrollbar-gutter` property so the layout
            doesn't shift on short pages. Replaces the previous
            `overflow-y-scroll` (always-visible track) — that variant
            caused a double-scrollbar on Win/Linux for tabs that owned
            their own internal scroll (PluginConfigTab, McpTab).
          Top padding: pt-2 on the inner scroll matches the sidebar
          wrapper's pt-2, plus SettingsPageHeader's pt-2 lands h2 at
          the same Y as the sidebar first trigger text — both well
          below the title bar. */}
      <div
        className={cn(
          "flex flex-1 min-w-0 flex-col overflow-hidden",
          // Narrow depth-1 (list) hides the pane; depth-2 shows only the pane.
          isNarrow && mobileDepth === "list" && "hidden",
        )}
      >
      {/* Narrow depth-2 back bar returns to the depth-1 category list. */}
      {isNarrow && (
        <div className="flex shrink-0 items-center border-b px-2 py-2">
          <button
            ref={mobileBackRef}
            type="button"
            onClick={() => setMobileDepth("list")}
            aria-label={t("settingsContent.mobileBackAria")}
            data-testid={TEST_IDS.settingsMobileBack}
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/(--opacity-strong) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          >
            <ChevronLeft className="size-4 shrink-0" aria-hidden="true" />
            {t("settingsContent.sidebarHeading")}
          </button>
        </div>
      )}
      {/* The side inset widens with the PANE, not the window: settings is a
          pane body now, so a wide display with a 448px pane must not give this
          column the roomy `px-8`. `isNarrow` is the same container measurement
          the two-depth nav above already switches on — one verdict, not a
          viewport breakpoint racing a container one. */}
      <div
        ref={rightPaneRef}
        className={cn(
          "flex min-w-0 flex-1 min-h-0 flex-col overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable] pt-2 pb-12 scroll-pb-12 ave-settings-scroll",
          isNarrow ? "px-4" : "px-8",
        )}
      >
        {s.lastSaveError && (
          <div
            role="alert"
            className="mb-3 flex items-start justify-between gap-2 rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
            data-testid="settings-save-error"
          >
            <div className="min-w-0">
              <p className="font-medium">{t("settingsContent.saveErrorMessage", { tab: s.lastSaveError.tab })}</p>
              <p className="text-[11px] opacity-80">{s.lastSaveError.message}</p>
            </div>
            <button
              type="button"
              className="text-[11px] underline opacity-80 hover:opacity-100"
              onClick={s.clearLastSaveError}
            >
              {t("settingsContent.closeButton")}
            </button>
          </div>
        )}

          <TabsContent value="about" className={tabContentCls}>
            <AboutTab api={api} />
          </TabsContent>

          <TabsContent value="llm" className={tabContentCls}>
            <LlmTab
              api={api}
              vendor={s.vendor}
              retiredLlmProvider={s.retiredLlmProvider}
              baseUrl={s.baseUrl}
              hasKey={s.hasKey}
              setHasKey={s.setHasKey}
              providerCredentialDrafts={s.providerCredentialDrafts}
              onProviderCredentialDraftsChange={s.setProviderCredentialDrafts}
              onSaveProviderCredential={s.saveProviderCredential}
              marketplaceProviderPresetId={s.marketplaceProviderPresetId}
              marketplaceProviderPresets={s.marketplaceProviderPresets}
              onSelectMarketplaceProviderPreset={s.selectMarketplaceProviderPreset}
              onClearMarketplaceProviderPreset={s.clearMarketplaceProviderPreset}
              onOpenMarketplace={() => openMarketplaceTab("provider")}
              model={s.model}
              setModel={s.setModel}
              selectApiVendorModel={s.selectApiVendorModel}
              enableThinking={s.enableThinking}
              setEnableThinking={s.setEnableThinking}
              thinkingBudget={s.thinkingBudget}
              setThinkingBudget={s.setThinkingBudget}
              outputTokenLimit={s.outputTokenLimit}
              fallbackChain={s.fallbackChain}
              setFallbackChain={s.setFallbackChain}
              fallbackOpen={s.fallbackOpen}
              setFallbackOpen={s.setFallbackOpen}
              onSaved={onSaved}
              onImmediateChange={llmSave.schedule}
              onSave={() => {
                llmSave.cancel();
                void s.save("llm");
              }}
              saving={s.saving}
              settingsLoaded={s.settingsLoaded}
            />
          </TabsContent>

          <TabsContent value="appearance" className={tabContentCls}>
            <AppearanceTab onOpenMarketplace={openMarketplaceTab} />
          </TabsContent>

          <TabsContent value="chat" className={tabContentCls}>
            <ChatTab
              autoCompact={s.autoCompact}
              setAutoCompact={s.setAutoCompact}
              processingDisplayLevel={s.processingDisplayLevel}
              setProcessingDisplayLevel={s.setProcessingDisplayLevel}
              streamSmoothing={s.streamSmoothing}
              setStreamSmoothing={s.setStreamSmoothing}
              idlePreferenceRefresh={s.idlePreferenceRefresh}
              setIdlePreferenceRefresh={s.setIdlePreferenceRefresh}
              idleMemoryConsolidation={s.idleMemoryConsolidation}
              setIdleMemoryConsolidation={s.setIdleMemoryConsolidation}
              memoryCaptureMode={s.memoryCaptureMode}
              setMemoryCaptureMode={s.setMemoryCaptureMode}
              subAgentAutonomousWake={s.subAgentAutonomousWake}
              subAgentMaxRounds={s.subAgentMaxRounds}
              setSubAgentMaxRounds={s.setSubAgentMaxRounds}
              setSubAgentAutonomousWake={s.setSubAgentAutonomousWake}
              piiRedactEnabled={s.piiRedactEnabled}
              settingsLoaded={s.settingsLoaded}
              // ChatTab wraps onPiiRedactToggle with onImmediateChange. Feature toggles own separate `features` patch paths, so it must
              // not schedule the bulk chat payload.
              onPiiRedactToggle={() => s.setPiiRedactEnabled(!s.piiRedactEnabled)}
              onImmediateChange={chatSave.schedule}
            />
            {/* ChatTab is fully immediate-apply — no deferred-save bar needed. */}
          </TabsContent>

          <TabsContent value="web" className={tabContentCls}>
            <WebTab
              api={api}
              webProvider={s.webProvider}
              setWebProvider={s.setWebProvider}
              hasWebKey={s.hasWebKey}
              setHasWebKey={s.setHasWebKey}
              webKeyInput={s.webKeyInput}
              setWebKeyInput={s.setWebKeyInput}
              onSaved={onSaved}
              onImmediateChange={webSave.schedule}
            />
            <TabSaveBar
              onSave={() => {
                webSave.cancel();
                void s.save("web");
              }}
              saving={s.saving}
              settingsLoaded={s.settingsLoaded}
            />
          </TabsContent>

          <TabsContent value="startup" className={tabContentCls}><StartupTab /></TabsContent>
          <TabsContent value="permissions" className={tabContentCls}>
            <PermissionsTab
              exactDenyDraft={exactDenyDraft}
              onExactDenySaved={onExactDenySaved}
              onDiscardExactDeny={onDiscardExactDeny}
            />
          </TabsContent>
          {/* The only tab that needs the raw target: its sections live inside
              collapsed rows, so it has to open the right one before arrival
              goes looking for the anchor. */}
          <TabsContent value="remote-surfaces" className={tabContentCls}><RemoteSurfacesTab api={api} chatGroupId={chatGroupId} sectionTarget={sectionTarget} /></TabsContent>
          <TabsContent value="roles" className={tabContentCls}><RolesTab api={api} /></TabsContent>
          <TabsContent value="usage" className={tabContentCls}>
            <UsageDashboard
              api={api}
              onNavigate={handleTabValueChange}
            />
          </TabsContent>
          <TabsContent value="audit" className={tabContentCls}><AuditTab /></TabsContent>
          <TabsContent value="mcp" className={tabContentCls}><McpTab /></TabsContent>
          <TabsContent value="plugin-config" className={tabContentCls}><PluginConfigTab api={api} initialPluginId={pluginSettingsTarget} onNavigate={handleTabValueChange} /></TabsContent>
          <TabsContent value="marketplace" className={tabContentCls}>
            <GitMarketplaceTab
              api={api}
              initialKind={marketplaceKind}
              onOpenMcpSettings={() => handleTabValueChange("mcp")}
              onOpenPluginSettings={(pluginId) => { setPluginSettingsTarget(pluginId); handleTabValueChange("plugin-config"); }}
            />
          </TabsContent>
      </div>
      </div>
    </Tabs>
    </div>
    </SavedToastProvider>
  );
}
