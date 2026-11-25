/** What a plugin child start is named by, over real loads: the same plugin loaded again is the same start, an edited one is another. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Spec = { manifest: { id: string; version?: string }; launch: { kind: "entry" | "process" }; integrity?: object };
const factory = vi.hoisted(() => ({ specs: [] as Spec[], identity: (_spec: Spec): string => "unset" }));

vi.mock("../../isolation/out-of-process-plugin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../isolation/out-of-process-plugin.js")>();
  // The identity the real factory would present at the gate for this spec.
  factory.identity = (spec) => actual.pluginChildStartIdentity({ manifest: spec.manifest as never, launchKind: spec.launch.kind, integrity: spec.integrity });
  return {
    ...actual,
    createOutOfProcessPluginFactory: (spec: Spec) => {
      factory.specs.push(spec);
      return async () => ({ handlers: {} });
    },
  };
});

import { makeTestPluginRuntime, servedAgentPluginsDocument } from "../../__tests__/test-helpers.js";

const PLUGIN_ID = "start-identity";

describe("a plugin child start's identity over real loads", () => {
  let testDir: string;
  let manifestPath: string;
  let registryPath: string;

  const writeManifest = (overrides: Record<string, unknown> = {}) => writeFile(manifestPath, JSON.stringify(servedAgentPluginsDocument({
    id: PLUGIN_ID, name: "Start Identity", version: "1.0.0", entry: "plugin.mjs", description: "identity fixture", tools: [], ...overrides,
  })), "utf-8");

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-start-identity-"));
    const pluginDir = join(testDir, "plugins", PLUGIN_ID);
    await mkdir(pluginDir, { recursive: true });
    manifestPath = join(pluginDir, "plugin.json");
    registryPath = join(testDir, "plugins", "registry.json");
    for (const entry of ["plugin.mjs", "other.mjs"]) await writeFile(join(pluginDir, entry), "export default async function createPlugin() { return { handlers: {} }; }\n", "utf-8");
    await writeManifest();
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [{ id: PLUGIN_ID, manifestPath, enabled: true }] }), "utf-8");
    factory.specs.length = 0;
  });
  afterEach(async () => { await rm(testDir, { recursive: true, force: true }); });

  it("is the same for the same plugin loaded again, and another once its version or entry changes", async () => {
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: join(testDir, "plugins") });
    await runtime.startAll();
    await runtime.restartPlugin(PLUGIN_ID);
    expect(factory.specs).toHaveLength(2);
    const [first, again] = factory.specs.map(factory.identity);
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    // A consent given when the first load was refused has to fit the retry, which is a load of its own.
    expect(again).toBe(first);

    await writeManifest({ version: "1.0.1" });
    await runtime.restartPlugin(PLUGIN_ID);
    await writeManifest({ version: "1.0.1", entry: "other.mjs" });
    await runtime.restartPlugin(PLUGIN_ID);
    expect(factory.specs.map((spec) => spec.manifest.version)).toEqual(["1.0.0", "1.0.0", "1.0.1", "1.0.1"]);
    const identities = factory.specs.map(factory.identity);
    expect(new Set(identities).size).toBe(3);
    await runtime.stopAll();
  });
});
