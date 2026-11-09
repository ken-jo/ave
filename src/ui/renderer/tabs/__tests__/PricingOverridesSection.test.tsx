/** Reject rows normalization would drop; preserve drafts across unchanged broadcasts and honor environment read-only mode. */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { PricingOverridesSection } from "../PricingOverridesSection.js";
import { installMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";

const BASE_SETTINGS = {
  ...MOCK_DEFAULT_SETTINGS,
  llm: { ...MOCK_DEFAULT_SETTINGS.llm, pricingOverrides: [] },
};

function withOverrides(pricingOverrides: unknown[]) {
  return { ...BASE_SETTINGS, llm: { ...BASE_SETTINGS.llm, pricingOverrides } };
}

describe("PricingOverridesSection", () => {
  it("preserves a completed unsaved row across an unrelated settings broadcast", async () => {
    const api = installMockAveApi({ settings: BASE_SETTINGS });
    const { findByTestId, getByTestId } = render(<PricingOverridesSection />);
    fireEvent.click(await findByTestId("llm-pricing-override-add"));
    fireEvent.change(await findByTestId("llm-pricing-override-vendor-0"), { target: { value: "openai" } });
    fireEvent.change(await findByTestId("llm-pricing-override-model-0"), { target: { value: "draft-model" } });
    fireEvent.change(await findByTestId("llm-pricing-override-input-0"), { target: { value: "2.5" } });
    fireEvent.change(await findByTestId("llm-pricing-override-output-0"), { target: { value: "7" } });
    const save = getByTestId("llm-pricing-override-save") as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => { await api.updateSettings({ marketplace: { updateCheckIntervalMs: 3_600_000 } }); });
    expect((getByTestId("llm-pricing-override-model-0") as HTMLInputElement).value).toBe("draft-model");
    expect((getByTestId("llm-pricing-override-input-0") as HTMLInputElement).value).toBe("2.5");
    expect((getByTestId("llm-pricing-override-output-0") as HTMLInputElement).value).toBe("7");
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ llm: { pricingOverrides: [
      { vendor: "openai", model: "draft-model", inputPer1M: 2.5, outputPer1M: 7 },
    ] } }));
  });

  it("preserves an unsaved deletion across an unchanged pricing snapshot", async () => {
    const api = installMockAveApi({ settings: withOverrides([
      { vendor: "openai", model: "stored-model", inputPer1M: 2, outputPer1M: 5 },
    ]) });
    const { findByTestId, getByTestId, queryByTestId } = render(<PricingOverridesSection />);
    fireEvent.click(await findByTestId("llm-pricing-override-remove-0"));
    await act(async () => { await api.updateSettings({ marketplace: { updateCheckIntervalMs: 3_600_000 } }); });
    expect(queryByTestId("llm-pricing-override-model-0")).toBeNull();
    expect((getByTestId("llm-pricing-override-save") as HTMLButtonElement).disabled).toBe(false);
  });

  it("applies a genuinely changed stored correction", async () => {
    const api = installMockAveApi({ settings: BASE_SETTINGS });
    const { findByTestId } = render(<PricingOverridesSection />);
    await findByTestId("llm-pricing-overrides-empty");
    await act(async () => { await api.updateSettings({ llm: { pricingOverrides: [
      { vendor: "openai", model: "external-model", inputPer1M: 3, outputPer1M: 8 },
    ] } }); });
    expect((await findByTestId("llm-pricing-override-model-0") as HTMLInputElement).value).toBe("external-model");
    expect((await findByTestId("llm-pricing-override-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("says nothing is corrected when the list is empty", async () => {
    installMockAveApi({ settings: BASE_SETTINGS });
    const { findByTestId } = render(<PricingOverridesSection />);
    await findByTestId("llm-pricing-overrides-empty");
  });

  it("loads a stored correction into the table", async () => {
    installMockAveApi({
      settings: withOverrides([
        { vendor: "claude", model: "claude-sonnet-4-6", inputPer1M: 2, outputPer1M: 9 },
      ]),
    });
    const { findByTestId, getByTestId } = render(<PricingOverridesSection />);
    // Synchronous queries inside waitFor: an awaited findBy* there nests one polling timeout inside another and times out
    // under load.
    await findByTestId("llm-pricing-override-model-0");
    await waitFor(() => {
      expect((getByTestId("llm-pricing-override-model-0") as HTMLInputElement).value).toBe("claude-sonnet-4-6");
    });
    expect(((await findByTestId("llm-pricing-override-input-0")) as HTMLInputElement).value).toBe("2");
    expect(((await findByTestId("llm-pricing-override-output-0")) as HTMLInputElement).value).toBe("9");
  });

  it("refuses to save a row the store would silently drop", async () => {
    installMockAveApi({ settings: BASE_SETTINGS });
    const { findByTestId } = render(<PricingOverridesSection />);
    fireEvent.click(await findByTestId("llm-pricing-override-add"));
    const save = (await findByTestId("llm-pricing-override-save")) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
    await findByTestId("llm-pricing-override-incomplete");

    fireEvent.change(await findByTestId("llm-pricing-override-model-0"), { target: { value: "gpt-4o" } });
    fireEvent.change(await findByTestId("llm-pricing-override-input-0"), { target: { value: "5" } });
    await waitFor(() => expect(save.disabled).toBe(true)); // output rate still missing
  });

  it("persists a completed row through updateSettings", async () => {
    const api = installMockAveApi({ settings: BASE_SETTINGS });
    const { findByTestId } = render(<PricingOverridesSection />);
    fireEvent.click(await findByTestId("llm-pricing-override-add"));
    fireEvent.change(await findByTestId("llm-pricing-override-vendor-0"), { target: { value: "openai" } });
    fireEvent.change(await findByTestId("llm-pricing-override-model-0"), { target: { value: "  gpt-4o  " } });
    fireEvent.change(await findByTestId("llm-pricing-override-input-0"), { target: { value: "2.5" } });
    fireEvent.change(await findByTestId("llm-pricing-override-output-0"), { target: { value: "0" } });
    fireEvent.click(await findByTestId("llm-pricing-override-save"));
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        llm: {
          pricingOverrides: [
            { vendor: "openai", model: "gpt-4o", inputPer1M: 2.5, outputPer1M: 0 },
          ],
        },
      });
    });
  });

  it("removes a row and persists the shorter list", async () => {
    const api = installMockAveApi({
      settings: withOverrides([
        { vendor: "claude", model: "claude-sonnet-4-6", inputPer1M: 2, outputPer1M: 9 },
      ]),
    });
    const { findByTestId } = render(<PricingOverridesSection />);
    fireEvent.click(await findByTestId("llm-pricing-override-remove-0"));
    fireEvent.click(await findByTestId("llm-pricing-override-save"));
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ llm: { pricingOverrides: [] } });
    });
  });

  it("goes read-only and says why when the environment supplies the rates", async () => {
    installMockAveApi({
      envForcedSettings: ["llm.pricingOverrides"],
      settings: withOverrides([
        { vendor: "claude", model: "claude-sonnet-4-6", inputPer1M: 2, outputPer1M: 9 },
      ]),
    });
    const { findByTestId } = render(<PricingOverridesSection />);
    const model = (await findByTestId("llm-pricing-override-model-0")) as HTMLInputElement;
    await waitFor(() => expect(model.disabled).toBe(true));
    expect(((await findByTestId("llm-pricing-override-add")) as HTMLButtonElement).disabled).toBe(true);
    expect(((await findByTestId("llm-pricing-override-remove-0")) as HTMLButtonElement).disabled).toBe(true);
    const notice = await findByTestId("llm-pricing-overrides-forced");
    expect(notice.textContent).toContain("AVE_PRICING_OVERRIDE");
  });
});
