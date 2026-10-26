/** Every instantiation path uses the same routing decision and records its resolved launch without importing plugin code in main. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => ({
  specs: [] as Array<{ launch: { kind: string; entryPath?: string; command?: string }; childEntryPath?: string }>,
  /** Record launch specs instead of spawning when only routing is under test. */
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
  requires: { hostProtocol: "4" },
  tools: [],
};

const PROCESS_MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: PLUGIN_ID,
  version: "1.0.0",
  process: { command: "./bin/plugin" },
  requires: { minAppVersion: "0.13.0", hostProtocol: "4" },
  description: "a process plugin used to observe which arm the lifecycle chose",
  tools: [],
};

const SOURCE_KINDS = ["official", "managed", "custom", "direct"] as const;
const RUNGS = ["release", "archive", "tree", "folder", "legacy"] as const;
const INSTALL_SOURCES = ["user", "local-dev", "admin", "dev-link"] as const;
type SourceKind = (typeof SOURCE_KINDS)[number];
type Rung = (typeof RUNGS)[number];
type InstallSource = (typeof INSTALL_SOURCES)[number];

interface RegistryRow {
  installSource: InstallSource;
  origin?: { sourceKind: SourceKind; rung: Rung };
}

function label(row: RegistryRow): string {
  return row.origin
    ? `${row.installSource}/${row.origin.sourceKind}/${row.origin.rung}`
    : `${row.installSource}/origin-less`;
}

/** Each activation supplies the source and rung evidence its own receipt verification established. */
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
      // An unimportable path proves routing never imports plugin code in main.
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
    // Admission may produce a factory that still refuses at invocation before spawning.
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
