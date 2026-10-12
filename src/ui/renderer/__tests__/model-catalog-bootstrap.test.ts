import { afterEach, describe, expect, it, vi } from "vitest";
import { installRendererModelCatalog, renderModelCatalogUnavailable } from "../model-catalog-bootstrap.js";
import { activeModelCatalog, installModelCatalog } from "../../../shared/model-catalog/active.js";
import type { ModelCatalogDocument } from "../../../shared/model-catalog/types.js";
import { getLocale, setLocale, t } from "../../../i18n/runtime.js";
import type { AppSettings } from "../types.js";
import { __setLocaleLoaderForTest } from "../../../i18n/messages/index.js";

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
  it.each(["en", "ko"])("aligns the document language with the saved %s startup copy", async (locale) => {
    setLocale("en");
    document.documentElement.lang = locale === "en" ? "ko" : "en";
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderModelCatalogUnavailable(root, new Error("catalog fixture diagnostic"), {
      getSettings: async () => ({ appearance: { language: locale } }) as AppSettings,
    });
    expect(document.documentElement.lang).toBe(locale);
    expect(root.querySelector("button")?.textContent).toBe(locale === "ko" ? "새로고침" : "Reload");
  });

  it.each(["rejected", "thrown"])("falls back to English without crashing when settings are %s", async (failure) => {
    setLocale("ko");
    document.documentElement.lang = "ko";
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const getSettings = failure === "rejected"
      ? vi.fn().mockRejectedValue(new Error("unreadable settings fixture"))
      : vi.fn(() => { throw new Error("unreadable settings fixture"); });
    await expect(renderModelCatalogUnavailable(root, new Error("catalog fixture diagnostic"), { getSettings })).resolves.toBeUndefined();
    expect(getLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(root.querySelector("p")?.textContent).toContain("Ave could not load its model catalog, so the app cannot start.");
    expect(root.querySelector("button")?.textContent).toBe("Reload");
    expect(root.outerHTML).not.toContain("unreadable settings fixture");
  });

  it.each([undefined, null, {}, { appearance: null }, { appearance: { language: "unknown-locale" } }])("uses English for malformed settings %j", async (settings) => {
    setLocale("ko");
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(renderModelCatalogUnavailable(root, new Error("catalog fixture diagnostic"), {
      getSettings: async () => settings as AppSettings,
    })).resolves.toBeUndefined();
    expect(getLocale()).toBe("en");
    expect(root.querySelector("button")?.textContent).toBe("Reload");
  });

  it("keeps English and a reload when the saved language catalog cannot load", async () => {
    setLocale("ko");
    const restoreLoader = __setLocaleLoaderForTest("ko", async () => { throw new Error("locale fixture diagnostic"); });
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await renderModelCatalogUnavailable(root, new Error("catalog fixture diagnostic"), {
        getSettings: async () => ({ appearance: { language: "ko" } }) as AppSettings,
      });
      expect(getLocale()).toBe("en");
      expect(root.querySelector("button")?.textContent).toBe("Reload");
      expect(root.outerHTML).not.toContain("locale fixture diagnostic");
    } finally {
      restoreLoader();
    }
  });

  it.each(["en", "ko"])("reads the saved %s language and keeps startup diagnostics in the console", async (locale) => {
    setLocale("en");
    const root = document.createElement("div");
    root.append(document.createElement("span"));
    const error = new Error("Error invoking remote method 'ave:llm:get-model-catalog': No handler registered");
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const getSettings = vi.fn(async () => ({ appearance: { language: locale } }) as AppSettings);
    await renderModelCatalogUnavailable(root, error, { getSettings });
    const panel = root.querySelector('[data-testid="model-catalog-unavailable"]');
    expect(panel?.getAttribute("role")).toBe("alert");
    expect(root.children).toHaveLength(1);
    expect(getLocale()).toBe(locale);
    expect(panel?.textContent).toContain(t("app.modelCatalogUnavailable"));
    expect(panel?.textContent).not.toContain(error.message);
    expect(panel?.textContent).not.toContain("ave:llm:get-model-catalog");
    expect(root.outerHTML).not.toContain(error.message);
    expect(root.outerHTML).not.toContain("ave:llm:get-model-catalog");
    expect(getSettings).toHaveBeenCalledOnce();
    expect(panel?.querySelector("button")?.textContent).toBe(t("errorBoundary.reloadButton"));
    expect(quiet).toHaveBeenCalledWith(expect.any(String), error);
  });

  it("shows a reload immediately even when reading the language fails", async () => {
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const getSettings = vi.fn(async () => { throw new Error("settings channel unavailable"); });
    const rendered = renderModelCatalogUnavailable(root, new Error("catalog unavailable"), { getSettings });
    expect(root.querySelector("button")).not.toBeNull();
    await rendered;
    expect(root.textContent).toContain(t("app.modelCatalogUnavailable"));
    expect(root.textContent).not.toContain("settings channel unavailable");
  });
});
