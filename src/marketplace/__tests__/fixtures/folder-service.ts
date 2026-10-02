/**
 * Test fixture: the marketplace service over folder sources only. The
 * registry, gate, syncer and service are the real ones; git is a recorder
 * that fails any call (a folder source never runs git, §18.3 #6), there is
 * no network, and the installers record what they were handed.
 */
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_MARKETPLACE_ARTIFACT_LIMITS } from "../../../plugins/marketplace-artifact-limits.js";
import { PluginArtifactStore } from "../../../plugins/plugin-artifact-store.js";
import type { InstallerPorts } from "../../app/ports.js";
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
  registry: SourceRegistry;
  syncer: SourceSyncer;
  policy: TestPolicySource;
  /** Every git command anything asked for; each one failed. */
  gitCalls: string[];
  /** Every download the gate was asked for; each one failed. */
  fetches: string[];
  plugins: StagedPluginArtifact[];
  content: StagedContent[];
  root: string;
  workRoot: string;
}

const NO_CACHE = { read: async () => null, keep: async () => {} };

export async function folderService(options: {
  root: string;
  folders: { fs: FolderFs; platform: NodeJS.Platform; limits: ExportLimits };
  home?: string;
  policy?: TestPolicySource;
  now?: () => Date;
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
  const installers: InstallerPorts = {
    plugin: {
      list: async () => [],
      installedAuthority: async () => null,
      install: async (plan, { stage }) => {
        const staged = await stage(plan);
        plugins.push(staged);
        return { action: { action: "install" }, staged };
      },
      retire: async () => {},
      uninstall: async () => {},
    },
    content: {
      list: async () => [],
      installedComponents: async () => {
        throw new Error("no installed components in folder tests");
      },
      install: async (staged) => {
        content.push(staged);
        return { action: { action: "install" } };
      },
      uninstall: async () => {},
    },
    mcp: {
      list: async () => [],
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
    versionContext: () => ({ appVersion: "0.14.0", platform: options.folders.platform, canaryOptIn: false, installationId: "3f1c2b8e-6a4d-4e2f-9b1a-0c5d7e8f9a0b" }),
    installers,
    ladder: { zip: artifacts, limits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS, artifacts: NO_CACHE as never },
    mcpLimits: DEFAULT_MARKETPLACE_ARTIFACT_LIMITS,
    folders: { ...options.folders, home: options.home ?? "/Users/example" },
    english: {},
    now,
    revocations: { apply: async () => {} },
    log: { warn: () => {} },
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
  return { service, registry, syncer, policy, gitCalls, fetches, plugins, content, root: options.root, workRoot };
}
