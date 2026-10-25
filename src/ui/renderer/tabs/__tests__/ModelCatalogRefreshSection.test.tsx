/** Environment pins and managed policy make the catalog refresh switch read-only with a reason. */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ModelCatalogRefreshSection } from "../ModelCatalogRefreshSection.js";
import { installMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";
import { activeModelCatalog } from "../../../../shared/model-catalog/active.js";

function withRefresh(refresh?: "auto" | "off") {
  const llm: Omit<typeof MOCK_DEFAULT_SETTINGS.llm, "modelCatalogRefresh"> & { modelCatalogRefresh?: "auto" | "off" } = { ...MOCK_DEFAULT_SETTINGS.llm };
  delete llm.modelCatalogRefresh;
  return { ...MOCK_DEFAULT_SETTINGS, llm: { ...llm, ...(refresh ? { modelCatalogRefresh: refresh } : {}) } };
}

const switchOf = async (findByTestId: (id: string) => Promise<HTMLElement>) => findByTestId("llm-model-catalog-refresh");
const catalogResult = () => ({ ok: true as const, catalog: activeModelCatalog(), refreshPolicy: null });

describe("ModelCatalogRefreshSection", () => {
  it("is on when nothing is stored, and says which catalog is in use", async () => {
    const catalog = activeModelCatalog();
    installMockAveApi({ settings: withRefresh(), modelCatalog: { ok: true, catalog, refreshPolicy: null } });
    const { findByTestId, queryByTestId } = render(<ModelCatalogRefreshSection />);
    const control = await switchOf(findByTestId);
    await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("true"));
    expect((control as HTMLButtonElement).disabled).toBe(false);
    const inForce = await findByTestId("llm-model-catalog-in-force");
    expect(inForce.textContent).toContain(catalog.provenance.fetchedAt.slice(0, 10));
    expect(inForce.textContent).toContain(catalog.sha256.slice(0, 12));
    expect(queryByTestId("llm-model-catalog-policy")).toBeNull();
    expect((await findByTestId("llm-model-catalog-help")).textContent).toContain("https://models.dev/api.json");
  });

  it("saves off through updateSettings", async () => {
    const api = installMockAveApi({ settings: withRefresh("auto"), modelCatalog: catalogResult() });
    const { findByTestId } = render(<ModelCatalogRefreshSection />);
    const control = await switchOf(findByTestId);
    await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(control);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ llm: { modelCatalogRefresh: "off" } }));
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("shows a stored off", async () => {
    installMockAveApi({ settings: withRefresh("off"), modelCatalog: catalogResult() });
    const { findByTestId } = render(<ModelCatalogRefreshSection />);
    const control = await switchOf(findByTestId);
    await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("false"));
  });

  it("keeps the saved preference and shows an error when the save is refused", async () => {
    const api = installMockAveApi({ settings: withRefresh("auto"), modelCatalog: catalogResult() });
    api.updateSettings.mockResolvedValueOnce({ ok: false, error: "internal-error", message: "internal failure detail" });
    const { findByTestId, findByRole } = render(<ModelCatalogRefreshSection />);
    const control = await switchOf(findByTestId);
    await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(control);
    expect((await findByRole("alert")).textContent).toMatch(/Settings save failed|설정 저장 실패/);
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect((control as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps the saved preference when the save rejects", async () => {
    const api = installMockAveApi({ settings: withRefresh("auto"), modelCatalog: catalogResult() });
    api.updateSettings.mockRejectedValueOnce(new Error("internal failure detail"));
    const { findByTestId, findByRole } = render(<ModelCatalogRefreshSection />);
    const control = await switchOf(findByTestId);
    await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(control);
    expect((await findByRole("alert")).textContent).not.toContain("internal failure detail");
    expect(control.getAttribute("aria-checked")).toBe("true");
  });

  it("goes read-only and names the variable under a AVE_MODEL_CATALOG pin", async () => {
    installMockAveApi({ settings: withRefresh("auto"), modelCatalog: catalogResult(), envForcedSettings: ["llm.modelCatalogRefresh"] });
    const { findByTestId } = render(<ModelCatalogRefreshSection />);
    const notice = await findByTestId("llm-model-catalog-forced");
    expect(notice.textContent).toContain("AVE_MODEL_CATALOG");
    await waitFor(async () => expect(((await switchOf(findByTestId)) as HTMLButtonElement).disabled).toBe(true));
    expect((await switchOf(findByTestId)).getAttribute("aria-checked")).toBe("false");
  });

  it("waits for policy before permitting a save", async () => {
    let resolvePolicy!: (value: ReturnType<typeof catalogResult>) => void;
    const api = installMockAveApi({ settings: withRefresh("auto") });
    api.getModelCatalog.mockImplementationOnce(() => new Promise((resolve) => { resolvePolicy = resolve; }));
    const { findByTestId } = render(<ModelCatalogRefreshSection />);
    const control = await switchOf(findByTestId);
    expect((control as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(control);
    expect(api.updateSettings).not.toHaveBeenCalled();
    resolvePolicy(catalogResult());
    await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
  });

  it.each(["refused", "rejected"])("disables the control when policy lookup is %s", async (kind) => {
    const api = installMockAveApi({ settings: withRefresh("auto") });
    if (kind === "refused") api.getModelCatalog.mockResolvedValueOnce({ ok: false, error: "catalog-unavailable" });
    else api.getModelCatalog.mockRejectedValueOnce(new Error("internal failure detail"));
    const { findByTestId, findByRole } = render(<ModelCatalogRefreshSection />);
    expect((await findByRole("alert")).textContent).not.toContain("internal failure detail");
    expect(((await switchOf(findByTestId)) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables repeated toggles while a save is pending", async () => {
    const api = installMockAveApi({ settings: withRefresh("auto"), modelCatalog: catalogResult() });
    let finishSave!: (value: ReturnType<typeof withRefresh>) => void;
    api.updateSettings.mockImplementationOnce(() => new Promise((resolve) => { finishSave = resolve; }));
    const { findByTestId } = render(<ModelCatalogRefreshSection />);
    const control = await switchOf(findByTestId);
    await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(control);
    expect((control as HTMLButtonElement).disabled).toBe(true);
    expect(control.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(control);
    expect(api.updateSettings).toHaveBeenCalledOnce();
    finishSave(withRefresh("off"));
    await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("false"));
    expect((control as HTMLButtonElement).disabled).toBe(false);
  });

  it("goes read-only and says so when the managed policy turns it off", async () => {
    installMockAveApi({ settings: withRefresh("auto"), modelCatalog: { ok: true, catalog: activeModelCatalog(), refreshPolicy: "off" } });
    const { findByTestId } = render(<ModelCatalogRefreshSection />);
    await findByTestId("llm-model-catalog-policy");
    expect(((await switchOf(findByTestId)) as HTMLButtonElement).disabled).toBe(true);
    expect((await switchOf(findByTestId)).getAttribute("aria-checked")).toBe("false");
  });
});
