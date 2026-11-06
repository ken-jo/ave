import { describe, expect, it, vi } from "vitest";
import { emitEvent } from "../../types.js";
import { prepareDesktopRelease } from "../desktop-release.js";
import type { ReleasePrepInput } from "../post-boot.js";

const { track } = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("electron", () => ({ app: { getPath: () => "unused", getVersion: () => "1.0.0", isPackaged: false } }));
vi.mock("../../../main/auto-updater.js", () => ({ createAutoUpdater: () => ({ start: vi.fn(), stop: vi.fn() }) }));
vi.mock("../../../main/app-state.js", () => ({ getMainWindow: vi.fn(), getMainWindows: vi.fn() }));
vi.mock("../../../main/crash-reporter.js", () => ({ startCrashReporter: vi.fn() }));
vi.mock("../../../main/telemetry.js", () => ({ TelemetryService: class { start() {} track() {} } }));
vi.mock("../../../telemetry/client.js", () => ({ PluginTelemetryClient: class { start() {} track = track; } }));
vi.mock("../../../main/storage/feature-namespace.js", () => ({ openFeatureNamespace: () => ({ dir: "unused" }) }));
vi.mock("../../../main/app-shutdown.js", () => ({ registerShutdownHook: vi.fn() }));
vi.mock("../service-endpoint.js", () => ({ consentedTelemetryEndpoint: vi.fn() }));

describe("prepareDesktopRelease", () => {
  it("tracks emitted plugin installation and removal events", () => {
    const release = prepareDesktopRelease({
      mainWindow: {},
      settingsService: { get: () => ({ enabled: true, telemetryPromptAnswered: true }) },
      discretionaryEgress: true,
    } as unknown as ReleasePrepInput);
    expect(release.pluginTelemetry).toBeDefined();
    emitEvent("plugin.installed", { pluginId: "sample-plugin", version: "1.2.3" });
    emitEvent("plugin.uninstalled", { pluginId: "sample-plugin", version: "1.2.3" });
    expect(track.mock.calls).toEqual([
      ["plugin_install", { slug: "sample-plugin", version: "1.2.3" }],
      ["plugin_uninstall", { slug: "sample-plugin", version: "1.2.3" }],
    ]);
  });
});
