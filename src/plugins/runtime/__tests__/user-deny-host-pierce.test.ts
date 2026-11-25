/** End to end through the runtime, the real out-of-process factory and envelope, and the real container admission and rank:
 * a plugin whose reviewed certs host directory a user's read deny covers does not start, and another plugin started with it does. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { configureHostResources } from "../../../main/host-resources.js";
import { setLocale } from "../../../i18n/index.js";
import { aveHome } from "../../../shared/ave-home.js";
import { makeTestPluginRuntime, servedAgentPluginsDocument } from "../../__tests__/test-helpers.js";
import { nativePluginLaunch } from "../../../__tests__/support/mxc-plugin-launch.js";
import { mxcStagingParentFor } from "../../../__tests__/support/mxc-staging-parent.js";
import { consumePluginChildInput } from "../../../__tests__/support/plugin-child-input.js";
import { servePluginChild } from "../../isolation/plugin-child-main.js";
import { createOutOfProcessPluginFactory } from "../../isolation/out-of-process-plugin.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../../../permissions/asrt-sandbox.js";
import type { MxcConfinedChildSpec } from "../../../permissions/confined-child.js";
import type { PluginRuntime } from "../../runtime.js";
import type { PluginManifest } from "../../types.js";

beforeAll(() => configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false }));
afterAll(async () => { await rm(stagingParent(), { recursive: true, force: true }); });

vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: {
  setParentProxyRouter: () => undefined,
  initialize: async () => undefined,
  updateConfig: () => undefined,
  getConfig: () => undefined,
  reset: async () => undefined,
  cleanupAfterCommand: () => undefined,
  openInvocationListener: async () => ({ socketPath: "/configured/proxy.sock" }),
  closeInvocationListener: () => undefined,
} }));
vi.mock("../../../permissions/mxc-runtime-root.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permissions/mxc-runtime-root.js")>(),
  mxcStagingParent: (await import("../../../__tests__/support/mxc-staging-parent.js")).mxcStagingParentFor(),
}));
vi.mock("../../../permissions/workspace-authorized-roots.js", () => ({ listAuthorizedWorkspaceRoots: () => [] }));

const spawnNativeChild = vi.hoisted(() => vi.fn());
const rankedDenies = vi.hoisted(() => [] as string[][]);
// The container spawn's own admission and rank, on the spec the factory hands it; only the native process is the test's.
vi.mock("../../../permissions/confined-child.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permissions/confined-child.js")>(),
  spawnMxcConfinedChild: async (spec: MxcConfinedChildSpec) => {
    const sandbox = await import("../../../permissions/asrt-sandbox.js");
    const { rankMxcFilesystem } = await import("../../../permissions/mxc-windows.js");
    const { admittedMxcChild } = await import("../../../__tests__/support/mxc-plugin-launch.js");
    const ranked = rankMxcFilesystem(sandbox.admitMxcExtensionFilesystem({
      allowRead: [...spec.allowRead ?? []], allowWrite: [...spec.allowWrite ?? []], denyWrite: sandbox.getDefaultSensitiveWriteDenyEntries(),
      floorPierces: spec.floorPierces, denyPluginsRoot: true, pinWriteRoots: true,
    }, spec.filesystemOwnership).model);
    rankedDenies.push([...ranked.denied]);
    return admittedMxcChild(await spawnNativeChild(spec));
  },
  spawnConfinedChild: () => { throw new Error("account route reached"); },
}));

const runtimeErrors = vi.hoisted(() => [] as string[]);
const warnings = vi.hoisted(() => [] as string[]);
vi.mock("../../../lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/logger.js")>();
  return {
    ...actual,
    createLogger: (name: string) => {
      const logger = actual.createLogger(name);
      if (name === "out-of-process-plugin" || name === "asrt-sandbox") {
        return Object.assign(Object.create(logger) as typeof logger, { warn: (...args: unknown[]) => void warnings.push(args.map(String).join(" ")) });
      }
      if (name !== "plugin-runtime" && name !== "plugin-lifecycle") return logger;
      const spelled = (arg: unknown): string => arg instanceof Error ? arg.message
        : typeof arg === "object" && arg !== null ? Object.values(arg).map(spelled).join(" ") : String(arg);
      return Object.assign(Object.create(logger) as typeof logger, {
        error: (...args: unknown[]) => void runtimeErrors.push(args.map(spelled).join(" ")),
      });
    },
  };
});

const CERTS_PLUGIN = "certsreader";
const OTHER_PLUGIN = "plainreader";
const stagingParent = mxcStagingParentFor();
const hostPlatform = process.platform;

function ownedChild() {
  const hostToChild = new PassThrough(), childToHost = new PassThrough();
  const service = servePluginChild(consumePluginChildInput(hostToChild, childToHost), childToHost);
  let finish!: (result: { exitCode: number; timedOut: boolean }) => void;
  const completion = new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => { finish = resolve; });
  hostToChild.once("end", () => { service.hostGone(); finish({ exitCode: 0, timedOut: false }); });
  return { id: 4242, stdin: hostToChild, stdout: childToHost, stderr: new PassThrough(), completion,
    dispose: vi.fn(async () => { service.hostGone(); }),
    diagnostics: { nodeVersion: "", nativeModules: [], nativeModuleCount: 0, nativeModulesTruncated: false, ownerHandle: "" } };
}

/** Route every lifecycle factory through the native arm, after the runtime's own admission checks. */
function routeNative(runtime: PluginRuntime): void {
  const routing = runtime as unknown as {
    importPluginFactoryForLifecycle(...args: unknown[]): Promise<{ createPlugin: unknown; arm: string }>;
    registerSandboxEnvelope(pluginId: string, paths: readonly string[], pluginRoot: string, pluginDataDir: string): never;
  };
  const original = routing.importPluginFactoryForLifecycle.bind(routing);
  vi.spyOn(routing, "importPluginFactoryForLifecycle").mockImplementation(async (...args: unknown[]) => {
    await original(...args);
    const [, source, manifest] = args as [string, { resolvedEntryPath: string }, PluginManifest];
    const createPlugin = createOutOfProcessPluginFactory({
      manifest,
      launch: { kind: "entry", entryPath: source.resolvedEntryPath },
      registerSandboxEnvelope: (paths, pluginRoot, pluginDataDir) => routing.registerSandboxEnvelope(manifest.id, paths, pluginRoot, pluginDataDir),
      // The production launch's ownership: the envelope's writes beside the synthetic staging root.
      prepareMxcChild: async (intent) => {
        const launch = nativePluginLaunch({}, stagingParent());
        for (const directory of [launch.home, launch.temp]) mkdirSync(directory, { recursive: true });
        return { ...launch, filesystemOwnership: { ...launch.filesystemOwnership, readRoots: [intent.cwd],
          writeRoots: [...intent.envelope.write, ...launch.filesystemOwnership.writeRoots] } };
      },
    });
    return { arm: "child", createPlugin };
  });
}

describe.runIf(hostPlatform === "win32")("a user's read deny over a plugin's certs host directory, through the runtime", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;
  const certs = () => join(aveHome(), "certs");

  beforeEach(() => {
    setLocale("en");
    runtimeErrors.length = 0;
    warnings.length = 0;
    rankedDenies.length = 0;
    testDir = mkdtempSync(join(tmpdir(), "ave-user-deny-pierce-"));
    installedDir = join(testDir, "plugins");
    registryPath = join(installedDir, "registry.json");
    mkdirSync(certs(), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetAsrtSandbox();
    await rm(testDir, { recursive: true, force: true });
  });

  async function installPlugin(id: string, tool: string, sandbox?: PluginManifest["sandbox"]): Promise<{ id: string; manifestPath: string; enabled: true }> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "entry.mjs"), `export default async function createPlugin() {
  return { handlers: { ${tool}: async () => "pong" } };
}`, "utf-8");
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedAgentPluginsDocument({
      id, name: id, version: "1.0.0", entry: "entry.mjs",
      tools: [{ name: tool, description: `${id} ping tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      description: `${id} fixture.`,
      ...(sandbox === undefined ? {} : { sandbox }),
    })), "utf-8");
    return { id, manifestPath, enabled: true };
  }

  it("does not start the certs plugin, names the rule, and starts the other plugin", async () => {
    const rows = [
      await installPlugin(CERTS_PLUGIN, "certs_reader_ping", { read: [{ kind: "hostDirectory", segments: ["certs"], why: "Read trust anchors" }] }),
      await installPlugin(OTHER_PLUGIN, "plain_reader_ping"),
    ];
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: rows }), "utf-8");
    // The container session: Windows children are confined by containers, and the wrap runtime stays unloaded.
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, denyRead: [certs()], windows: { externalConfinement: true } });
    spawnNativeChild.mockReset().mockImplementation(async () => ownedChild());
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    routeNative(runtime);
    await runtime.startAll();
    try {
      const card = (id: string) => runtime.listPluginCards().find((entry) => entry.id === id);
      expect(card(CERTS_PLUGIN)?.loadStatus).toBe("failed");
      // The card carries the refusal, rule named, not only the lifecycle log.
      expect(card(CERTS_PLUGIN)?.installFailureMessage).toBe(
        `Your read deny ${certs()} covers ${certs()}, which this launch needs to read; the launch is refused (user-deny-covers-pierce)`);
      expect(card(OTHER_PLUGIN)?.installFailureMessage).toBeUndefined();
      expect(runtime.listPluginIds()).not.toContain(CERTS_PLUGIN);
      expect(runtimeErrors.filter((line) => line.includes(CERTS_PLUGIN))).toEqual([
        expect.stringContaining(`Your read deny ${certs()} covers ${certs()}, which this launch needs to read; the launch is refused`),
      ]);
      expect(runtimeErrors.filter((line) => line.includes(OTHER_PLUGIN))).toEqual([]);
      expect(runtime.listPluginIds()).toContain(OTHER_PLUGIN);
      await expect(runtime.call("plain_reader_ping")).resolves.toBe("pong");
      // The refused plugin never reached its native process.
      expect(spawnNativeChild).toHaveBeenCalledOnce();
    } finally {
      await runtime.stopAll();
    }
  });

  it("starts the certs plugin beside a deny inside its pierce, withholds the match, and names the rule once", async () => {
    const corp = join(certs(), "corp");
    mkdirSync(corp, { recursive: true });
    const rows = [await installPlugin(CERTS_PLUGIN, "certs_reader_ping", { read: [{ kind: "hostDirectory", segments: ["certs"], why: "Read trust anchors" }] })];
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: rows }), "utf-8");
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, denyRead: [corp], windows: { externalConfinement: true } });
    spawnNativeChild.mockReset().mockImplementation(async () => ownedChild());
    const notice = `[${CERTS_PLUGIN}] Your read deny ${corp} applies inside ${certs()}, which this launch reads; the launch keeps the rest of it and cannot read what the deny matches.`;
    for (let launch = 0; launch < 2; launch++) {
      const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
      routeNative(runtime);
      await runtime.startAll();
      try {
        expect(runtime.listPluginIds()).toContain(CERTS_PLUGIN);
        await expect(runtime.call("certs_reader_ping")).resolves.toBe("pong");
      } finally {
        await runtime.stopAll();
      }
    }
    expect(rankedDenies).toHaveLength(2);
    for (const denied of rankedDenies) expect(denied).toContain(corp);
    // Named against the plugin on its first launch only; the container admission stays silent on a rule already named.
    expect(warnings.filter((line) => line.includes(corp))).toEqual([notice]);
    expect(runtimeErrors).toEqual([]);
  });
});
