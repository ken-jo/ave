/**
 * ModelCatalogRefreshSection — the `llm.modelCatalogRefresh` switch.
 *
 * On by default, saved through updateSettings, and read-only with a reason
 * whenever something other than the switch decides: a `AVE_MODEL_CATALOG`
 * pin or the managed policy file.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { ModelCatalogRefreshSection } from "../ModelCatalogRefreshSection.js";
import { installMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../../test/renderer/mock-ave-api.js";
import { activeModelCatalog } from "../../../../shared/model-catalog/active.js";

function withRefresh(refresh?: "auto" | "off") {
  return { ...MOCK_DEFAULT_SETTINGS, llm: { ...MOCK_DEFAULT_SETTINGS.llm, ...(refresh ? { modelCatalogRefresh: refresh } : {}) } };
}

const switchOf = async (findByTestId: (id: string) => Promise<HTMLElement>) => findByTestId("llm-model-catalog-refresh");

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
    const api = installMockAveApi({ settings: withRefresh("auto") });
    const { findByTestId } = render(<ModelCatalogRefreshSection />);
    const control = await switchOf(findByTestId);
    await waitFor(() => expect((control as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(control);
    await waitFor(() => expect(api.updateSettings).toHaveBeenCalledWith({ llm: { modelCatalogRefresh: "off" } }));
    expect(control.getAttribute("aria-checked")).toBe("false");
  });

  it("shows a stored off", async () => {
    installMockAveApi({ settings: withRefresh("off") });
    const { findByTestId } = render(<ModelCatalogRefreshSection />);
    const control = await switchOf(findByTestId);
    await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("false"));
  });

  it("goes read-only and names the variable under a AVE_MODEL_CATALOG pin", async () => {
    installMockAveApi({ settings: withRefresh("auto"), envForcedSettings: ["llm.modelCatalogRefresh"] });
    const { findByTestId } = render(<ModelCatalogRefreshSection />);
    const notice = await findByTestId("llm-model-catalog-forced");
    expect(notice.textContent).toContain("AVE_MODEL_CATALOG");
    await waitFor(async () => expect(((await switchOf(findByTestId)) as HTMLButtonElement).disabled).toBe(true));
  });

  it("goes read-only and says so when the managed policy turns it off", async () => {
    installMockAveApi({ settings: withRefresh("auto"), modelCatalog: { ok: true, catalog: activeModelCatalog(), refreshPolicy: "off" } });
    const { findByTestId } = render(<ModelCatalogRefreshSection />);
    await findByTestId("llm-model-catalog-policy");
    expect(((await switchOf(findByTestId)) as HTMLButtonElement).disabled).toBe(true);
  });
});
