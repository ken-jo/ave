import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitEvent } from "../../types.js";
import { prepareDesktopRelease } from "../desktop-release.js";
import type { ReleasePrepInput } from "../post-boot.js";

const { track, crashUpdate, usageChanged, pluginChanged, hooks } = vi.hoisted(() => ({ track: vi.fn(), crashUpdate: vi.fn(), usageChanged: vi.fn(), pluginChanged: vi.fn(), hooks: new Map<string, () => void>() }));
vi.mock("electron", () => ({ app: { getPath: () => "unused", getVersion: () => "1.0.0", isPackaged: false } }));
vi.mock("../../../main/auto-updater.js", () => ({ createAutoUpdater: () => ({ start: vi.fn(), stop: vi.fn() }) }));
vi.mock("../../../main/app-state.js", () => ({ getMainWindow: vi.fn(), getMainWindows: vi.fn() }));
vi.mock("../../../main/crash-reporter.js", () => ({ startCrashReporter: vi.fn(() => ({ updateSettings: crashUpdate })) }));
vi.mock("../../../main/telemetry.js", () => ({ TelemetryService: class { start() {} track() {} settingsChanged = usageChanged; } }));
vi.mock("../../../telemetry/client.js", () => ({ PluginTelemetryClient: class { start() {} track = track; settingsChanged = pluginChanged; } }));
vi.mock("../../../main/storage/feature-namespace.js", () => ({ openFeatureNamespace: () => ({ dir: "unused" }) }));
vi.mock("../../../main/app-shutdown.js", () => ({ registerShutdownHook: (name: string, handler: () => void) => hooks.set(name, handler) }));
vi.mock("../service-endpoint.js", () => ({ consentedTelemetryEndpoint: vi.fn() }));

describe("prepareDesktopRelease", () => {
  beforeEach(() => { vi.clearAllMocks(); hooks.clear(); });
  afterEach(() => { for (const [name, close] of hooks) if (name.includes("listener")) close(); });
  it("applies consent withdrawal to all uploaders immediately", () => {
    let changed!: () => void;
    const settings = { enabled: false, level: "off" as const, crashReportingEnabled: false };
    prepareDesktopRelease({ mainWindow: {}, settingsService: { get: () => settings, onChanged: (_key: string, listener: () => void) => { changed = listener; return vi.fn(); } }, discretionaryEgress: true } as unknown as ReleasePrepInput);
    changed();
    expect(crashUpdate).toHaveBeenCalledWith(settings);
    expect(usageChanged).toHaveBeenCalled();
    expect(pluginChanged).toHaveBeenCalled();
  });
  it("tracks emitted plugin installation and removal events", () => {
    const release = prepareDesktopRelease({
      mainWindow: {},
      settingsService: { get: () => ({ enabled: true, telemetryPromptAnswered: true }), onChanged: vi.fn(() => vi.fn()) },
      discretionaryEgress: true,
    } as unknown as ReleasePrepInput);
    expect(release.pluginTelemetry).toBeDefined();
    emitEvent("plugin.installed", { pluginId: "sample-plugin", version: "1.2.3" });
    emitEvent("plugin.uninstalled", { pluginId: "sample-plugin", version: "1.2.3" });
    emitEvent("plugin.lifecycle.failed", { pluginId: "sample-plugin", version: "1.2.3", errorClass: "PluginRuntimeError" });
    expect(track.mock.calls).toEqual([
      ["plugin_install", { slug: "sample-plugin", version: "1.2.3" }],
      ["plugin_uninstall", { slug: "sample-plugin", version: "1.2.3" }],
      ["plugin_error", { slug: "sample-plugin", version: "1.2.3", errorClass: "PluginRuntimeError" }],
    ]);
  });
});
