import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

import { useInputStatusRow } from "../use-input-status-row.js";
import { t } from "../../../../i18n/runtime.js";
import { fakeAppSettings } from "../../../../../test/renderer/fake-app-settings.js";
import type { AppSettings, AveApi } from "../../types.js";

function apiWith(settings: AppSettings) {
  return {
    getSettings: vi.fn().mockResolvedValue(settings),
    onSettingsUpdated: vi.fn(() => () => {}),
  } as unknown as AveApi;
}

describe("useInputStatusRow", () => {
  it("names no model when main reports no connected provider", async () => {
    // A stored openai id (from an earlier sign-in) must not be presented as the model chat is on.
    const settings = fakeAppSettings({
      llm: { vendors: { openai: { model: "gpt-5.4" } } },
      activeChatModel: { kind: "none", reason: "no-connected-provider" },
    });
    expect(settings.llm.vendors.openai?.model).toBeTruthy();
    const { result } = renderHook(() => useInputStatusRow(apiWith(settings)));
    await waitFor(() => expect(result.current.activeChatModel).toEqual({
      kind: "none",
      reason: "no-connected-provider",
    }));
    expect(result.current.vendorModel).toBe("");
  });

  it("names the vendor and model when one is active (control)", async () => {
    const settings = fakeAppSettings({ llm: { provider: "openai", vendors: { openai: { model: "gpt-5.4" } } } });
    const { result } = renderHook(() => useInputStatusRow(apiWith(settings)));
    await waitFor(() => expect(result.current.vendorModel).toBe("OpenAI · gpt-5.4"));
    expect(result.current.activeChatModel).toMatchObject({ kind: "api", vendor: "openai", model: "gpt-5.4" });
  });

  it("refreshes shell capability from the host after settings broadcasts", async () => {
    const settings = fakeAppSettings();
    const inactive = {
      platform: "darwin", enabled: true, available: true, kind: "full", reason: "",
      runtime: { available: false, kind: "none", reason: "" },
      confines: { filesystem: true, process: true, network: true },
    };
    const active = { ...inactive, runtime: { available: true, kind: "full", reason: "" } };
    const broadcasts: Array<() => void> = [];
    const unsubscribe = vi.fn();
    const api = apiWith(settings);
    api.permission = {
      getMode: vi.fn(async () => ({ mode: "strict" })),
      recentlyDeniedList: vi.fn(async () => ({ ok: true, entries: [] })),
      onRecentlyDeniedChanged: vi.fn(() => () => {}),
      sandboxCapability: vi.fn().mockResolvedValueOnce(inactive).mockResolvedValueOnce(active) } as unknown as AveApi["permission"];
    api.onSettingsUpdated = vi.fn((callback) => { broadcasts.push(() => callback(settings)); return unsubscribe; });
    const { result, unmount } = renderHook(() => useInputStatusRow(api));
    await waitFor(() => expect(result.current.sandboxCapability).toEqual(inactive));
    act(() => broadcasts.forEach((broadcast) => broadcast()));
    await waitFor(() => expect(result.current.sandboxCapability).toEqual(active));
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it.each([
    [{ kind: "subscription", provider: "claude-code" }, `Claude · ${t("llmTab.cliDefaultModel")}`],
    [{ kind: "subscription", provider: "claude-code", model: "claude-sonnet-5-5" }, "Claude · claude-sonnet-5-5"],
    [{ kind: "subscription", provider: "kimi-code" }, "Kimi"],
  ] as const)("labels a subscription runtime %j as %s", async (activeChatRuntime, expected) => {
    const settings = fakeAppSettings({ llm: { activeChatRuntime } });
    const { result } = renderHook(() => useInputStatusRow(apiWith(settings)));
    await waitFor(() => expect(result.current.vendorModel).toBe(expected));
  });
});

describe("configured route billing in the current composer", () => {
  it.each([
    ["optional key", undefined, true, true],
    ["keyless preset", false, false, false],
    ["keyed preset", true, true, true],
  ] as const)("resolves %s using its exact credential address", async (_label, presetRequiresKey, hasKey, billed) => {
    const preset = {
      providerId: "billing-fixture", label: "Billing fixture", baseUrl: "https://billing.example.test/v1",
      defaultModel: "fixture-model", modelOptions: ["fixture-model"], requiresApiKey: presetRequiresKey ?? false,
      apiKeyPlaceholder: "fixture-key",
    };
    const presetId = presetRequiresKey === undefined ? undefined : preset.providerId;
    const settings = fakeAppSettings({
      llm: { provider: "openai-compatible", activeChatRuntime: { kind: "api" },
        vendors: { "openai-compatible": { baseUrl: "https://billing.example.test/v1", model: "fixture-model" } },
        ...(presetId ? { marketplaceProviderPresetId: presetId } : {}),
      },
      marketplace: { installedProviderPresets: presetId ? [preset] : [] },
      activeChatModel: { kind: "api", vendor: "openai-compatible", model: "fixture-model", ...(presetId ? { marketplaceProviderPresetId: presetId } : {}) },
    });
    const api = apiWith(settings);
    api.hasApiKey = vi.fn(async () => hasKey);
    const { result } = renderHook(() => useInputStatusRow(api));
    await waitFor(() => expect(result.current.billingRoute).toEqual({ kind: billed ? "api-key" : "keyless" }));
    expect(api.hasApiKey).toHaveBeenCalledWith(presetId ? "marketplace-provider:billing-fixture" : "openai-compatible");
  });

  it("does not let a delayed key query label a newly selected subscription", async () => {
    const initial = fakeAppSettings({ llm: { provider: "openai-compatible", vendors: { "openai-compatible": { baseUrl: "https://billing.example.test/v1", model: "fixture-model" } } }, activeChatModel: { kind: "api", vendor: "openai-compatible", model: "fixture-model" } });
    let resolveKey!: (value: boolean) => void;
    let broadcast!: (settings: AppSettings) => void;
    const api = apiWith(initial);
    api.hasApiKey = vi.fn(() => new Promise<boolean>((resolve) => { resolveKey = resolve; }));
    api.onSettingsUpdated = vi.fn((callback) => { broadcast = callback; return () => {}; });
    const { result } = renderHook(() => useInputStatusRow(api));
    await waitFor(() => expect(api.hasApiKey).toHaveBeenCalled());
    act(() => broadcast(fakeAppSettings({ llm: { activeChatRuntime: { kind: "subscription", provider: "claude-code" } } })));
    await act(async () => resolveKey(true));
    expect(result.current.billingRoute).toEqual({ kind: "subscription", provider: "claude-code" });
  });
});
