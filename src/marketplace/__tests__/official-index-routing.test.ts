/**
 * "True for the official index" (`docs/design/plugin-hostapi-protocol.md` §9.1
 * Admission row, §9.8 A1, decision 51).
 *
 * The fixture is the official repository's committed `marketplace.json`
 * (`ken-jo/agent-marketplace` at `6a4d3b3df60fbc1ffe4ade7ffb601b61781c6a27`,
 * sha256 `2e31b360da69f2915f45653cdee2f65ccb057ccf13cf0213d5ec1a4302d96221`),
 * reduced to its `plugin` packages — the five this test is about, with every
 * version as published, `sampleassistant` included because it is still
 * indexed; the other kinds carry no code and are not routed. It is a
 * captured record of what was published, read here as raw JSON for the
 * versions' manifest shapes; the catalog reader, which reads only
 * `schemaVersion: 2`, never sees it. Nothing is downloaded.
 *
 * Each version's released manifest shape is read off the index and routed
 * through the runtime's routing function with the evidence an install from
 * the official source verifies — a pinned release — and every one is a child.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const factory = vi.hoisted(() => ({ launches: [] as Array<{ kind: string }> }));
vi.mock("../../plugins/isolation/out-of-process-plugin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/isolation/out-of-process-plugin.js")>();
  return {
    ...actual,
    createOutOfProcessPluginFactory: (spec: Parameters<typeof actual.createOutOfProcessPluginFactory>[0]) => {
      factory.launches.push(spec.launch);
      return actual.createOutOfProcessPluginFactory(spec);
    },
  };
});

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PluginRuntime, createNoopHostApiForTests } from "../../plugins/runtime.js";
import type { PluginIntegrityEvidence } from "../../plugins/runtime/index.js";
import type { PluginLoadArm } from "../../plugins/runtime/types.js";
import type { PluginManifest, RuntimePluginFactory } from "../../plugins/types.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { pluginChildEntryPath } from "../../__tests__/support/plugin-child-entry.js";

interface IndexVersion {
  version: string;
  minAppVersion: string;
  authority?: { requires?: PluginManifest["requires"]; process?: unknown; platforms?: unknown };
  artifact: { release?: { sha256: string } };
  process?: unknown;
  platforms?: unknown;
}

interface IndexPackage {
  kind: string;
  name: string;
  displayName?: string;
  description: string;
  versions: IndexVersion[];
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "official-marketplace-6a4d3b3df.plugins.json");
const index = JSON.parse(readFileSync(FIXTURE, "utf-8")) as { schemaVersion: number; packages: IndexPackage[] };

/**
 * The manifest shape a released version has, as the index records it. A
 * format-1 index names no `process` launch and no `platforms`, so each version
 * is an `entry` plugin; the shape check below fails loudly the day a version
 * says otherwise, so a `process` plugin is never routed as an `entry` one here.
 */
function releasedManifest(pkg: IndexPackage, version: IndexVersion): PluginManifest {
  expect(version.process ?? version.authority?.process, `${pkg.name}@${version.version}`).toBeUndefined();
  expect(version.platforms ?? version.authority?.platforms, `${pkg.name}@${version.version}`).toBeUndefined();
  return {
    id: pkg.name,
    name: pkg.displayName ?? pkg.name,
    version: version.version,
    description: pkg.description,
    entry: "dist/index.js",
    requires: { minAppVersion: version.minAppVersion, ...version.authority?.requires },
    tools: [],
  };
}

/** What an install of this version from the official source verifies: a pinned release. */
function officialRelease(version: IndexVersion): PluginIntegrityEvidence {
  const sha256 = version.artifact.release?.sha256;
  expect(sha256).toMatch(/^[a-f0-9]{64}$/u);
  return { installSource: "git", signerKeyId: null, artifactSha256: sha256!, rung: "release", sourceOrigin: "official" };
}

interface LifecycleRouting {
  importPluginFactoryForLifecycle(
    pluginId: string,
    source: { kind: "entry"; resolvedEntryPath: string },
    manifest: PluginManifest,
    verified: PluginIntegrityEvidence | undefined,
  ): Promise<{ createPlugin: RuntimePluginFactory; arm: PluginLoadArm }>;
}

beforeEach(() => {
  factory.launches.length = 0;
});

describe("the committed official index routes every plugin version to a child", () => {
  it("holds the five indexed plugins", () => {
    expect(index.schemaVersion).toBe(1);
    expect(index.packages.map((pkg) => pkg.name).sort()).toEqual([
      "hello-world",
      "local-indexer",
      "meeting",
      "sampleassistant",
      "samplemail",
    ]);
    expect(index.packages.every((pkg) => pkg.kind === "plugin")).toBe(true);
  });

  it.each(index.packages.flatMap((pkg) => pkg.versions.map((version) => [pkg.name, version.version, pkg, version] as const)))(
    "%s@%s is a child",
    async (_name, _version, pkg, version) => {
      const runtime = new PluginRuntime({
        encryption: unavailableSecretEncryption,
        childEntryPath: pluginChildEntryPath(),
        hostRoot: "/tmp/ave-official-index-routing",
        manifestPaths: [],
        createHostApi: createNoopHostApiForTests,
      }) as unknown as LifecycleRouting;
      const manifest = releasedManifest(pkg, version);
      const routed = await runtime.importPluginFactoryForLifecycle(
        manifest.id,
        { kind: "entry", resolvedEntryPath: join("/tmp/ave-official-index-routing", manifest.id, "dist", "index.js") },
        manifest,
        officialRelease(version),
      );
      expect(routed.arm).toBe("child");
      expect(factory.launches.map((launch) => launch.kind)).toEqual(["entry"]);
    },
  );
});
