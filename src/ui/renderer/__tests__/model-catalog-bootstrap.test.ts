import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { installRendererModelCatalog, renderModelCatalogUnavailable } from "../model-catalog-bootstrap.js";
import { activeModelCatalog, installModelCatalog } from "../../../shared/model-catalog/active.js";
import type { ModelCatalogDocument } from "../../../shared/model-catalog/types.js";
import { getLocale, setLocale, t } from "../../../i18n/runtime.js";
import type { AveApi } from "../types.js";

const installed = activeModelCatalog();
const initialLocale = getLocale();
const initialDocumentLanguage = document.documentElement.lang;
afterEach(() => {
  installModelCatalog(installed);
  setLocale(initialLocale);
  document.documentElement.lang = initialDocumentLanguage;
  vi.restoreAllMocks();
});

describe("installRendererModelCatalog", () => {
  it("installs the catalog main hands over, so the renderer resolves against main's copy", async () => {
    const fromMain = { ...installed, sha256: "f".repeat(64) } as ModelCatalogDocument;
    await installRendererModelCatalog({ getModelCatalog: async () => ({ ok: true, catalog: fromMain }) });
    expect(activeModelCatalog()).toBe(fromMain);
  });

  it("fails rather than mounting against no catalog when main refuses", async () => {
    await expect(
      installRendererModelCatalog({ getModelCatalog: async () => ({ ok: false, error: "unauthorized-frame" }) }),
    ).rejects.toThrow("unauthorized-frame");
    expect(activeModelCatalog()).toBe(installed);
  });
});

describe("renderModelCatalogUnavailable", () => {
  it("hydrates the persisted locale when the application cannot mount", async () => {
    setLocale("en");
    document.documentElement.lang = "en";
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const getSettings = vi.fn(async () => ({ appearance: { language: "ko" } }) as Awaited<ReturnType<AveApi["getSettings"]>>);
    renderModelCatalogUnavailable(root, new Error("unauthorized-frame"), { getSettings });
    await waitFor(() => expect(root.textContent).toContain("인증되지 않은 프레임"));
    expect(document.documentElement.lang).toBe("ko");
    expect(getSettings).toHaveBeenCalledOnce();
    expect(root.textContent).not.toContain("unauthorized-frame");
  });

  it("sets the fallback document language when settings cannot be read", async () => {
    setLocale("ko");
    document.documentElement.lang = "en";
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const getSettings = vi.fn(async () => { throw new Error("settings unavailable"); });
    renderModelCatalogUnavailable(root, new Error("catalog-unavailable"), { getSettings });
    await waitFor(() => expect(getSettings).toHaveBeenCalledOnce());
    await expect(getSettings.mock.results[0]!.value).rejects.toThrow("settings unavailable");
    expect(document.documentElement.lang).toBe("ko");
    expect(root.textContent).toContain(t("app.modelCatalogUnavailable"));
  });

  it("replaces the blank root with a visible reason and a reload", () => {
    const root = document.createElement("div");
    root.append(document.createElement("span"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    renderModelCatalogUnavailable(root, new Error("catalog-unavailable"));
    quiet.mockRestore();
    const panel = root.querySelector('[data-testid="model-catalog-unavailable"]');
    expect(panel?.getAttribute("role")).toBe("alert");
    expect(root.children).toHaveLength(1);
    expect(panel?.textContent).toContain(t("app.modelCatalogUnavailable"));
    expect(panel?.textContent).toContain(t("formatIpcError.catalogUnavailable"));
    expect(panel?.textContent).not.toContain("catalog-unavailable");
    expect(panel?.querySelector("button")).not.toBeNull();
  });

  it("keeps transport diagnostics out of the startup panel", () => {
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderModelCatalogUnavailable(root, new Error("invoke failed at a private transport"));
    expect(root.textContent).toContain(t("formatIpcError.catalogUnavailable"));
    expect(root.textContent).not.toContain("invoke failed at a private transport");
  });

  it("localizes the frame refusal from the host", async () => {
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = await installRendererModelCatalog({
      getModelCatalog: async () => ({ ok: false, error: "unauthorized-frame" }),
    }).catch((error: unknown) => error);
    renderModelCatalogUnavailable(root, failure);
    expect(root.textContent).toContain(t("formatIpcError.unauthorizedFrame"));
    expect(root.textContent).not.toContain("unauthorized-frame");
  });
});
