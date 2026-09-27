/**
 * Settings → Marketplace as the in-app store of the git marketplace
 * (design §15): browse every shown source's packages by kind, open a
 * package's sheet to review and install it, manage the sources, and install
 * without a marketplace.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "../../../../components/ui/badge.js";
import { Button } from "../../../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../../../components/ui/dropdown-menu.js";
import { Input } from "../../../../components/ui/input.js";
import { Switch } from "../../../../components/ui/switch.js";
import { useTranslation } from "../../../../i18n/react.js";
import { cn } from "../../../../lib/utils.js";
import { errorMessage } from "../../../../shared/error-message.js";
import {
  bootInstallNoticeIsEmpty,
  type BootInstallNoticeView,
  type CatalogEntryView,
  type CatalogView,
  type GitMarketplaceErrorCode,
  type PackageKeyView,
  type PackageKind,
  type RevokedPackageView,
  type SourcePreviewView,
  type SourceView,
} from "../../../../shared/git-marketplace.js";
import { EnvForcedNotice, useEnvForcedSettings } from "../../components/EnvForcedNotice.js";
import { SettingsPageHeader, SettingsSection } from "../../components/PageShell.js";
import { isIpcErrorResult, type AveApi } from "../../types.js";
import { AddSourceDialog } from "./AddSourceDialog.js";
import { DirectInstallView } from "./DirectInstallView.js";
import { GitRuntimeCard } from "./GitRuntimeCard.js";
import { KIND_ORDER, failureText, kindLabel, originLabel, relativeTime, stateLabel } from "./labels.js";
import { PackageSheet } from "./PackageSheet.js";
import { LocalPluginPackageSheet, PluginStudioView } from "./PluginStudioView.js";
import type { StudioLocalPreview } from "../../../../shared/plugin-studio.js";
import { SourcesView } from "./SourcesView.js";
import { onUpdateReview, takeUpdateReview } from "./update-review-request.js";

type View = "browse" | "sources" | "direct" | "studio";

const REVOKED_NOTICE_KEYS = {
  uninstalled: "gitMarketplace.boot.revoked.uninstalled",
  required: "gitMarketplace.boot.revoked.required",
  failed: "gitMarketplace.boot.revoked.failed",
} as const satisfies Record<RevokedPackageView["outcome"], string>;

export interface GitMarketplaceTabProps {
  api: AveApi;
  /** A kind to open on, from another settings tab's "Get more…" link. */
  initialKind?: PackageKind | null;
  onOpenMcpSettings: () => void;
  onOpenPluginSettings?: (pluginId: string) => void;
}

function stateTone(entry: CatalogEntryView): string {
  switch (entry.state.state) {
    case "install":
      return "bg-primary text-primary-foreground";
    case "update":
      return "bg-info/(--opacity-soft) text-info";
    case "installed":
    case "unbound":
      return "bg-success/(--opacity-soft) text-success";
    case "requires-app":
    case "installed-elsewhere":
    case "source-removed":
      return "bg-warning/(--opacity-soft) text-warning";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function PackageCard({ entry, onOpen, onUninstallUnbound }: { entry: CatalogEntryView; onOpen: () => void; onUninstallUnbound: () => void }) {
  const { t } = useTranslation();
  const initials = entry.displayName.replace(/[^A-Za-z0-9가-힣]/gu, "").slice(0, 2) || entry.key.kind.slice(0, 2);
  const bound = entry.key.sourceId !== null;
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 text-left"
      data-testid={`git-marketplace:card:${entry.key.sourceId ?? "unbound"}:${entry.key.kind}:${entry.key.name}`}
    >
      <button type="button" className="flex min-w-0 items-start gap-2.5 text-left" onClick={onOpen} disabled={!bound}>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold uppercase" aria-hidden="true">
          {initials}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{entry.displayName}</span>
          <span className="line-clamp-2 text-[11px] text-muted-foreground">{entry.description || entry.key.name}</span>
        </span>
      </button>
      <div className="mt-auto flex flex-wrap items-center gap-1.5">
        {entry.sourceOrigin && (
          <Badge variant={entry.sourceOrigin === "official" ? "default" : "outline"} className="h-5 max-w-[10rem] truncate px-1.5 text-[10px]" title={originLabel(t, entry.sourceOrigin)}>
            {entry.sourceOrigin === "official" ? originLabel(t, "official") : entry.sourceLabel}
          </Badge>
        )}
        {!bound && entry.key.kind === "agent-plugin" && <Badge variant="outline" className="h-5 px-1.5 text-[10px]">{t("pluginStudio.createdHere")}</Badge>}
        <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">{kindLabel(t, entry.key.kind)}</Badge>
        {entry.required ? (
          <span className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground" title={t("gitMarketplace.state.requiredHint")}>
            {t("gitMarketplace.state.required")}
          </span>
        ) : bound ? (
          <button type="button" onClick={onOpen} className={cn("ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium", stateTone(entry))} data-testid="git-marketplace:card:state">
            {stateLabel(t, entry.state)}
          </button>
        ) : (
          <Button size="sm" variant="outline" className="ml-auto h-6 px-2 text-[11px]" onClick={onUninstallUnbound}>
            {t("gitMarketplace.uninstall.button")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function GitMarketplaceTab({ api, initialKind = null, onOpenMcpSettings, onOpenPluginSettings }: GitMarketplaceTabProps) {
  const { t, locale } = useTranslation();
  const market = api.gitMarketplace;
  const [view, setView] = useState<View>("browse");
  const [sources, setSources] = useState<SourceView[]>([]);
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [failure, setFailure] = useState<{ code: GitMarketplaceErrorCode; message: string } | null>(null);
  const [kind, setKind] = useState<PackageKind | null>(initialKind);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [installedOnly, setInstalledOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<{ key: PackageKeyView; mode: "detail" | "update" } | null>(null);
  const [localPreview, setLocalPreview] = useState<StudioLocalPreview | null>(null);
  const [addOpen, setAddOpen] = useState<"marketplace" | "direct" | null>(null);
  const [addInput, setAddInput] = useState("");
  const [notice, setNotice] = useState<BootInstallNoticeView | null>(null);
  const [updateCheckEnabled, setUpdateCheckEnabled] = useState(true);
  const [offlineCacheEnabled, setOfflineCacheEnabled] = useState(true);
  // A switch flipped before the saved value arrives would write a guess.
  const [flagsLoaded, setFlagsLoaded] = useState(false);
  const [flagsFailure, setFlagsFailure] = useState<string | null>(null);
  const envForcedPaths = useEnvForcedSettings(api);
  const syncedOnce = useRef(false);

  useEffect(() => setKind(initialKind), [initialKind]);

  const loadSources = useCallback(async () => {
    const result = await market.listSources();
    if (result.ok) setSources(result.value);
    else setFailure(result);
    return result.ok ? result.value : null;
  }, [market]);

  // Each keystroke asks again; only the newest request's answer may land, whatever order they return in.
  const catalogRequestRef = useRef(0);
  const loadCatalog = useCallback(async () => {
    const request = ++catalogRequestRef.current;
    const result = await market.listCatalog({
      ...(sourceId ? { sourceId } : {}),
      ...(query.trim() ? { query: query.trim() } : {}),
      ...(installedOnly ? { installedOnly } : {}),
    });
    if (request !== catalogRequestRef.current) return;
    if (result.ok) {
      setCatalog(result.value);
      setFailure(null);
    } else {
      setFailure(result);
    }
  }, [market, sourceId, query, installedOnly]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  // The events re-read the catalog with the current filters; a ref keeps a
  // keystroke in the search box from re-subscribing and re-reading the sources.
  const loadCatalogRef = useRef(loadCatalog);
  useEffect(() => {
    loadCatalogRef.current = loadCatalog;
  });

  useEffect(() => {
    void loadSources().then((list) => {
      // First open: a shown source that never synced has nothing to list yet.
      if (!list || syncedOnce.current) return;
      syncedOnce.current = true;
      if (list.some((source) => source.enabled && source.status.state === "never-synced")) void market.refreshSources();
    });
    const offCatalog = market.onCatalogChanged(() => {
      void loadSources();
      void loadCatalogRef.current();
    });
    const offSync = market.onSyncProgress(() => void loadSources());
    return () => {
      offCatalog();
      offSync();
    };
  }, [market, loadSources]);

  // A deep link opens the confirming UI only: the package sheet or the Add dialog.
  useEffect(() => {
    const take = () =>
      void market.takeDeepLink().then((result) => {
        if (!result.ok) {
          setFailure(result);
          return;
        }
        const link = result.value;
        if (!link) return;
        if (link.action === "add") {
          setAddInput(link.url);
          setAddOpen("marketplace");
        } else {
          setView("browse");
          setSheet({ key: link.key, mode: "detail" });
        }
      });
    take();
    return market.onDeepLink(take);
  }, [market]);

  // The update pill asks for a review: an update installs only through it (design §15.6).
  useEffect(() => {
    const take = () => {
      const request = takeUpdateReview();
      if (!request) return;
      setView("browse");
      if (request.kind === "package") {
        setSheet({ key: request.key, mode: "update" });
      } else {
        // Every installed package, whatever the list was filtered to, so no update is hidden.
        setSheet(null);
        setKind(null);
        setSourceId(null);
        setQuery("");
        setInstalledOnly(true);
      }
    };
    take();
    return onUpdateReview(take);
  }, []);

  // What the boot-install step did, until dismissed (design §15.1).
  useEffect(() => {
    const read = () => void market.bootInstallNotice().then((result) => setNotice(result.ok ? result.value : null));
    read();
    return market.onBootInstallsApplied(read);
  }, [market]);

  const dismissNotice = async () => {
    const result = await market.dismissBootInstallNotice();
    if (result.ok) setNotice(null);
    else setFailure(result);
  };

  const uninstallFromNotice = async (key: PackageKeyView) => {
    const result = await market.uninstall({ ...key, ...(key.kind === "mcp" ? { removeData: false } : {}) });
    if (!result.ok) {
      setFailure(result);
      return;
    }
    setNotice((current) => {
      if (!current) return current;
      const forYou = current.forYou.filter((item) => !(item.sourceId === key.sourceId && item.kind === key.kind && item.name === key.name));
      const next = { ...current, forYou };
      return bootInstallNoticeIsEmpty(next) ? null : next;
    });
    void loadCatalog();
  };

  useEffect(() => {
    void api.getSettings().then(
      (settings) => {
        setUpdateCheckEnabled(settings.marketplace?.updateCheckEnabled !== false);
        setOfflineCacheEnabled(settings.marketplace?.offlineCacheEnabled !== false);
        setFlagsLoaded(true);
      },
      // The switches stay disabled, since their state is unknown; the failure says why.
      (error: unknown) => setFlagsFailure(errorMessage(error)),
    );
  }, [api]);

  const persistFlag = async (patch: { updateCheckEnabled?: boolean; offlineCacheEnabled?: boolean }) => {
    const result = await api.updateSettings({ marketplace: patch });
    if (isIpcErrorResult(result)) setFailure({ code: "unavailable", message: result.message ?? result.error });
  };

  const entries = useMemo(() => (catalog?.entries ?? []).filter((entry) => kind === null || entry.key.kind === kind), [catalog, kind]);
  const shownSources = sources.filter((source) => source.enabled);
  const total = catalog ? Object.values(catalog.counts).reduce((sum, count) => sum + count, 0) : 0;

  const uninstallUnbound = async (entry: CatalogEntryView) => {
    const result = await market.uninstall({ ...entry.key, ...(entry.key.kind === "mcp" ? { removeData: false } : {}) });
    if (!result.ok) setFailure(result);
    void loadCatalog();
  };

  const onAdded = (source: SourceView, preview: SourcePreviewView) => {
    setAddOpen(null);
    void loadSources();
    void loadCatalog();
    if (preview.type === "package") {
      setSheet({ key: { sourceId: source.id, kind: preview.kind, name: preview.name }, mode: "detail" });
    }
  };

  const openLocalFile = async () => {
    const result = await api.pluginStudio.previewInstallFromFile();
    if (result.ok && result.value) setLocalPreview(result.value);
    else if (!result.ok) setFailure({ code: "unavailable", message: result.message });
  };

  return (
    <div className="space-y-2" data-testid="git-marketplace">
      <SettingsPageHeader title={t("gitMarketplace.title")} description={t("gitMarketplace.description")} />

      <SettingsSection
        data-settings-section="marketplace-inventory"
        title={view === "sources" ? t("gitMarketplace.sources.title") : view === "direct" ? t("gitMarketplace.direct.title") : view === "studio" ? t("pluginStudio.title") : undefined}
      >
        <div className="flex flex-wrap items-center gap-2">
          {view === "browse" ? (
            <p className="mr-auto text-xs text-muted-foreground" data-testid="git-marketplace:summary">
              {t("gitMarketplace.summary", { count: total, sources: catalog?.sourceCount ?? 0 })}
              {catalog?.syncedAt ? ` · ${t("gitMarketplace.synced", { time: relativeTime(catalog.syncedAt, locale) })}` : ""}
            </p>
          ) : (
            <Button size="sm" variant="ghost" className="mr-auto" onClick={() => setView("browse")}>
              ← {t("gitMarketplace.backToBrowse")}
            </Button>
          )}
          <Button size="sm" variant={view === "sources" ? "secondary" : "outline"} onClick={() => setView(view === "sources" ? "browse" : "sources")} data-testid="git-marketplace:open-sources">
            {t("gitMarketplace.sources.title")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" data-testid="git-marketplace:add-menu">{t("gitMarketplace.addMenu")}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setAddOpen("marketplace")}>{t("gitMarketplace.addMarketplace")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setAddOpen("direct")}>{t("gitMarketplace.addFromGit")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setView("direct")}>{t("gitMarketplace.addMcp")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setView("studio")}>{t("pluginStudio.createTitle")}</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void openLocalFile()}>{t("pluginStudio.installFile")}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {failure && <p className="mt-2 text-sm text-destructive" data-testid="git-marketplace:error">{failureText(t, failure)}</p>}

        {view === "browse" && notice && (
          <div className="mt-3 space-y-2 rounded-md border border-info/(--opacity-medium) bg-info/(--opacity-soft) px-3 py-2 text-xs" data-testid="git-marketplace:boot-notice">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{t("gitMarketplace.boot.title")}</p>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => void dismissNotice()} data-testid="git-marketplace:boot-notice:dismiss">
                {t("gitMarketplace.boot.dismiss")}
              </Button>
            </div>
            {notice.forYou.length > 0 && (
              <div className="space-y-1">
                <p className="text-muted-foreground">{t("gitMarketplace.boot.forYou")}</p>
                <ul className="space-y-1">
                  {notice.forYou.map((key) => (
                    <li key={`${key.sourceId}:${key.kind}:${key.name}`} className="flex items-center gap-2">
                      <span>{kindLabel(t, key.kind)} · <span className="font-mono">{key.name}</span></span>
                      <Button size="sm" variant="outline" className="ml-auto h-6 px-2 text-[11px]" onClick={() => void uninstallFromNotice(key)} data-testid={`git-marketplace:boot-notice:uninstall:${key.kind}:${key.name}`}>
                        {t("gitMarketplace.uninstall.button")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {notice.required.length > 0 && (
              <div className="space-y-1">
                <p className="text-muted-foreground">{t("gitMarketplace.state.required")}</p>
                <ul className="space-y-0.5">
                  {notice.required.map((key) => (
                    <li key={`${key.sourceId}:${key.kind}:${key.name}`}>{kindLabel(t, key.kind)} · <span className="font-mono">{key.name}</span></li>
                  ))}
                </ul>
              </div>
            )}
            {notice.unmanaged.length > 0 && (
              <ul className="space-y-0.5" data-testid="git-marketplace:boot-notice:unmanaged">
                {notice.unmanaged.map((name) => (
                  <li key={name}>{t("gitMarketplace.boot.unmanaged", { name })}</li>
                ))}
              </ul>
            )}
            {notice.lostGrants.length > 0 && (
              <ul className="space-y-0.5" data-testid="git-marketplace:boot-notice:lost-grants">
                {notice.lostGrants.map((item) => (
                  <li key={item.plugin}>{t("gitMarketplace.boot.lostGrant", { name: item.plugin, keys: item.keys.join(", ") })}</li>
                ))}
              </ul>
            )}
            {notice.revoked.length > 0 && (
              <ul className="space-y-0.5" data-testid="git-marketplace:boot-notice:revoked">
                {notice.revoked.map((item) => (
                  <li key={`${item.key.sourceId}:${item.key.kind}:${item.key.name}`}>
                    {t(REVOKED_NOTICE_KEYS[item.outcome], {
                      source: item.key.sourceId,
                      name: item.key.name,
                      version: item.version,
                      reason: item.reason,
                      message: item.message ?? "",
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {view === "browse" && (
          <div className="mt-3 space-y-3">
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("gitMarketplace.searchPlaceholder")}
              aria-label={t("gitMarketplace.searchPlaceholder")}
              data-testid="git-marketplace:search"
            />
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("gitMarketplace.sourceFilterLabel")}>
              {[null, ...shownSources.map((source) => source.id)].map((id) => {
                const source = id === null ? null : shownSources.find((item) => item.id === id) ?? null;
                return (
                  <button
                    key={id ?? "all"}
                    type="button"
                    aria-pressed={sourceId === id}
                    onClick={() => setSourceId(id)}
                    className={cn("rounded-full border px-2.5 py-0.5 text-xs", sourceId === id ? "border-primary bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {source === null ? t("gitMarketplace.allSources") : source.origin === "official" ? originLabel(t, "official") : source.label}
                  </button>
                );
              })}
            </div>
            {/* The kinds wrap among themselves; Installed stays at the strip's end instead of wrapping alone onto a row. */}
            <div className="flex items-start gap-1 border-b" role="tablist" aria-label={t("gitMarketplace.kindTabsLabel")}>
              <div className="flex min-w-0 flex-1 flex-wrap gap-1">
              {[null, ...KIND_ORDER].map((item) => (
                <button
                  key={item ?? "all"}
                  type="button"
                  role="tab"
                  aria-selected={kind === item && !installedOnly}
                  onClick={() => {
                    setKind(item);
                    setInstalledOnly(false);
                  }}
                  className={cn("-mb-px border-b-2 px-2.5 py-1.5 text-xs", kind === item && !installedOnly ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
                  data-testid={`git-marketplace:kind:${item ?? "all"}`}
                >
                  {item === null ? t("gitMarketplace.kindAll") : kindLabel(t, item)} <span className="text-muted-foreground">{item === null ? total : catalog?.counts[item] ?? 0}</span>
                </button>
              ))}
              </div>
              <button
                type="button"
                role="tab"
                aria-selected={installedOnly}
                onClick={() => {
                  setInstalledOnly(true);
                  setKind(null);
                }}
                className={cn("-mb-px shrink-0 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-xs", installedOnly ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
                data-testid="git-marketplace:installed"
              >
                {t("gitMarketplace.installedTab")}
              </button>
            </div>
            {catalog === null ? (
              <p className="text-xs text-muted-foreground">{t("gitMarketplace.loading")}</p>
            ) : entries.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted-foreground" data-testid="git-marketplace:empty">
                {sources.some((source) => source.status.state === "never-synced" || source.status.state === "syncing") ? t("gitMarketplace.emptySyncing") : t("gitMarketplace.empty")}
              </p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2" data-testid="git-marketplace:cards">
                {entries.map((entry) => (
                  <PackageCard
                    key={`${entry.key.sourceId ?? "unbound"}:${entry.key.kind}:${entry.key.name}`}
                    entry={entry}
                    onOpen={() => entry.key.sourceId !== null && setSheet({ key: { ...entry.key, sourceId: entry.key.sourceId }, mode: entry.state.state === "update" ? "update" : "detail" })}
                    onUninstallUnbound={() => void uninstallUnbound(entry)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {view === "sources" && (
          <div className="mt-3">
            <SourcesView
              api={market}
              sources={sources}
              onChanged={() => {
                void loadSources();
                void loadCatalog();
              }}
              onAdd={() => setAddOpen("marketplace")}
            />
          </div>
        )}

        {view === "direct" && (
          <div className="mt-3">
            <DirectInstallView
              api={api}
              onGitAddress={() => setAddOpen("direct")}
              onOpenMcpSettings={onOpenMcpSettings}
              onInstalled={() => void loadCatalog()}
            />
          </div>
        )}
        {view === "studio" && <PluginStudioView api={api.pluginStudio} onInstalled={() => void loadCatalog()} />}
      </SettingsSection>

      <LocalPluginPackageSheet api={api.pluginStudio} preview={localPreview} onClose={() => setLocalPreview(null)} onInstalled={() => void loadCatalog()} />

      <SettingsSection data-settings-section="marketplace-maintenance" title={t("gitMarketplace.maintenance.title")} description={t("gitMarketplace.maintenance.description")}>
        <GitRuntimeCard api={api} />
        {flagsFailure !== null && (
          <p className="mt-4 text-sm text-destructive" data-testid="git-marketplace:maintenance:error">
            {t("gitMarketplace.error.unavailable", { message: flagsFailure })}
          </p>
        )}
        <div className="mt-4 flex items-center justify-between gap-4">
          <span className="text-sm font-medium">{t("gitMarketplace.maintenance.updateCheck")}</span>
          <Switch
            checked={updateCheckEnabled}
            disabled={!flagsLoaded}
            aria-label={t("gitMarketplace.maintenance.updateCheck")}
            data-testid="git-marketplace:update-check"
            onCheckedChange={(checked) => {
              setUpdateCheckEnabled(checked);
              void persistFlag({ updateCheckEnabled: checked });
            }}
          />
        </div>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="git-marketplace:update-check:help">{t("gitMarketplace.maintenance.updateCheckHelp")}</p>
        <EnvForcedNotice
          settingsPath="marketplace.updateCheckEnabled"
          forcedPaths={envForcedPaths}
          messageKey="gitMarketplace.maintenance.updateCheckEnvForced"
          testId="git-marketplace:update-check:forced"
          className="mt-1"
        />
        <div className="mt-3 flex items-center justify-between gap-4">
          <span className="text-sm font-medium">{t("gitMarketplace.maintenance.offlineCache")}</span>
          <Switch
            checked={offlineCacheEnabled}
            disabled={!flagsLoaded}
            aria-label={t("gitMarketplace.maintenance.offlineCache")}
            data-testid="git-marketplace:offline-cache"
            onCheckedChange={(checked) => {
              setOfflineCacheEnabled(checked);
              void persistFlag({ offlineCacheEnabled: checked });
            }}
          />
        </div>
        <p className="mt-1 text-xs text-muted-foreground" data-testid="git-marketplace:offline-cache:help">{t("gitMarketplace.maintenance.offlineCacheHelp")}</p>
        <EnvForcedNotice
          settingsPath="marketplace.offlineCacheEnabled"
          forcedPaths={envForcedPaths}
          messageKey="gitMarketplace.maintenance.offlineCacheEnvForced"
          testId="git-marketplace:offline-cache:forced"
          className="mt-1"
        />
      </SettingsSection>

      <AddSourceDialog
        api={api}
        open={addOpen !== null}
        direct={addOpen === "direct"}
        initialInput={addInput}
        onClose={() => {
          setAddOpen(null);
          setAddInput("");
        }}
        onAdded={(source, preview) => {
          setAddInput("");
          onAdded(source, preview);
        }}
      />
      <PackageSheet
        api={market}
        alertsApi={api}
        onOpenPluginSettings={onOpenPluginSettings}
        target={sheet}
        onClose={() => setSheet(null)}
        onChanged={() => {
          void loadCatalog();
          void loadSources();
        }}
      />
    </div>
  );
}
