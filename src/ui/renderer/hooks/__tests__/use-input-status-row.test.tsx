import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

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
    // A fresh profile's openai block still carries its default id; the row
    // must not present that as the model chat is on.
    const settings = fakeAppSettings({
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
