import type {
  CatalogEntryView,
  GitMarketplaceApi,
  GitMarketplaceResult,
  InstallResultView,
  PackageKeyView,
  SourceView,
} from "../../../shared/git-marketplace.js";
import type { PluginCardSummary } from "../types.js";

/**
 * Plugin Doctor "repair" target resolution.
 *
 * Extracted from `PluginConfigTab.tsx` so the choice of which marketplace
 * package a repair reinstalls is unit-testable. A git marketplace installs a
 * plugin under its package name, so the installed plugin's id is that name.
 */

/** Install key to use when refreshing cards after a repair. */
export function getPluginDoctorInstallKey(plugin: PluginCardSummary): string {
  return plugin.installAliases?.[0] ?? plugin.id;
}

/** The installed catalog entry this plugin is bound to, or `null` when no source binds it. */
export function findPluginDoctorEntry(
  plugin: PluginCardSummary,
  entries: readonly CatalogEntryView[],
): (CatalogEntryView & { key: PackageKeyView }) | null {
  const entry = entries.find((item) => item.key.kind === "plugin" && item.key.name === plugin.id
    && item.state.state !== "installed-elsewhere" && item.state.state !== "unbound" && item.state.state !== "source-removed");
  if (!entry || entry.key.sourceId === null) return null;
  return { ...entry, key: { ...entry.key, sourceId: entry.key.sourceId } };
}

export type PluginProtocolUpdatePath =
  | { kind: "catalog"; key: PackageKeyView; version: string; from: string }
  | { kind: "repository"; url: string; sourceLabel: string }
  | { kind: "unavailable" };

/** Resolve a refused plugin through its installed source, never another source of the same name. */
export function findPluginProtocolUpdatePath(
  plugin: PluginCardSummary,
  entries: readonly CatalogEntryView[],
  sources: readonly SourceView[],
): PluginProtocolUpdatePath {
  const entry = findPluginDoctorEntry(plugin, entries);
  if (!entry) return { kind: "unavailable" };
  if (entry.state.state === "update") {
    return { kind: "catalog", key: entry.key, version: entry.state.to, from: entry.state.from };
  }
  const source = sources.find((candidate) => candidate.id === entry.key.sourceId);
  return source ? { kind: "repository", url: source.url, sourceLabel: source.label } : { kind: "unavailable" };
}

export async function resolvePluginProtocolUpdatePath(
  market: Pick<GitMarketplaceApi, "listCatalog" | "listSources">,
  plugin: PluginCardSummary,
): Promise<PluginProtocolUpdatePath> {
  const catalog = await market.listCatalog({ kind: "plugin", installedOnly: true });
  if (!catalog.ok) return { kind: "unavailable" };
  const entry = findPluginDoctorEntry(plugin, catalog.value.entries);
  if (!entry) return { kind: "unavailable" };
  if (entry.state.state === "update") return findPluginProtocolUpdatePath(plugin, catalog.value.entries, []);
  const sources = await market.listSources();
  return findPluginProtocolUpdatePath(plugin, catalog.value.entries, sources.ok ? sources.value : []);
}

/** The version on disk, when the entry's state carries one that can be read. */
function installedVersion(entry: CatalogEntryView): string | null {
  switch (entry.state.state) {
    case "installed":
      return entry.state.version;
    case "update":
      return entry.state.from;
    default:
      return null;
  }
}

export type PluginDoctorRepair =
  | { status: "reinstalled"; result: InstallResultView }
  | { status: "unbound" }
  | { status: "failed"; message: string };

/**
 * Reinstall the version on disk from the plugin's own source. The same
 * version carries the same authority, so the repair needs no update review
 * (design §15.6); an unreadable version installs the source's candidate, which
 * the plan classifies as a repair.
 */
export async function repairPluginFromMarketplace(
  market: Pick<GitMarketplaceApi, "listCatalog" | "planInstall" | "executeInstall">,
  plugin: PluginCardSummary,
): Promise<PluginDoctorRepair> {
  const failed = (result: Extract<GitMarketplaceResult<unknown>, { ok: false }>): PluginDoctorRepair => ({
    status: "failed",
    message: result.message,
  });
  const catalog = await market.listCatalog({ kind: "plugin", installedOnly: true });
  if (!catalog.ok) return failed(catalog);
  const entry = findPluginDoctorEntry(plugin, catalog.value.entries);
  if (!entry) return { status: "unbound" };
  const version = installedVersion(entry);
  const plan = await market.planInstall({ ...entry.key, ...(version ? { version } : {}) });
  if (!plan.ok) return failed(plan);
  const result = await market.executeInstall(plan.value.planId);
  if (!result.ok) return failed(result);
  return { status: "reinstalled", result: result.value };
}
