import { afterEach, describe, expect, it, vi } from "vitest";
import { installRendererModelCatalog, renderModelCatalogUnavailable } from "../model-catalog-bootstrap.js";
import { activeModelCatalog, installModelCatalog } from "../../../shared/model-catalog/active.js";
import type { ModelCatalogDocument } from "../../../shared/model-catalog/types.js";
import { t } from "../../../i18n/runtime.js";

const installed = activeModelCatalog();
afterEach(() => installModelCatalog(installed));

describe("installRendererModelCatalog", () => {
  it("installs the catalog main hands over, so the renderer resolves against main's copy", async () => {
    const fromMain = { ...installed, sha256: "f".repeat(64) } as ModelCatalogDocument;
    await installRendererModelCatalog({ getModelCatalog: async () => ({ ok: true, catalog: fromMain, refreshPolicy: null }) });
    expect(activeModelCatalog()).toBe(fromMain);
  });

  it("fails rather than mounting against no catalog when main refuses", async () => {
    await expect(
      installRendererModelCatalog({ getModelCatalog: async () => ({ ok: false, error: "unauthorized-frame" }) }),
    ).rejects.toThrow(/refused the model catalog/);
    expect(activeModelCatalog()).toBe(installed);
  });
});

describe("renderModelCatalogUnavailable", () => {
  it("replaces the blank root with a visible reason and a reload", () => {
    const root = document.createElement("div");
    root.append(document.createElement("span"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    renderModelCatalogUnavailable(root, new Error("the host refused the model catalog: catalog-unavailable"));
    quiet.mockRestore();
    const panel = root.querySelector('[data-testid="model-catalog-unavailable"]');
    expect(panel?.getAttribute("role")).toBe("alert");
    expect(root.children).toHaveLength(1);
    expect(panel?.textContent).toContain(t("app.modelCatalogUnavailable"));
    expect(panel?.textContent).toContain("catalog-unavailable");
    expect(panel?.querySelector("button")).not.toBeNull();
  });
});
