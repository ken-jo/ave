/**
 * The routing matrix (`docs/design/plugin-hostapi-protocol.md` §9.8 A1,
 * decisions 3 and 50).
 *
 * Every instantiation path reaches a plugin's factory through
 * `importPluginFactoryForLifecycle`, and routing has no input: no plugin-id
 * table, manifest field, setting or environment variable selects the arm. This
 * file is the mechanical form of "out of process by default for every install
 * and every source", in three kinds of case over three separate dimensions —
 * the registry's `origin.sourceKind`, the artifact rung and `installSource`,
 * plus an origin-less legacy entry — on each platform:
 *
 *  (i)   positive `entry` routing: every combination gets the out-of-process
 *        factory with an `entry` launch and `arm: "child"`;
 *  (ii)  admitted `process` routing: a pinned `git` receipt from a marketplace
 *        source kind, rung `release` or `archive`, on macOS or Linux with the
 *        sandbox on, gets the process launch;
 *  (iii) explicit refusals: a `process` manifest that is not pinned is refused
 *        by the provenance gate before any factory exists, and an admitted one
 *        on Windows or with the sandbox off is refused by the factory.
 *
 * Routing and admission are different questions; the matrix answers both and
 * never lets a refusal read as a route. The factory is observed, not replaced:
 * it records the spec it was built with and, except where a case would spawn,
 * runs as in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => ({
  specs: [] as Array<{ launch: { kind: string; entryPath?: string; command?: string }; childEntryPath?: string }>,
  /**
   * Record the spec and hand back an inert plugin instead of the real factory's
   * product, for a case that asserts the launch the routing resolved and would
   * otherwise spawn a process.
   */
  recordOnly: false,
}));
const sandbox = vi.hoisted(() => ({ active: false }));

vi.mock("../../isolation/out-of-process-plugin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../isolation/out-of-process-plugin.js")>();
  return {
    ...actual,
    createOutOfProcessPluginFactory: (spec: Parameters<typeof actual.createOutOfProcessPluginFactory>[0]) => {
      factory.specs.push(spec as never);
      if (factory.recordOnly) return async () => ({ handlers: {} });
      return actual.createOutOfProcessPluginFactory(spec);
    },
  };
});
vi.mock("../../../permissions/asrt-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../permissions/asrt-sandbox.js")>();
  return { ...actual, isAsrtSandboxActive: () => sandbox.active };
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginRuntime, createNoopHostApiForTests } from "../../runtime.js";
import type { PluginIntegrityEvidence } from "../index.js";
import type { PluginManifest, RuntimePluginFactory } from "../../types.js";
import type { PluginLoadArm } from "../types.js";
import { ProcessEntryRequiresPinnedArtifactError, ProcessEntryUnconfinedError } from "../../process-entry.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../../__tests__/support/plugin-child-entry.js";
import { setProcessPlatform } from "../../../__tests__/support/process-platform.js";

const HOST_ROOT = "/tmp/ave-out-of-process-routing";
const PLUGIN_ID = "routingmatrixfixture";
const SHA = "a".repeat(64);

type FactorySource = { kind: "entry"; resolvedEntryPath: string } | { kind: "process" };

interface LifecycleRouting {
  importPluginFactoryForLifecycle(
    pluginId: string,
    source: FactorySource,
    manifest: PluginManifest,
    verified: PluginIntegrityEvidence | undefined,
  ): Promise<{ createPlugin: RuntimePluginFactory; arm: PluginLoadArm }>;
}

function routing(): LifecycleRouting {
  return new PluginRuntime({
    encryption: unavailableSecretEncryption,
    childEntryPath: pluginChildEntryPath(),
    hostRoot: HOST_ROOT,
    manifestPaths: [],
    createHostApi: createNoopHostApiForTests,
  }) as unknown as LifecycleRouting;
}

const ENTRY_MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: PLUGIN_ID,
  version: "1.0.0",
  entry: "plugin.mjs",
  description: "a plugin used to observe which arm the lifecycle chose",
  requires: { hostProtocol: "2" },
  tools: [],
};

const PROCESS_MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: PLUGIN_ID,
  version: "1.0.0",
  process: { command: "./bin/plugin" },
  requires: { minAppVersion: "0.13.0", hostProtocol: "2" },
  description: "a process plugin used to observe which arm the lifecycle chose",
  tools: [],
};

// ─── The registry dimensions (`src/plugins/registry.ts`) ─────────────────────

const SOURCE_KINDS = ["official", "managed", "custom", "direct"] as const;
const RUNGS = ["release", "archive", "tree", "folder", "legacy"] as const;
const INSTALL_SOURCES = ["user", "local-dev", "admin", "dev-link"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];
type Rung = (typeof RUNGS)[number];
type InstallSource = (typeof INSTALL_SOURCES)[number];

interface RegistryRow {
  installSource: InstallSource;
  /** Absent: an origin-less legacy entry. */
  origin?: { sourceKind: SourceKind; rung: Rung };
}

function label(row: RegistryRow): string {
  return row.origin
    ? `${row.installSource}/${row.origin.sourceKind}/${row.origin.rung}`
    : `${row.installSource}/origin-less`;
}

/**
 * The evidence an activation path verifies for an install the row describes:
 * what reaches the routing function. A local-development install verifies a
 * `local-dev` receipt; a folder install a `folder` receipt; a migrated legacy
 * install a v3 marketplace receipt with no artifact pin; a git install the rung
 * and source kind it came through; an origin-less legacy entry nothing at all.
 */
function evidenceFor(row: RegistryRow): PluginIntegrityEvidence | undefined {
  if (row.installSource === "local-dev" || row.installSource === "dev-link") {
    return { installSource: "local-dev", signerKeyId: null, artifactSha256: null, rung: null, sourceOrigin: null };
  }
  if (!row.origin) return undefined;
  switch (row.origin.rung) {
    case "folder":
      return { installSource: "folder", signerKeyId: null, artifactSha256: SHA, rung: "folder", sourceOrigin: null };
    case "legacy":
      return { installSource: "marketplace", signerKeyId: null, artifactSha256: null, rung: null, sourceOrigin: null };
    default:
      return {
        installSource: "git",
        signerKeyId: null,
        artifactSha256: SHA,
        rung: row.origin.rung,
        sourceOrigin: row.origin.sourceKind,
      };
  }
}

const EVERY_ROW: RegistryRow[] = INSTALL_SOURCES.flatMap((installSource) => [
  { installSource },
  ...SOURCE_KINDS.flatMap((sourceKind) => RUNGS.map((rung) => ({ installSource, origin: { sourceKind, rung } }))),
]);

const PLATFORMS = ["darwin", "linux", "win32"] as const;
const hostPlatform = process.platform;

/** A generation root with the executable the process manifest names. */
function processGeneration(): { root: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "routing-process-"));
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "plugin"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const dataDir = join(root, "data");
  mkdirSync(dataDir);
  return { root, dataDir };
}

beforeEach(() => {
  factory.specs.length = 0;
  factory.recordOnly = false;
  sandbox.active = false;
});
afterEach(() => setProcessPlatform(hostPlatform));

describe("(i) every entry manifest routes to a child", () => {
  it.each(PLATFORMS.flatMap((platform) => [true, false].map((sandboxOn) => [platform, sandboxOn] as const)))(
    "on %s with the sandbox on=%s, for every source kind, rung, install source and the origin-less entry",
    async (platform, sandboxOn) => {
      setProcessPlatform(platform);
      sandbox.active = sandboxOn;
      // A path that cannot be imported: nothing is imported in main, so the
      // route is decided without touching it.
      const entryPath = join(tmpdir(), "no-such-plugin-entry.mjs");
      expect(EVERY_ROW).toHaveLength(INSTALL_SOURCES.length * (1 + SOURCE_KINDS.length * RUNGS.length));
      for (const row of EVERY_ROW) {
        factory.specs.length = 0;
        const routed = await routing().importPluginFactoryForLifecycle(
          PLUGIN_ID,
          { kind: "entry", resolvedEntryPath: entryPath },
          ENTRY_MANIFEST,
          evidenceFor(row),
        );
        expect(routed.arm, label(row)).toBe("child");
        expect(factory.specs, label(row)).toHaveLength(1);
        expect(factory.specs[0]!.launch, label(row)).toEqual({ kind: "entry", entryPath });
        // The child runs the entry the composition root injected.
        expect(factory.specs[0]!.childEntryPath, label(row)).toBe(pluginChildEntryPath());
      }
    },
  );
});

describe("(ii) an admitted process manifest routes to its process launch", () => {
  const admitted = (["darwin", "linux"] as const).flatMap((platform) =>
    (["official", "managed", "custom"] as const).flatMap((sourceKind) =>
      (["release", "archive"] as const).map((rung) => [platform, sourceKind, rung] as const)));

  it.each(admitted)("on %s, a pinned %s %s install with the sandbox on", async (platform, sourceKind, rung) => {
    setProcessPlatform(platform);
    sandbox.active = true;
    // The launch is resolved when the lifecycle invokes the factory; the
    // factory only records it here, so the case does not spawn.
    factory.recordOnly = true;
    const routed = await routing().importPluginFactoryForLifecycle(
      PLUGIN_ID,
      { kind: "process" },
      PROCESS_MANIFEST,
      evidenceFor({ installSource: "user", origin: { sourceKind, rung } }),
    );
    expect(routed.arm).toBe("child");
    expect(factory.specs).toHaveLength(0);
    const generation = processGeneration();
    try {
      await routed.createPlugin({ pluginRoot: generation.root, pluginDataDir: generation.dataDir } as never);
    } finally {
      rmSync(generation.root, { recursive: true, force: true });
    }
    expect(factory.specs).toHaveLength(1);
    expect(factory.specs[0]!.launch.kind).toBe("process");
    expect(factory.specs[0]!.launch.command).toMatch(/[\\/]bin[\\/]plugin$/u);
  });
});

describe("(iii) explicit refusals, never a route", () => {
  const unpinned: RegistryRow[] = [
    { installSource: "user", origin: { sourceKind: "direct", rung: "release" } },
    { installSource: "user", origin: { sourceKind: "direct", rung: "archive" } },
    { installSource: "user", origin: { sourceKind: "custom", rung: "folder" } },
    { installSource: "user", origin: { sourceKind: "official", rung: "tree" } },
    { installSource: "local-dev", origin: { sourceKind: "custom", rung: "release" } },
    { installSource: "dev-link" },
    { installSource: "admin", origin: { sourceKind: "official", rung: "legacy" } },
    { installSource: "user" },
  ];

  it.each(PLATFORMS)("on %s, refuses an unpinned process manifest at the provenance gate before any factory exists", async (platform) => {
    setProcessPlatform(platform);
    sandbox.active = true;
    for (const row of unpinned) {
      await expect(
        routing().importPluginFactoryForLifecycle(PLUGIN_ID, { kind: "process" }, PROCESS_MANIFEST, evidenceFor(row)),
        label(row),
      ).rejects.toBeInstanceOf(ProcessEntryRequiresPinnedArtifactError);
    }
    expect(factory.specs).toHaveLength(0);
  });

  it.each([
    ["win32", true],
    ["darwin", false],
    ["linux", false],
  ] as const)("on %s with the sandbox on=%s, refuses an admitted process manifest in the factory", async (platform, sandboxOn) => {
    setProcessPlatform(platform);
    sandbox.active = sandboxOn;
    const routed = await routing().importPluginFactoryForLifecycle(
      PLUGIN_ID,
      { kind: "process" },
      PROCESS_MANIFEST,
      evidenceFor({ installSource: "user", origin: { sourceKind: "official", rung: "release" } }),
    );
    // A factory exists — the provenance gate admitted it — but invoking it is
    // refused before anything is spawned: the real factory runs here.
    const generation = processGeneration();
    try {
      await expect(
        routed.createPlugin({ pluginRoot: generation.root, pluginDataDir: generation.dataDir, hostApi: {} } as never),
      ).rejects.toBeInstanceOf(ProcessEntryUnconfinedError);
    } finally {
      rmSync(generation.root, { recursive: true, force: true });
    }
    expect(factory.specs.map((spec) => spec.launch.kind)).toEqual(["process"]);
  });

  it("refuses a source that disagrees with the manifest's shape", async () => {
    await expect(
      routing().importPluginFactoryForLifecycle(PLUGIN_ID, { kind: "process" }, ENTRY_MANIFEST, undefined),
    ).rejects.toThrow(/factory source is 'process' but its manifest declares 'entry'/);
    expect(factory.specs).toHaveLength(0);
  });
});
