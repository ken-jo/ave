/** The marketplace update restarts a plugin; on Windows under srt-win its child's host-side setup alone measured 8-10 s, so the
 * restart must run under the srt-win factory budget, not the 10 s fallback, and a start that hangs must still fail and quarantine. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestPluginRuntime, servedAgentPluginsDocument } from "../../__tests__/test-helpers.js";
import { TOOL_TIMEOUT_POLICY, windowsSrtPluginChildFactoryBudgetMs } from "../../../shared/tool-timeout-policy.js";
import type { PluginRuntime } from "../../runtime.js";

const confinement = vi.hoisted(() => ({ active: false }));
vi.mock("../../../permissions/asrt-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../permissions/asrt-sandbox.js")>(),
  isPluginWorkerConfinementActive: () => confinement.active,
}));

// A factory routed below is budgeted as a real sandboxed Windows child would be: the module's own answer for one it built, asked under
// win32 with confinement on. Any other factory gets the module's answer unchanged.
const routed = vi.hoisted(() => ({ factories: new WeakSet<object>(), budgeted: 0 }));
vi.mock("../../isolation/out-of-process-plugin.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../isolation/out-of-process-plugin.js")>();
  const srtWinChild = actual.createOutOfProcessPluginFactory({
    manifest: { id: "srt-budget", name: "n", version: "1.0.0", entry: "entry.mjs", description: "d", tools: [] },
    launch: { kind: "entry", entryPath: "entry.mjs" },
  });
  return {
    ...actual,
    pluginFactoryDeadlineMs: (factory: Parameters<typeof actual.pluginFactoryDeadlineMs>[0], fallbackMs: number) => {
      if (!routed.factories.has(factory)) return actual.pluginFactoryDeadlineMs(factory, fallbackMs);
      routed.budgeted += 1;
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { ...platform, value: "win32" });
      confinement.active = true;
      try {
        return actual.pluginFactoryDeadlineMs(srtWinChild, fallbackMs);
      } finally {
        confinement.active = false;
        Object.defineProperty(process, "platform", platform);
      }
    },
  };
});

const PLUGIN_ID = "srt-budget";
const SRT_WIN_BUDGET_MS = windowsSrtPluginChildFactoryBudgetMs();

/** Each construct takes `delayMs` on the host's (fake) clock, or never settles. */
const construct = { delayMs: 0 as number | "hang", started: 0, generation: 0 };

/** Route every lifecycle factory to one built here, after the runtime's own admission checks, so the test's clock governs it. */
function routeInHost(runtime: PluginRuntime): void {
  const routing = runtime as unknown as {
    importPluginFactoryForLifecycle(...args: unknown[]): Promise<{ createPlugin: unknown; arm: string }>;
  };
  const original = routing.importPluginFactoryForLifecycle.bind(routing);
  vi.spyOn(routing, "importPluginFactoryForLifecycle").mockImplementation(async (...args: unknown[]) => {
    await original(...args);
    const createPlugin = async () => {
      construct.started += 1;
      const { delayMs } = construct;
      if (delayMs === "hang") await new Promise(() => {});
      else await new Promise((resolve) => setTimeout(resolve, delayMs));
      const generation = ++construct.generation;
      return { handlers: { srt_budget_ping: async () => generation } };
    };
    routed.factories.add(createPlugin);
    return { arm: "child", createPlugin };
  });
}

describe("an update's restart under the srt-win factory budget", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    Object.assign(construct, { delayMs: 0, started: 0, generation: 0 });
    routed.budgeted = 0;
    testDir = mkdtempSync(join(tmpdir(), "ave-srt-budget-"));
    installedDir = join(testDir, "plugins");
    registryPath = join(installedDir, "registry.json");
    const pluginDir = join(installedDir, PLUGIN_ID);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "entry.mjs"), "export default async function createPlugin() { return { handlers: {} }; }", "utf-8");
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(servedAgentPluginsDocument({
      id: PLUGIN_ID, name: "Srt Budget", version: "1.0.0", entry: "entry.mjs",
      tools: [{ name: "srt_budget_ping", description: "srt-win budget regression tool", inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model", "app"] } } }],
      description: "srt-win factory budget regression.",
    })), "utf-8");
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [{ id: PLUGIN_ID, manifestPath, enabled: true }] }), "utf-8");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  async function startedRuntime(): Promise<PluginRuntime> {
    const runtime = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: installedDir });
    routeInHost(runtime);
    await runtime.startAll();
    await expect(runtime.call("srt_budget_ping")).resolves.toBe(1);
    return runtime;
  }

  /** Restart with fake timers, once the replacement's construct has begun (and so its deadline is armed). */
  async function restartUnderClock(runtime: PluginRuntime): Promise<{ restart: Promise<unknown>; settled: () => boolean }> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const restart = runtime.restartPlugin(PLUGIN_ID);
    let done = false;
    void restart.then(() => { done = true; }, () => { done = true; });
    await vi.waitFor(() => expect(construct.started).toBe(2), { interval: 1 });
    return { restart, settled: () => done };
  }

  it("restarts a healthy plugin whose construct outlasts the 10 s fallback", async () => {
    const runtime = await startedRuntime();
    construct.delayMs = TOOL_TIMEOUT_POLICY.pluginFactoryMs + 2_000;
    const { restart } = await restartUnderClock(runtime);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.pluginFactoryMs + 2_500);
    await expect(restart).resolves.toBe("started");
    await expect(runtime.call("srt_budget_ping")).resolves.toBe(2);
    // Boot and the restart each asked the deadline for the factory the lifecycle routed.
    expect(routed.budgeted).toBe(2);
    expect(runtime.listPluginCards().find((card) => card.id === PLUGIN_ID)?.lifecycleQuarantined).toBeUndefined();
  });

  it("still fails a construct that hangs, at the budget, and quarantines it", async () => {
    const runtime = await startedRuntime();
    construct.delayMs = "hang";
    const { restart, settled } = await restartUnderClock(runtime);
    await vi.advanceTimersByTimeAsync(SRT_WIN_BUDGET_MS - 1_000);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(restart).resolves.toBe("failed");
    await expect(runtime.restartPlugin(PLUGIN_ID)).rejects.toMatchObject({ code: "plugin-lifecycle-quarantined" });
  });
});
