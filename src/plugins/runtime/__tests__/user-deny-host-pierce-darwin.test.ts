/** The macOS counterpart of user-deny-host-pierce.test.ts, on the real package wrap: a plugin whose reviewed certs host
 * directory a user's read deny covers does not start and its card names the rule; another plugin started with it does. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLocale } from "../../../i18n/index.js";
import { aveHome } from "../../../shared/ave-home.js";
import { asrtCanInitialize } from "../../../permissions/__tests__/test-helpers.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox } from "../../../permissions/asrt-sandbox.js";
import { __resetSandboxRequestedAtBootForTest, setPluginWorkerConfinementRequestedAtBoot } from "../../../permissions/sandbox-capability.js";
import { makeTestPluginRuntime, servedAgentPluginsDocument } from "../../__tests__/test-helpers.js";
import type { PluginRuntime } from "../../runtime.js";
import type { PluginManifest } from "../../types.js";

const CERTS_PLUGIN = "certsreader";
const OTHER_PLUGIN = "plainreader";

describe.runIf(process.platform === "darwin")("a user's read deny over a plugin's certs host directory, through the runtime on macOS", () => {
  let testDir: string;
  let runtime: PluginRuntime | undefined;
  const certs = () => join(aveHome(), "certs");

  beforeEach(() => {
    setLocale("en");
    // Plugin children are wrapped only when plugin worker confinement was requested at boot.
    setPluginWorkerConfinementRequestedAtBoot(true);
    testDir = realpathSync(mkdtempSync(join(tmpdir(), "ave-user-deny-pierce-")));
    mkdirSync(certs(), { recursive: true });
  });

  afterEach(async () => {
    await runtime?.stopAll();
    runtime = undefined;
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    __resetSandboxRequestedAtBootForTest();
    await rm(testDir, { recursive: true, force: true });
  });

  async function installPlugin(id: string, tool: string, sandbox?: PluginManifest["sandbox"]): Promise<{ id: string; manifestPath: string; enabled: true }> {
    const pluginDir = join(testDir, "plugins", id);
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

  it("does not start the certs plugin, names the rule on its card, and starts the other plugin", async () => {
    if (!(await asrtCanInitialize())) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT sandbox cannot initialize");
      return;
    }
    const registryPath = join(testDir, "plugins", "registry.json");
    const rows = [
      await installPlugin(CERTS_PLUGIN, "certs_reader_ping", { read: [{ kind: "hostDirectory", segments: ["certs"], why: "Read trust anchors" }] }),
      await installPlugin(OTHER_PLUGIN, "plain_reader_ping"),
    ];
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: rows }), "utf-8");
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, denyRead: [certs()] });
    const started = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: join(testDir, "plugins") });
    runtime = started;
    await started.startAll();
    const card = (id: string) => started.listPluginCards().find((entry) => entry.id === id);
    expect(card(CERTS_PLUGIN)?.loadStatus).toBe("failed");
    // The pierce may be spelled through its real path; the rule is the user's own spelling.
    const message = card(CERTS_PLUGIN)?.installFailureMessage ?? "";
    expect(message).toContain(`Your read deny ${certs()} covers `);
    expect(message).toMatch(/, which this launch needs to read; the launch is refused \(user-deny-covers-pierce\)$/u);
    expect(started.listPluginIds()).not.toContain(CERTS_PLUGIN);
    expect(card(OTHER_PLUGIN)?.installFailureMessage).toBeUndefined();
    // The other plugin ran under the wrap, so the certs refusal was the wrap's own and not a skipped one.
    expect(card(OTHER_PLUGIN)?.confinement).toBe("macos-sandbox");
    await expect(started.call("plain_reader_ping")).resolves.toBe("pong");
  });

  it("starts the certs plugin under the wrap beside a deny inside its pierce", async () => {
    if (!(await asrtCanInitialize())) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT sandbox cannot initialize");
      return;
    }
    const corp = join(certs(), "corp");
    mkdirSync(corp, { recursive: true });
    const registryPath = join(testDir, "plugins", "registry.json");
    const rows = [await installPlugin(CERTS_PLUGIN, "certs_reader_ping", { read: [{ kind: "hostDirectory", segments: ["certs"], why: "Read trust anchors" }] })];
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: rows }), "utf-8");
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, denyRead: [corp] });
    const started = makeTestPluginRuntime({ rootDir: testDir, registryPath, pluginsRoot: join(testDir, "plugins") });
    runtime = started;
    await started.startAll();
    const card = started.listPluginCards().find((entry) => entry.id === CERTS_PLUGIN);
    // The pierce stays and only what the deny matches is withheld, so the launch is not refused.
    expect(card?.installFailureMessage).toBeUndefined();
    expect(card?.confinement).toBe("macos-sandbox");
    expect(started.listPluginIds()).toContain(CERTS_PLUGIN);
    await expect(started.call("certs_reader_ping")).resolves.toBe("pong");
  });
});
