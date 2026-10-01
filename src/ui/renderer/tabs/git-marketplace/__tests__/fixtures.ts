/**
 * A scripted `gitMarketplace` / `gitRuntime` pair for the view tests: every
 * method is a `vi.fn()` answering with the views main would send, and the
 * three event channels can be fired from the test.
 */
import { vi } from "vitest";
import type {
  CatalogEntryView,
  BootInstallNoticeView,
  CatalogView,
  GitMarketplaceApi,
  GitMarketplaceDeepLink,
  InstallPlanView,
  InstallProgressView,
  PackageDetailView,
  PackageKind,
  SourceView,
  SyncProgressView,
} from "../../../../../shared/git-marketplace.js";
import type { GitRuntimeApi, GitRuntimeStatus } from "../../../../../shared/git-runtime.js";

export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);

export function source(overrides: Partial<SourceView> & Pick<SourceView, "id">): SourceView {
  return {
    origin: "custom",
    label: overrides.id,
    url: `https://github.com/example/${overrides.id}.git`,
    ref: null,
    subdir: null,
    mirrors: 0,
    auth: "none",
    tokenHost: null,
    tokenStored: false,
    pinnedCommit: COMMIT_A,
    lastSyncAt: "2026-09-24T00:00:00.000Z",
    marketplace: null,
    packageCount: 1,
    status: { state: "up-to-date" },
    enabled: true,
    canDisable: true,
    canRemove: true,
    diagnostics: [],
    acknowledged: [],
    badges: [],
    ...overrides,
  };
}

export function entry(sourceId: string | null, kind: PackageKind, name: string, overrides: Partial<CatalogEntryView> = {}): CatalogEntryView {
  return {
    key: { sourceId, kind, name },
    sourceOrigin: sourceId === null ? null : sourceId === "ave-official" ? "official" : "custom",
    sourceLabel: sourceId,
    displayName: name,
    description: `${name} description`,
    keywords: [],
    state: { state: "install", version: "1.0.0" },
    required: false,
    runsCode: kind === "plugin" || kind === "mcp",
    sourceBadges: [],
    ...overrides,
  };
}

function catalog(entries: CatalogEntryView[], sourceCount: number): CatalogView {
  const counts = { "agent-plugin": 0, plugin: 0, mcp: 0, skill: 0, agent: 0, theme: 0, font: 0, language: 0, provider: 0, "messaging-connection": 0 } satisfies Record<PackageKind, number>;
  for (const item of entries) counts[item.key.kind] += 1;
  return { entries, counts, sourceCount, syncedAt: "2026-09-24T00:00:00.000Z" };
}

export function detail(item: CatalogEntryView, overrides: Partial<PackageDetailView> = {}): PackageDetailView {
  return {
    entry: item,
    provenance: {
      sourceLabel: item.sourceLabel ?? "—",
      repository: "https://github.com/example/market.git",
      path: `plugins/${item.key.name}`,
      snapshotCommit: COMMIT_A,
      versionCommit: COMMIT_A,
      publishedAt: "2026-09-20T00:00:00.000Z",
    },
    compatibility: { minAppVersion: "1.0.0", appVersion: "2.0.0", compatible: true },
    authority: { capabilities: [], networkHosts: ["api.example.com"], secrets: [], pluginAccess: [], dependencies: [], filesystem: [] },
    components: null,
    rungs: [{ rung: "release", declared: true, pinned: true, detail: `${item.key.name}.zip`, unencrypted: false }],
    versions: [
      { version: "1.0.0", commit: COMMIT_A, publishedAt: "2026-09-20T00:00:00.000Z", minAppVersion: "1.0.0", excluded: [], yankedReason: null, rolloutPercent: null, installed: false, candidate: true },
    ],
    ...overrides,
  };
}

export function installPlan(item: CatalogEntryView, overrides: Partial<InstallPlanView> = {}): InstallPlanView {
  if (item.key.sourceId === null) throw new Error("a plan needs a bound package");
  return {
    planId: "plan-1",
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    key: { sourceId: item.key.sourceId, kind: item.key.kind, name: item.key.name },
    displayName: item.displayName,
    version: "1.0.0",
    snapshotCommit: COMMIT_A,
    versionCommit: COMMIT_A,
    action: { action: "install" },
    runsCode: item.runsCode,
    authority: { capabilities: [], networkHosts: ["api.example.com"], secrets: [], pluginAccess: [], dependencies: [], filesystem: [] },
    components: null,
    hookConfinement: "user-permissions",
    rungs: [],
    mcp: null,
    ...overrides,
  };
}

function runtimeStatus(state: GitRuntimeStatus["state"]): GitRuntimeStatus {
  return {
    mode: "auto",
    state,
    active: state === "ready" ? { kind: "system", version: "2.47.0", path: "/usr/bin/git" } : null,
    systemTooOld: null,
    managed: { version: "2.51.0", installed: false, available: true, size: 62_348_987 },
    lastInstallError: null,
  };
}

export interface FakeMarketplace {
  market: { [K in keyof GitMarketplaceApi]: ReturnType<typeof vi.fn> };
  gitRuntime: { [K in keyof GitRuntimeApi]: ReturnType<typeof vi.fn> };
  emitCatalogChanged(): void;
  emitSyncProgress(progress: SyncProgressView): void;
  emitInstallProgress(progress: InstallProgressView): void;
  /** Hold a link for `takeDeepLink` and fire `onDeepLink`, as main does. */
  deliverDeepLink(link: GitMarketplaceDeepLink): void;
  /** Hold a notice for `bootInstallNotice` and fire `onBootInstallsApplied`. */
  applyBootInstalls(notice: BootInstallNoticeView): void;
}

export function fakeMarketplace(
  options: { sources?: SourceView[]; entries?: CatalogEntryView[]; git?: GitRuntimeStatus["state"]; deepLink?: GitMarketplaceDeepLink; bootNotice?: BootInstallNoticeView } = {},
): FakeMarketplace {
  const sources = options.sources ?? [];
  const entries = options.entries ?? [];
  const catalogListeners = new Set<() => void>();
  const syncListeners = new Set<(progress: SyncProgressView) => void>();
  const installListeners = new Set<(progress: InstallProgressView) => void>();
  const deepLinkListeners = new Set<() => void>();
  const bootListeners = new Set<() => void>();
  let heldLink: GitMarketplaceDeepLink | null = options.deepLink ?? null;
  let heldNotice: BootInstallNoticeView | null = options.bootNotice ?? null;
  const subscribe = <T,>(set: Set<T>) => (listener: T) => {
    set.add(listener);
    return () => set.delete(listener);
  };
  const ok = <T,>(value: T) => ({ ok: true as const, value });
  const market = {
    listSources: vi.fn(async () => ok(sources)),
    previewSource: vi.fn(),
    addSource: vi.fn(),
    acknowledgeSource: vi.fn(),
    removeSource: vi.fn(async () => ok({ orphanedPackages: [] })),
    setSourceEnabled: vi.fn(async (id: string) => ok(sources.find((item) => item.id === id))),
    refreshSources: vi.fn(async () => ok(sources)),
    repairSource: vi.fn(async () => ok(sources)),
    acceptRewrite: vi.fn(async (id: string) => ok(sources.find((item) => item.id === id))),
    setToken: vi.fn(async (host: string) => ok({ host })),
    deleteToken: vi.fn(async (host: string) => ok({ host })),
    listCatalog: vi.fn(async (query: { installedOnly?: boolean }) =>
      ok(catalog(query.installedOnly ? entries.filter((item) => item.state.state !== "install") : entries.filter((item) => item.key.sourceId !== null), sources.length))),
    packageDetail: vi.fn(async (key: { sourceId: string; kind: PackageKind; name: string }) => {
      const found = entries.find((item) => item.key.sourceId === key.sourceId && item.key.kind === key.kind && item.key.name === key.name);
      if (!found) throw new Error(`no fixture for ${key.name}`);
      return ok(detail(found));
    }),
    planInstall: vi.fn(),
    planUpdate: vi.fn(),
    executeInstall: vi.fn(),
    uninstall: vi.fn(async (request: { sourceId: string | null; kind: PackageKind; name: string }) => ok({ key: request, keptDataDir: null })),
    previewDirectMcp: vi.fn(),
    onSyncProgress: vi.fn(subscribe(syncListeners)),
    onCatalogChanged: vi.fn(subscribe(catalogListeners)),
    onInstallProgress: vi.fn(subscribe(installListeners)),
    takeDeepLink: vi.fn(async () => {
      const link = heldLink;
      heldLink = null;
      return ok(link);
    }),
    onDeepLink: vi.fn(subscribe(deepLinkListeners)),
    bootInstallNotice: vi.fn(async () => ok(heldNotice)),
    dismissBootInstallNotice: vi.fn(async () => {
      heldNotice = null;
      return ok(null);
    }),
    onBootInstallsApplied: vi.fn(subscribe(bootListeners)),
  };
  const gitRuntime = {
    status: vi.fn(async () => ({ ok: true as const, status: runtimeStatus(options.git ?? "ready") })),
    install: vi.fn(async () => ({ ok: true as const, status: runtimeStatus("ready") })),
    onProgress: vi.fn(() => () => undefined),
  };
  return {
    market,
    gitRuntime,
    emitCatalogChanged: () => catalogListeners.forEach((listener) => listener()),
    emitSyncProgress: (progress) => syncListeners.forEach((listener) => listener(progress)),
    emitInstallProgress: (progress) => installListeners.forEach((listener) => listener(progress)),
    deliverDeepLink: (link) => {
      heldLink = link;
      deepLinkListeners.forEach((listener) => listener());
    },
    applyBootInstalls: (notice) => {
      heldNotice = notice;
      bootListeners.forEach((listener) => listener());
    },
  };
}
