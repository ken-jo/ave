/** Folder-only service fixture: real orchestration, no network, and every git call fails. */
import AdmZip from "adm-zip";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { PayloadFile } from "../../../plugins/contribution-approval-digest.js";
import type { ExtensionComponentConsent } from "../../../shared/git-marketplace.js";
import { getAveAppVersion } from "../../../shared/app-version.js";
import { pluginConsent } from "../../updates/consent.js";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../../plugins/marketplace-artifact-limits.js";
import { PluginArtifactStore } from "../../../plugins/plugin-artifact-store.js";
import type { ComponentApprovalState, InstalledRecord, InstallerPorts } from "../../app/ports.js";
import { MarketplaceService } from "../../app/service.js";
import type { StagedContent } from "../../content/store.js";
import type { ExportLimits } from "../../git/repo.js";
import type { GitCommands } from "../../git/run-git.js";
import { NetworkGate } from "../../net/network-gate.js";
import type { StagedPluginArtifact } from "../../resolve/plugin-ladder.js";
import type { FolderFs } from "../../sources/folder-fs.js";
import { SourceRegistry } from "../../sources/registry.js";
import { SourceSyncer } from "../../sources/sync.js";
import { policySource, type TestPolicySource } from "./policy.js";

export interface FolderServiceHarness {
  service: MarketplaceService;
  installers: InstallerPorts;
  registry: SourceRegistry;
  syncer: SourceSyncer;
  policy: TestPolicySource;
  gitCalls: string[];
  fetches: string[];
  plugins: StagedPluginArtifact[];
  content: StagedContent[];
  /** Installed files, receipt fields and review options form the update baseline. */
  installed: Map<string, InstalledFixturePlugin>;
  approvals: Map<string, ComponentApprovalState[]>;
  onInstalled: { current: ((name: string) => void) | null };
  /** Awaited inside a plugin uninstall before the plugin is removed. */
  onUninstall: { current: (() => Promise<void>) | null };
  root: string;
  workRoot: string;
}

const NO_CACHE = { read: async () => null, keep: async () => {} };

interface InstalledFixturePlugin {
  version: string;
  sourceId: string;
  originCommit: string;
  digest: string;
  document: unknown;
  files: PayloadFile[];
  reviewedAppVersion: string | null;
  componentConsents: readonly ExtensionComponentConsent[];
}

function zipFiles(staged: StagedPluginArtifact): PayloadFile[] {
  return new AdmZip(staged.zipBuffer).getEntries().filter((entry) => !entry.isDirectory).map((entry) => ({ path: entry.entryName, data: entry.getData() }));
}

export async function folderService(options: {
  root: string;
  folders: { fs: FolderFs; platform: NodeJS.Platform; limits: ExportLimits };
  home?: string;
  policy?: TestPolicySource;
  now?: () => Date;
  installed?: InstalledRecord[];
  onPackageTransactionsIdle?: () => void;
}): Promise<FolderServiceHarness> {
  const policy = options.policy ?? policySource();
  const gitCalls: string[] = [];
  const fetches: string[] = [];
  const git: GitCommands = {
    run: async (args: readonly string[]) => {
      gitCalls.push(args.join(" "));
      throw new Error("a folder source never runs git");
    },
  } as unknown as GitCommands;
  const gate = new NetworkGate({
    policy,
    allowLoopback: false,
    transport: (async (url: string) => {
      fetches.push(String(url));
      throw new Error("no network in folder tests");
    }) as never,
  });
  const marketplaces = join(options.root, "marketplaces");
  const now = options.now ?? (() => new Date("2026-10-02T00:00:00.000Z"));
  const registry = await SourceRegistry.open({ root: marketplaces, policy, now, platform: options.folders.platform });
  const syncer = new SourceSyncer({ registry, gate, runner: git, root: marketplaces, now, retainedCommits: async () => new Set(), folders: options.folders });
  const plugins: StagedPluginArtifact[] = [];
  const content: StagedContent[] = [];
  const installed = new Map<string, InstalledFixturePlugin>();
  const approvals = new Map<string, ComponentApprovalState[]>();
  const onInstalled: FolderServiceHarness["onInstalled"] = { current: null };
  const onUninstall: FolderServiceHarness["onUninstall"] = { current: null };
  const installers: InstallerPorts = {
    plugin: {
      list: async () => [...installed.entries()].map(([name, item]) => ({ kind: "plugin" as const, name, version: item.version, sourceId: item.sourceId, originCommit: item.originCommit, digest: item.digest })),
      installedAuthority: async () => null,
      install: async (plan, { stage, assertConsent, reviewedAppVersion, componentConsents }) => {
        const staged = await stage(plan);
        plugins.push(staged);
        const files = zipFiles(staged);
        // Checkpoint two runs beside the manifest gate, before activation.
        assertConsent?.(pluginConsent(staged.manifestDocument, files));
        const previous = installed.get(plan.name);
        installed.set(plan.name, {
          version: plan.version,
          sourceId: plan.sourceId,
          originCommit: plan.snapshotCommit,
          digest: staged.artifactSha256,
          document: staged.manifestDocument,
          files,
          reviewedAppVersion: reviewedAppVersion ?? null,
          componentConsents: componentConsents ?? [],
        });
        onInstalled.current?.(plan.name);
        return { action: previous ? { action: "replace", direction: "upgrade", from: previous.version } : { action: "install" }, staged };
      },
      baseline: async (name) => {
        const item = installed.get(name);
        return item ? { consent: pluginConsent(item.document, item.files), reviewedAppVersion: item.reviewedAppVersion, enabled: true, files: item.files } : null;
      },
      stagedFiles: zipFiles,
      componentApprovals: (name) => approvals.get(name) ?? [],
      running: () => true,
      retire: async () => {},
      uninstall: async (name) => {
        await onUninstall.current?.();
        installed.delete(name);
      },
    },
    content: {
      list: async () => [...(options.installed ?? [])],
      installedComponents: async () => {
        throw new Error("no installed components in folder tests");
      },
      baseline: async () => null,
      installedFiles: async () => null,
      installId: async () => null,
      componentApprovals: async () => [],
      callsInFlight: async () => false,
      approveComponents: async () => {
        throw new Error("no component approvals in folder tests");
      },
      install: async (staged) => {
        content.push(staged);
        return { action: { action: "install" } };
      },
      uninstall: async (kind, name) => {
        const installed = options.installed ?? [];
        const at = installed.findIndex((item) => item.kind === kind && item.name === name);
        if (at >= 0) installed.splice(at, 1);
      },
    },
    mcp: {
      list: async () => [],
      baseline: async () => null,
      admit: () => {},
      install: async () => ({ action: { action: "install" }, connectionWarning: null }),
      installUnbound: async () => ({ connectionWarning: null }),
      uninstall: async () => ({ keptDataDir: null }),
    },
  };
  const workRoot = mkdtempSync(join(options.root, "work-"));
  const artifacts = new PluginArtifactStore({ installRoot: join(options.root, "mcp"), cacheRoot: join(options.root, "mcp", ".cache") });
  const service = new MarketplaceService({
    registry,
    syncer,
    git: {
      commands: git,
      credentialHelperFor: async () => false,
      preflight: async () => {
        gitCalls.push("preflight");
        throw new Error("a folder source never runs git");
      },
    },
    gate,
    root: marketplaces,
    workRoot,
    policy,
    tokens: { get: () => null, has: () => false, set: async () => {}, delete: async () => {} },
    previewTokens: new Map(),
    versionContext: () => ({ appVersion: getAveAppVersion(), platform: options.folders.platform, canaryOptIn: false, installationId: "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b" }),
    installers,
    ladder: { zip: artifacts, limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS, artifacts: NO_CACHE as never },
    mcpLimits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
    folders: { ...options.folders, home: options.home ?? "/Users/example" },
    english: {},
    now,
    revocations: { apply: async () => {} },
    log: { warn: () => {} },
    ...(options.onPackageTransactionsIdle ? { onPackageTransactionsIdle: options.onPackageTransactionsIdle } : {}),
    legacyMigration: {
      markerPath: join(options.root, "legacy-migration.json"),
      plugins: async () => {
        throw new Error("no legacy migration in folder tests");
      },
      content: async () => {
        throw new Error("no legacy migration in folder tests");
      },
    },
  });
  return { service, installers, registry, syncer, policy, gitCalls, fetches, plugins, content, installed, approvals, onInstalled, onUninstall, root: options.root, workRoot };
}
