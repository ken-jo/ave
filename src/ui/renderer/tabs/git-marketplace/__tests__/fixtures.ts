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
  MarketplacePreviewView,
  PackageDetailView,
  PackageKind,
  SourceView,
  SyncProgressView,
  UpdateStatusView,
} from "../../../../../shared/git-marketplace.js";
import type { GitRuntimeApi, GitRuntimeStatus } from "../../../../../shared/git-runtime.js";

export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);

/** A git source row. */
export function source(overrides: Partial<Extract<SourceView, { transport: "git" }>> & Pick<SourceView, "id">): SourceView {
  return {
    origin: "custom",
    label: overrides.id,
    transport: "git",
    url: `https://github.com/example/${overrides.id}.git`,
    path: null,
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

/** A folder source row (§18.4.8): read in place at `path`, pinned at its contents revision. */
export function folderSource(overrides: Partial<Extract<SourceView, { transport: "folder" }>> & Pick<SourceView, "id">): SourceView {
  return {
    origin: "custom",
    label: overrides.id,
    transport: "folder",
    url: null,
    path: `/Users/example/marketplaces/${overrides.id}`,
    ref: null,
    subdir: null,
    mirrors: 0,
    auth: "none",
    tokenHost: null,
    tokenStored: false,
    pinnedCommit: `local-${"c".repeat(64)}`,
    lastSyncAt: "2026-09-24T00:00:00.000Z",
    marketplace: null,
    packageCount: 1,
    status: { state: "up-to-date" },
    enabled: true,
    canDisable: true,
    canRemove: true,
    diagnostics: [],
    acknowledged: [],
    badges: ["local-folder"],
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
      folder: null,
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
    notInstalled: [],
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
  /** Push a scheduler status through `onUpdateStatus`, as `marketplace:update-status` does. */
  emitUpdateStatus(status: UpdateStatusView): void;
}

/** A scheduler that has not run yet, due now. */
export function updateStatus(overrides: Partial<UpdateStatusView> = {}): UpdateStatusView {
  return {
    discovery: { lastAttemptAt: null, lastSuccessAt: null, result: null, nextAt: "2026-10-01T00:00:00.000Z" },
    applyCheckAt: null,
    running: false,
    historyReset: false,
    packages: [],
    ...overrides,
  };
}

export function fakeMarketplace(
  options: {
    sources?: SourceView[];
    entries?: CatalogEntryView[];
    git?: GitRuntimeStatus["state"];
    deepLink?: GitMarketplaceDeepLink;
    bootNotice?: BootInstallNoticeView;
    updateStatus?: UpdateStatusView;
  } = {},
): FakeMarketplace {
  const sources = options.sources ?? [];
  const entries = options.entries ?? [];
  const catalogListeners = new Set<() => void>();
  const syncListeners = new Set<(progress: SyncProgressView) => void>();
  const installListeners = new Set<(progress: InstallProgressView) => void>();
  const deepLinkListeners = new Set<() => void>();
  const bootListeners = new Set<() => void>();
  const updateStatusListeners = new Set<(status: UpdateStatusView) => void>();
  const heldStatus = options.updateStatus ?? updateStatus();
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
    pickFolder: vi.fn(async () => ok(null)),
    revealSource: vi.fn(async () => ok(null)),
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
    updateStatus: vi.fn(async () => ok(heldStatus)),
    checkUpdates: vi.fn(async () => ok(heldStatus)),
    onUpdateStatus: vi.fn(subscribe(updateStatusListeners)),
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
    emitUpdateStatus: (status) => updateStatusListeners.forEach((listener) => listener(status)),
  };
}

/** A git marketplace's preview: two extensions and three skills, one broken entry. */
export const marketplacePreview: MarketplacePreviewView = {
  type: "marketplace",
  previewId: "preview-1",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  transport: "git",
  url: "https://github.com/example/team.git",
  path: null,
  resolvedFrom: null,
  badges: [],
  ref: null,
  commit: COMMIT_A,
  marketplace: { name: "team", displayName: "Team tools", description: null, owner: "example" },
  counts: { plugin: 2, skill: 3 },
  codeRunning: 2,
  diagnostics: ["plugins/broken: missing plugin.json"],
  credentialHelper: false,
  suggestedId: "team",
};
