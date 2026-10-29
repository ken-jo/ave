// Model picks persist through debounce without requiring the section save action.
import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { makeMockAveApi } from "./mock-ave-api.js";
import { TEST_IDS } from "../../src/shared/test-ids.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("settings model chooser", () => {
  it("persists a pick without the Save button", async () => {
    const { api } = makeMockAveApi();
    // Endpoint catalogs must arrive before model choices exist.
    api.listLlmModels = vi.fn(async () => ({
      ok: true,
      vendor: "openai",
      endpoint: "https://api.openai.com/v1/models",
      models: ["gpt-4o-mini", "gpt-4o", "o3"],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    }));
    vi.stubGlobal("aveApi", api);
    (window as unknown as { aveApi: typeof api }).aveApi = api;
    const { SettingsContent } = await import("../../src/ui/renderer/SettingsContent.js");
    const { TooltipProvider } = await import("../../src/components/ui/tooltip.js");

    const view = render(
      <TooltipProvider>
        <SettingsContent api={api as never} onSaved={() => {}} initialTab="llm" />
      </TooltipProvider>,
    );
    const trigger = await view.findByTestId(TEST_IDS.llmModelSelect);
    // Await section hydration rather than a save button that may belong to a closed provider card.
    await waitFor(() => expect(view.getByTestId("llm-tab:section-providers"))
      .toHaveAttribute("data-settings-loaded", "true"));
    api.updateSettings.mockClear();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const options = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[role='option']")];
      if (found.length < 2) throw new Error("chooser not open yet");
      return found;
    });
    // Match model ids exactly; adjacent provider spans and unchanged selection can hide a missed pick.
    const currentModelId = trigger.querySelector("[data-model-id]")?.getAttribute("data-model-id");
    const other = options.find((option) => {
      const id = option.querySelector("[data-model-id]")?.getAttribute("data-model-id");
      return Boolean(id) && id !== currentModelId;
    });
    expect(other).toBeTruthy();
    other!.focus();
    fireEvent.keyDown(other!, { key: "Enter" });

    type VendorPatch = { llm: { provider: string; vendors: Record<string, { model: string }> } };
    // Catalog caching also writes settings; select the write carrying the provider choice.
    const vendorPatch = () => api.updateSettings.mock.calls
      .map((call) => call[0] as Partial<VendorPatch>)
      .filter((call): call is VendorPatch => Boolean(call.llm?.vendors))
      .at(-1);
    await waitFor(() => expect(vendorPatch()).toBeTruthy(), { timeout: 2_000 });
    const patch = vendorPatch()!;
    // Require exact ids so a selected model prefix cannot pass as a longer id.
    const pickedModelId = other!.querySelector("[data-model-id]")?.getAttribute("data-model-id");
    expect(pickedModelId).toBeTruthy();
    expect(patch.llm.vendors[patch.llm.provider]!.model).toBe(pickedModelId);
  });
});
