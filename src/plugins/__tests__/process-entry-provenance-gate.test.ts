// Every activation path must verify its own process-entry provenance before spawning.
// An admitted fixture fails with process-entry-unconfined, distinguishing admission from the sandbox check.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reached = vi.hoisted(() => ({ gate: 0, factory: 0 }));
vi.mock("../process-entry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../process-entry.js")>();
  return {
    ...actual,
    assertProcessEntryAdmitted: (...args: Parameters<typeof actual.assertProcessEntryAdmitted>) => {
      reached.gate += 1;
      actual.assertProcessEntryAdmitted(...args);
    },
  };
});
vi.mock("../isolation/out-of-process-plugin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../isolation/out-of-process-plugin.js")>();
  return {
    ...actual,
    createOutOfProcessPluginFactory: (...args: Parameters<typeof actual.createOutOfProcessPluginFactory>) => {
      reached.factory += 1;
      return actual.createOutOfProcessPluginFactory(...args);
    },
  };
});

import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  agentPluginsDocument,
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  makeTestTreeWritable,
  makeTestManifest,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";
import {
  buildGitInstallReceipt,
  buildInstallReceipt,
  installReceiptPath,
  listFilesRecursive,
  writeInstallReceipt,
  type ArtifactRung,
  type GitInstallRecord,
} from "../plugin-install-receipt.js";
import { PLUGIN_RUNTIME_DIR_NAMES } from "../plugin-storage-layout.js";
import { ProcessEntryRequiresPinnedArtifactError, ProcessEntryUnconfinedError } from "../process-entry.js";
import { canonicalJSON } from "../secret-access/canonical-json.js";
import type { PluginRuntime } from "../runtime.js";
import type { PluginManifest } from "../types.js";
import { _resetForTest as resetDevFlags, setIsPackaged } from "../../boot/dev-flags.js";

const PLUGIN_ID = "process-kit";

const PROCESS_MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Process Kit",
  version: "1.0.0",
  description: "A process entry used to observe the provenance gate.",
  process: { command: "./bin/plugin" },
  requires: { minAppVersion: "0.13.0", hostProtocol: "4" },
  tools: [],
};

type Provenance = ArtifactRung | "direct-release" | "v3" | "local-dev";

function gitRecord(rung: ArtifactRung, sourceOrigin: GitInstallRecord["sourceOrigin"] = "custom"): GitInstallRecord {
  const skipped = (name: ArtifactRung) => ({ rung: name, outcome: "skipped" as const, reason: "NOT_DECLARED" as const });
  const ladder = { release: [], archive: [skipped("release")], tree: [skipped("release"), skipped("archive")] }[rung];
  return {
    sourceId: "acme",
    sourceOrigin,
    snapshotCommit: "a".repeat(40),
    versionCommit: "b".repeat(40),
    packagePath: "plugins/process-kit",
    rung,
    rungs: [...ladder, { rung, outcome: "used" }],
  };
}

async function receiptFor(pluginDir: string, receiptId: string, provenance: Provenance): Promise<string> {
  const files = await listFilesRecursive(pluginDir, PLUGIN_RUNTIME_DIR_NAMES);
  if (provenance === "v3" || provenance === "local-dev") {
    return (await buildInstallReceipt(pluginDir, {
      pluginId: receiptId,
      version: "1.0.0",
      installSource: provenance === "v3" ? "marketplace" : "local-dev",
      artifactSha256: provenance === "v3" ? "a".repeat(64) : null,
      signerKeyId: provenance === "v3" ? "test-v1" : null,
      files,
    })).raw;
  }
  return (await buildGitInstallReceipt(pluginDir, {
    pluginId: receiptId,
    version: "1.0.0",
    artifactSha256: "c".repeat(64),
    git: provenance === "direct-release" ? gitRecord("release", "direct") : gitRecord(provenance),
    files,
  })).raw;
}

async function writeReceipt(cacheRoot: string, pluginDir: string, provenance: Provenance): Promise<void> {
  const raw = await receiptFor(pluginDir, PLUGIN_ID, provenance);
  await writeInstallReceipt(cacheRoot, JSON.parse(raw));
}

async function writeProcessPayload(pluginDir: string): Promise<void> {
  await mkdir(join(pluginDir, "bin"), { recursive: true });
  await writeFile(join(pluginDir, "bin", "plugin"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(agentPluginsDocument(PROCESS_MANIFEST)), "utf8");
}

async function writeEntryPayload(pluginDir: string): Promise<void> {
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "entry.mjs"), "export default async () => ({ handlers: {} });\n", "utf8");
  await writeFile(
    join(pluginDir, "plugin.json"),
    JSON.stringify(agentPluginsDocument(makeTestManifest({ id: PLUGIN_ID, entry: "entry.mjs", tools: [] }))),
    "utf8",
  );
}

async function becomeProcessPlugin(pluginDir: string): Promise<void> {
  await rm(join(pluginDir, "entry.mjs"));
  await writeProcessPayload(pluginDir);
}

function cardOf(runtime: PluginRuntime) {
  return runtime.listPluginCards().find((candidate) => candidate.id === PLUGIN_ID);
}

let fixture: TestPluginRuntimeFixture;
let cacheRoot: string;
let pluginDir: string;
let manifestPath: string;

beforeEach(async () => {
  reached.gate = 0;
  reached.factory = 0;
  fixture = await makeTestPluginRuntimeFixture({ prefix: "ave-process-gate-" });
  cacheRoot = join(fixture.rootDir, "cache");
  pluginDir = join(fixture.pluginsRoot, PLUGIN_ID);
  manifestPath = join(pluginDir, "plugin.json");
  await mkdir(pluginDir, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  resetDevFlags();
  await makeTestTreeWritable(fixture.rootDir);
  await rm(fixture.rootDir, { recursive: true, force: true });
});

async function registryRuntime(audit: unknown[] = []): Promise<PluginRuntime> {
  await writeTestPluginRegistry(fixture, [{ id: PLUGIN_ID, manifestPath, enabled: true }]);
  return makeTestPluginRuntime(fixture, {
    installReceiptCacheRoot: cacheRoot,
    auditLog: (_level, message, data) => void audit.push({ message, data }),
  });
}

/** Plans without registry IDs provide no verified receipt evidence. */
async function unidentifiedRuntime(): Promise<PluginRuntime> {
  await writeTestPluginRegistry(fixture, []);
  return makeTestPluginRuntime(fixture, { installReceiptCacheRoot: cacheRoot, manifestPaths: [manifestPath] });
}

const REFUSED: ReadonlyArray<[string, Provenance, boolean]> = [
  ["a tree-rung git receipt", "tree", false],
  ["a pinned release from a direct source", "direct-release", false],
  ["a v3 marketplace receipt", "v3", false],
  ["a local-dev receipt under dev unlock", "local-dev", true],
];

/** Local-dev receipt verification requires an unpackaged build with AVE_DEV=1. */
function arrange(devUnlocked: boolean): void {
  if (!devUnlocked) return;
  setIsPackaged(false);
  vi.stubEnv("AVE_DEV", "1");
}

describe("boot", () => {
  it.each(["release", "archive"] as const)("admits a %s-rung git install, which then reaches the factory", async (rung) => {
    await writeProcessPayload(pluginDir);
    await writeReceipt(cacheRoot, pluginDir, rung);
    const audit: unknown[] = [];
    const runtime = await registryRuntime(audit);
    await runtime.startAll();
    expect(reached.factory).toBe(1);
    expect(audit).toContainEqual({
      message: "plugin_integrity_verified",
      data: expect.objectContaining({ pluginId: PLUGIN_ID, installSource: "git", rung }),
    });
    expect(cardOf(runtime)).toMatchObject({ loadStatus: "failed", installFailureKind: "process-entry-unconfined" });
  });

  it.each(REFUSED)("refuses %s at the gate", async (_name, provenance, devUnlocked) => {
    arrange(devUnlocked);
    await writeProcessPayload(pluginDir);
    await writeReceipt(cacheRoot, pluginDir, provenance);
    const runtime = await registryRuntime();
    await runtime.startAll();
    expect(reached.gate).toBe(1);
    expect(reached.factory).toBe(0);
    expect(cardOf(runtime)).toMatchObject({
      loadStatus: "failed",
      installFailureKind: "process-entry-requires-pinned-artifact",
    });
  });

  it("refuses a valid receipt this path did not verify", async () => {
    await writeProcessPayload(pluginDir);
    await writeReceipt(cacheRoot, pluginDir, "release");
    const runtime = await unidentifiedRuntime();
    await runtime.startAll();
    expect(reached.factory).toBe(0);
    expect(cardOf(runtime)).toMatchObject({ installFailureKind: "process-entry-requires-pinned-artifact" });
  });
});

describe("post-boot add", () => {
  it("admits a release-rung git install, which then reaches the factory", async () => {
    await writeProcessPayload(pluginDir);
    await writeReceipt(cacheRoot, pluginDir, "release");
    const runtime = await registryRuntime();
    await expect(runtime.addPlugin(PLUGIN_ID)).rejects.toThrow(/OS sandbox that confines processes/);
    expect(reached.factory).toBe(1);
    expect(cardOf(runtime)).toMatchObject({ installFailureKind: "process-entry-unconfined" });
  });

  it.each(REFUSED)("refuses %s at the gate", async (_name, provenance, devUnlocked) => {
    arrange(devUnlocked);
    await writeProcessPayload(pluginDir);
    await writeReceipt(cacheRoot, pluginDir, provenance);
    const runtime = await registryRuntime();
    await expect(runtime.addPlugin(PLUGIN_ID)).rejects.toThrow(/pinned by a release or archive artifact/);
    expect(reached.gate).toBe(1);
    expect(reached.factory).toBe(0);
    expect(cardOf(runtime)).toMatchObject({ installFailureKind: "process-entry-requires-pinned-artifact" });
  });

  it("refuses a valid receipt this path did not verify", async () => {
    await writeProcessPayload(pluginDir);
    await writeReceipt(cacheRoot, pluginDir, "release");
    const runtime = await unidentifiedRuntime();
    await expect(runtime.addPlugin(PLUGIN_ID)).rejects.toThrow(/pinned by a release or archive artifact/);
    expect(reached.factory).toBe(0);
  });
});

describe("prepared activation", () => {
  const INSTALL_ID = "catalog-process-kit";

  async function prepared(provenance: Provenance) {
    const staging = join(fixture.rootDir, "staging");
    await writeProcessPayload(staging);
    return {
      installId: INSTALL_ID,
      pluginRoot: staging,
      manifest: PROCESS_MANIFEST,
      receiptRaw: await receiptFor(staging, INSTALL_ID, provenance),
      registryEntry: {
        installSource: "user" as const,
        manifestSha256: createHash("sha256").update(canonicalJSON(agentPluginsDocument(PROCESS_MANIFEST))).digest("hex"),
      },
      durableCommit: async () => "committed",
    };
  }

  it("verifies the staged receipt itself and admits a release-rung artifact, which then reaches the factory", async () => {
    const runtime = makeTestPluginRuntime(fixture, { installReceiptCacheRoot: cacheRoot });
    await expect(runtime.activatePreparedArtifact(await prepared("release"))).rejects.toBeInstanceOf(
      ProcessEntryUnconfinedError,
    );
    expect(reached.factory).toBe(1);
  });

  it.each(REFUSED)("refuses %s at the gate", async (_name, provenance, devUnlocked) => {
    arrange(devUnlocked);
    const runtime = makeTestPluginRuntime(fixture, { installReceiptCacheRoot: cacheRoot });
    await expect(runtime.activatePreparedArtifact(await prepared(provenance))).rejects.toBeInstanceOf(
      ProcessEntryRequiresPinnedArtifactError,
    );
    expect(reached.gate).toBe(1);
    expect(reached.factory).toBe(0);
  });
});

describe("restart", () => {
  async function runningThenProcess(
    makeRuntime: () => Promise<PluginRuntime>,
    provenance: Provenance,
  ): Promise<PluginRuntime> {
    await writeEntryPayload(pluginDir);
    await writeReceipt(cacheRoot, pluginDir, "release");
    const runtime = await makeRuntime();
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain(PLUGIN_ID);
    await becomeProcessPlugin(pluginDir);
    await writeReceipt(cacheRoot, pluginDir, provenance);
    reached.gate = 0;
    reached.factory = 0;
    return runtime;
  }

  it("admits a release-rung git install, which then reaches the factory", async () => {
    const runtime = await runningThenProcess(registryRuntime, "release");
    await expect(runtime.restartPlugin(PLUGIN_ID, { throwOnFailure: true })).rejects.toBeInstanceOf(
      ProcessEntryUnconfinedError,
    );
    expect(reached.factory).toBe(1);
  });

  it.each(REFUSED)("refuses %s at the gate", async (_name, provenance, devUnlocked) => {
    arrange(devUnlocked);
    const runtime = await runningThenProcess(registryRuntime, provenance);
    await expect(runtime.restartPlugin(PLUGIN_ID, { throwOnFailure: true })).rejects.toBeInstanceOf(
      ProcessEntryRequiresPinnedArtifactError,
    );
    expect(reached.gate).toBe(1);
    expect(reached.factory).toBe(0);
  });

  it("refuses a valid receipt this path did not verify", async () => {
    const runtime = await runningThenProcess(unidentifiedRuntime, "release");
    await expect(runtime.restartPlugin(PLUGIN_ID, { throwOnFailure: true })).rejects.toBeInstanceOf(
      ProcessEntryRequiresPinnedArtifactError,
    );
    expect(reached.factory).toBe(0);
  });
});

/** Receipt integrity precedes provenance, routing and confinement; missing receipts must fail before the gate. */
describe("precedence: no receipt is a receipt refusal, never the gate's", () => {
  /** Restore the production materializer so this case actually reads the receipt. */
  function withRealMaterialisation(runtime: PluginRuntime): PluginRuntime {
    delete (runtime as unknown as Record<string, unknown>).materializeImmutableRuntimeRoot;
    delete (runtime as unknown as Record<string, unknown>).removeUnpublishedRuntimeRoot;
    return runtime;
  }

  it("boot with a registry id refuses on the receipt before reading the manifest", async () => {
    await writeProcessPayload(pluginDir);
    const runtime = await registryRuntime();
    const readManifest = vi.spyOn(runtime as unknown as { readManifest: (path: string) => Promise<unknown> }, "readManifest");
    await runtime.startAll();
    expect(readManifest).not.toHaveBeenCalled();
    const card = runtime.listPluginCards().find((candidate) => candidate.id === PLUGIN_ID);
    expect(card?.installFailureMessage).toMatch(/install receipt missing or unreadable/);
    expect(reached.gate).toBe(0);
    expect(reached.factory).toBe(0);
  });

  it("add with a registry id refuses on the receipt", async () => {
    await writeProcessPayload(pluginDir);
    const runtime = await registryRuntime();
    await expect(runtime.addPlugin(PLUGIN_ID)).rejects.toThrow();
    expect(cardOf(runtime)?.installFailureMessage).toMatch(/install receipt missing or unreadable/);
    expect(reached.gate).toBe(0);
    expect(reached.factory).toBe(0);
  });

  it("restart with a receipt id refuses on the receipt", async () => {
    await writeEntryPayload(pluginDir);
    await writeReceipt(cacheRoot, pluginDir, "release");
    const runtime = await registryRuntime();
    await runtime.startAll();
    await becomeProcessPlugin(pluginDir);
    await rm(installReceiptPath(cacheRoot, PLUGIN_ID));
    // Boot already called the child factory; restart must not call it again.
    reached.gate = 0;
    reached.factory = 0;
    await expect(runtime.restartPlugin(PLUGIN_ID, { throwOnFailure: true })).resolves.toBe("failed");
    expect(reached.gate).toBe(0);
    expect(reached.factory).toBe(0);
  });

  it("boot without an id fails materialising the generation from the missing receipt", async () => {
    await writeProcessPayload(pluginDir);
    const runtime = withRealMaterialisation(await unidentifiedRuntime());
    await runtime.startAll();
    expect(cardOf(runtime)?.installFailureMessage).toMatch(/ENOENT/);
    expect(reached.gate).toBe(0);
    expect(reached.factory).toBe(0);
  });

  it("add without an id fails materialising the generation from the missing receipt", async () => {
    await writeProcessPayload(pluginDir);
    const runtime = withRealMaterialisation(await unidentifiedRuntime());
    await expect(runtime.addPlugin(PLUGIN_ID)).rejects.toThrow(/ENOENT/);
    expect(reached.gate).toBe(0);
    expect(reached.factory).toBe(0);
  });

  it("restart without an id fails materialising the generation from the missing receipt", async () => {
    await writeEntryPayload(pluginDir);
    await writeReceipt(cacheRoot, pluginDir, "release");
    const runtime = withRealMaterialisation(await unidentifiedRuntime());
    await runtime.startAll();
    expect(runtime.listPluginIds()).toContain(PLUGIN_ID);
    await becomeProcessPlugin(pluginDir);
    await rm(installReceiptPath(cacheRoot, PLUGIN_ID));
    // Boot already called the child factory; restart must not call it again.
    reached.gate = 0;
    reached.factory = 0;
    await expect(runtime.restartPlugin(PLUGIN_ID, { throwOnFailure: true })).rejects.toThrow(/ENOENT/);
    expect(reached.gate).toBe(0);
    expect(reached.factory).toBe(0);
  });
});
