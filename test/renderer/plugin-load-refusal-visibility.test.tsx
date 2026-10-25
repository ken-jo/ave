// Every boot refusal needs a visible, distinct repair path even though the package remains installed.
import "./setup.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { openSidebarGroup } from "./helpers.js";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeTestPluginRuntime,
  makeTestTreeWritable,
} from "../../src/plugins/__tests__/test-helpers.js";
import {
  buildInstallReceipt,
  writeInstallReceipt,
} from "../../src/plugins/plugin-install-receipt.js";
import type { PluginCardSummary } from "../../src/ui/renderer/types.js";
import { renderApp } from "./render-app.js";
import { sidebarViewTestId } from "../../src/ui/renderer/components/Sidebar.js";
import { toPluginDoctorViewKey, toPluginSettingsViewKey } from "../../src/ui/renderer/utils/plugin-doctor-view.js";
import { servedAgentPluginsDocument } from "../../src/plugins/__tests__/test-helpers.js";

const STRAY_REGISTRY_PLUGIN = "stray-registry-plugin";
const SWITCHED_OFF_PLUGIN = "switched-off-plugin";
const CRASHING_PLUGIN = "crashing-plugin";

describe("installed plugins boot refuses to run", () => {
  let testDir: string;
  let pluginsRoot: string;
  let registryPath: string;
  let strayManifestPath: string;

  async function writePlugin(id: string): Promise<string> {
    const pluginDir = join(pluginsRoot, id);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      "export default async () => ({ handlers: {}, start: async () => {}, stop: async () => {} });\n",
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id,
        name: `Plugin ${id}`,
        version: "1.0.0",
        description: `${id} fixture`,
        entry: "entry.mjs",
        tools: [],
        ui: [{ id: `${id}-panel`, slot: "sidebar", kind: "info-card", title: `Panel ${id}` }],
      })),
      "utf-8");
    const { receipt } = await buildInstallReceipt(pluginDir, {
      pluginId: id,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "prod-v1",
      files: ["entry.mjs", "plugin.json"],
      installedAt: new Date(0).toISOString(),
    });
    await writeInstallReceipt(testDir, receipt);
    return manifestPath;
  }

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "ave-plugin-refusal-"));
    pluginsRoot = join(testDir, "plugins");
    registryPath = join(pluginsRoot, "registry.json");
    await mkdir(pluginsRoot, { recursive: true });

    // Use an existing outside-root manifest so containment, rather than absence, causes refusal.
    const strayDir = join(testDir, "outside-the-plugin-root");
    await mkdir(strayDir, { recursive: true });
    strayManifestPath = join(strayDir, "plugin.json");
    await writeFile(
      strayManifestPath,
      JSON.stringify(servedAgentPluginsDocument({
        id: STRAY_REGISTRY_PLUGIN,
        name: "Stray Registry Plugin",
        version: "1.0.0",
        description: "must never be read",
        entry: "entry.mjs",
        tools: [],
      })),
      "utf-8");

    const switchedOffManifest = await writePlugin(SWITCHED_OFF_PLUGIN);
    const crashingManifest = await writePlugin(CRASHING_PLUGIN);

    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: STRAY_REGISTRY_PLUGIN, manifestPath: strayManifestPath, enabled: true },
          { id: SWITCHED_OFF_PLUGIN, manifestPath: switchedOffManifest, enabled: false },
          { id: CRASHING_PLUGIN, manifestPath: crashingManifest, enabled: true },
        ],
      }),
      "utf-8",
    );
  });

  afterEach(async () => {
    await makeTestTreeWritable(testDir);
    await rm(testDir, { recursive: true, force: true });
  });

  async function loadCards(): Promise<PluginCardSummary[]> {
    const runtime = makeTestPluginRuntime(
      { rootDir: testDir, registryPath, pluginsRoot },
      { installReceiptCacheRoot: testDir },
    );
    // Materialization throws must reach the per-plugin failure boundary.
    const internals = runtime as unknown as {
      materializeImmutableRuntimeRoot(
        pluginId: string,
        pluginRoot: string,
        activationId: string,
        installId: string,
      ): Promise<string>;
    };
    const materialize = internals.materializeImmutableRuntimeRoot.bind(runtime);
    internals.materializeImmutableRuntimeRoot = async (pluginId, ...rest) => {
      if (pluginId === CRASHING_PLUGIN) {
        throw new Error("ENOSPC: no space left on device, mkdir runtime root");
      }
      return materialize(pluginId, ...rest);
    };
    await runtime.load();
    return runtime.listPluginCards() as PluginCardSummary[];
  }

  it("gives every refused plugin its own card and its own reason", async () => {
    const cards = await loadCards();

    const stray = cards.find((card) => card.id === STRAY_REGISTRY_PLUGIN);
    expect(stray?.loadStatus).toBe("failed");
    expect(stray?.installFailureKind).toBe("untrusted-manifest-path");
    expect(stray?.installFailureMessage).toContain("not inside the plugin root");

    const crashed = cards.find((card) => card.id === CRASHING_PLUGIN);
    expect(crashed?.loadStatus).toBe("failed");
    expect(crashed?.installFailureKind).toBe("load-crash");
    expect(crashed?.installFailureMessage).toContain("no space left on device");

    // User-disabled plugins are inactive choices rather than load failures.
    const switchedOff = cards.find((card) => card.id === SWITCHED_OFF_PLUGIN);
    expect(switchedOff?.loadStatus).toBe("disabled");
    expect(switchedOff?.installFailureKind).toBeUndefined();
    expect(switchedOff?.installFailureMessage).toBeUndefined();
  });

  it("renders a sidebar row for each of them, telling repair apart from off", async () => {
    const cards = await loadCards();
    await renderApp({ pluginCards: cards });
    await openSidebarGroup("plugins");

    await waitFor(() =>
      expect(screen.getByTestId(sidebarViewTestId(toPluginDoctorViewKey(STRAY_REGISTRY_PLUGIN)))).toBeTruthy(),
    );
    expect(screen.getByTestId(sidebarViewTestId(toPluginDoctorViewKey(CRASHING_PLUGIN)))).toBeTruthy();

    // Disabled plugins route to settings with neutral status, not a fault-repair surface.
    const inactiveRow = screen.getByTestId(sidebarViewTestId(toPluginSettingsViewKey(SWITCHED_OFF_PLUGIN)));
    expect(inactiveRow.getAttribute("data-viewkey")).toBe(`plugin-settings:${SWITCHED_OFF_PLUGIN}`);
    expect(screen.queryByTestId(sidebarViewTestId(toPluginDoctorViewKey(SWITCHED_OFF_PLUGIN)))).toBeNull();
    expect(inactiveRow.textContent).toContain("꺼짐");
    expect(inactiveRow.textContent).not.toContain("Doctor");
  });

  it("explains the two refusals differently in the Plugin Doctor panel", async () => {
    const cards = await loadCards();
    const { PluginConfigTab } = await import("../../src/ui/renderer/tabs/PluginConfigTab.js");
    Object.defineProperty(window, "ave", {
      value: { plugins: { cards: async () => cards } },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    (await screen.findByTestId(`plugin-config:row:${STRAY_REGISTRY_PLUGIN}`)).click();
    await waitFor(() =>
      expect(screen.getByText("익스텐션 레지스트리 항목 거부됨")).toBeTruthy(),
    );

    (await screen.findByTestId(`plugin-config:row:${CRASHING_PLUGIN}`)).click();
    await waitFor(() =>
      expect(screen.getByText("익스텐션 로드 중 오류 발생")).toBeTruthy(),
    );
    // Distinct refusal reasons need distinct guidance rather than one generic failure.
    expect(screen.queryByText("익스텐션 레지스트리 항목 거부됨")).toBeNull();
  });
});
