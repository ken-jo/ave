/**
 * Marketplace update hook regression tests.
 *
 * Update skips are exact-version suppressions. A user skip must hide the
 * visible pill immediately, persist `name -> offered version` (a plugin's name,
 * `kind:name` for other kinds), and allow a newer version to surface again.
 */
import "../../../../../test/renderer/setup.js";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMarketplaceUpdates } from "../use-marketplace-updates.js";
import type { PackageKind, PackageUpdateView } from "../../../../shared/git-marketplace.js";
import type { AppSettings, DeepPartial, AveApi, SettingsUpdateResult } from "../../types.js";

function marketplaceUpdatesApi(options: {
  settings?: DeepPartial<AppSettings>;
  updateSettings?: (patch: DeepPartial<AppSettings>) => Promise<SettingsUpdateResult>;
} = {}) {
  let handler: ((updates: PackageUpdateView[]) => void) | null = null;
  const api = {
    getSettings: vi.fn(async () => options.settings ?? {}),
    updateSettings: vi.fn(
      options.updateSettings ??
        (async (patch: DeepPartial<AppSettings>) =>
          ({ ...(options.settings ?? {}), ...patch }) as SettingsUpdateResult),
    ),
    onMarketplaceUpdatesAvailable: vi.fn((h: (updates: PackageUpdateView[]) => void) => {
      handler = h;
      return () => {
        handler = null;
      };
    }),
  };
  return {
    api: api as unknown as AveApi,
    rawApi: api,
    emit: (updates: PackageUpdateView[]) => {
      if (!handler) throw new Error("marketplace updates handler not registered");
      handler(updates);
    },
  };
}

describe("useMarketplaceUpdates", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exposes incoming marketplace updates", async () => {
    const { api, rawApi, emit } = marketplaceUpdatesApi();
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await waitFor(() => expect(rawApi.onMarketplaceUpdatesAvailable).toHaveBeenCalledOnce());
    act(() => {
      emit([update("meeting", "0.5.24")]);
    });

    expect(result.current.updates).toEqual([update("meeting", "0.5.24")]);
  });

  it("skip hides visible updates and persists exact latest versions", async () => {
    const { api, rawApi, emit } = marketplaceUpdatesApi({
      settings: {
        marketplace: { skippedPluginUpdates: { meeting: "0.5.23" } },
      },
    });
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update(" meeting ", " 0.5.24 ")]);
    });

    await act(async () => {
      await result.current.skip();
    });

    expect(result.current.updates).toEqual([]);
    expect(rawApi.updateSettings).toHaveBeenCalledWith({
      marketplace: { skippedPluginUpdates: { meeting: "0.5.24" } },
    });
  });

  it("stores a non-plugin skip under its kind, so a plugin of the same name still shows", async () => {
    const { api, rawApi, emit } = marketplaceUpdatesApi();
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update("meeting", "2.0.0", "skill")]);
    });
    await act(async () => {
      await result.current.skip();
    });

    expect(rawApi.updateSettings).toHaveBeenCalledWith({
      marketplace: { skippedPluginUpdates: { "skill:meeting": "2.0.0" } },
    });
    act(() => {
      emit([update("meeting", "2.0.0", "skill"), update("meeting", "2.0.0")]);
    });
    expect(result.current.updates).toEqual([update("meeting", "2.0.0")]);
  });

  it("keeps skip persistence best-effort when settings writes fail", async () => {
    const { api, emit } = marketplaceUpdatesApi({
      updateSettings: async () => {
        throw new Error("settings unavailable");
      },
    });
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update("meeting", "0.5.24")]);
    });

    await expect(
      act(async () => {
        await result.current.skip();
      }),
    ).resolves.toBeUndefined();

    expect(result.current.updates).toEqual([update("meeting", "0.5.24")]);
  });

  it("filters skipped versions but allows newer plugin updates", async () => {
    const { api, emit } = marketplaceUpdatesApi({
      settings: {
        marketplace: { skippedPluginUpdates: { meeting: "0.5.24" } },
      },
    });
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update("meeting", "0.5.24"), update("agent-hub", "1.0.0")]);
    });

    expect(result.current.updates).toEqual([update("agent-hub", "1.0.0")]);

    act(() => {
      emit([update("meeting", "0.5.25")]);
    });

    expect(result.current.updates).toEqual([update("meeting", "0.5.25")]);
  });

  it("normalizes incoming update fields before filtering skipped versions", async () => {
    const { api, emit } = marketplaceUpdatesApi({
      settings: {
        marketplace: { skippedPluginUpdates: { meeting: "0.5.24" } },
      },
    });
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update(" meeting ", " 0.5.24 "), update("meeting", "0.5.25")]);
    });

    expect(result.current.updates).toEqual([update("meeting", "0.5.25")]);
  });

  it("ignores reserved skipped-update keys from settings", async () => {
    const skippedPluginUpdates = Object.create(null) as Record<string, string>;
    skippedPluginUpdates.meeting = "0.5.24";
    defineSkippedSetting(skippedPluginUpdates, "__proto__", "1.0.0");
    defineSkippedSetting(skippedPluginUpdates, "constructor", "1.0.0");
    defineSkippedSetting(skippedPluginUpdates, "prototype", "1.0.0");
    const { api, emit } = marketplaceUpdatesApi({
      settings: {
        marketplace: { skippedPluginUpdates },
      },
    });
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([
        update("meeting", "0.5.24"),
        update("__proto__", "1.0.0"),
        update("constructor", "1.0.0"),
        update("prototype", "1.0.0"),
      ]);
    });

    expect(result.current.updates).toEqual([
      update("__proto__", "1.0.0"),
      update("constructor", "1.0.0"),
      update("prototype", "1.0.0"),
    ]);
  });

  it("does not persist reserved plugin ids when skipping visible updates", async () => {
    const { api, rawApi, emit } = marketplaceUpdatesApi();
    const { result } = renderHook(() => useMarketplaceUpdates(api));

    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      emit([update("__proto__", "1.0.0"), update("meeting", "0.5.24")]);
    });

    await act(async () => {
      await result.current.skip();
    });

    expect(rawApi.updateSettings).toHaveBeenCalledWith({
      marketplace: { skippedPluginUpdates: { meeting: "0.5.24" } },
    });
  });
});

function update(name: string, to: string, kind: PackageKind = "plugin"): PackageUpdateView {
  return { key: { sourceId: "ave", kind, name }, displayName: `Ave ${name}`, from: "1.0.0", to, state: "manual" };
}

function defineSkippedSetting(
  target: Record<string, string>,
  pluginId: string,
  latestVersion: string,
): void {
  Object.defineProperty(target, pluginId, {
    value: latestVersion,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

describe("required updates (§18.7.2)", () => {
  it("shows a required escalation main sent although its version is skipped, on every mount", async () => {
    const { api, emit } = marketplaceUpdatesApi({ settings: { marketplace: { skippedPluginUpdates: { meeting: "2.0.0" } } } });
    const notice: PackageUpdateView = { ...update("meeting", "2.0.0"), state: "waiting", escalated: true, required: true };
    const observed: PackageUpdateView[][] = [];
    for (let mount = 0; mount < 2; mount += 1) {
      const rendered = renderHook(() => useMarketplaceUpdates(api));
      await act(async () => {
        await Promise.resolve();
      });
      act(() => emit([notice]));
      observed.push(rendered.result.current.updates);
      rendered.unmount();
    }
    expect(observed).toEqual([[notice], [notice]]);
  });

  it("records no skipped version for a required update, and keeps showing it", async () => {
    const { api, rawApi, emit } = marketplaceUpdatesApi({ settings: { marketplace: {} } });
    const required: PackageUpdateView = { ...update("meeting", "2.0.0"), state: "waiting", escalated: true, required: true };
    const ordinary = update("notes", "3.0.0", "skill");
    const { result } = renderHook(() => useMarketplaceUpdates(api));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => emit([required, ordinary]));
    await act(async () => {
      await result.current.skip();
    });
    expect(rawApi.updateSettings).toHaveBeenCalledExactlyOnceWith({ marketplace: { skippedPluginUpdates: { "skill:notes": "3.0.0" } } });
    expect(result.current.updates).toEqual([required]);
  });
});
