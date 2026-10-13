import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
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
    ).rejects.toThrow("unauthorized-frame");
    expect(activeModelCatalog()).toBe(installed);
  });
});

describe("renderModelCatalogUnavailable", () => {
  it("hydrates the persisted locale and localizes a host frame refusal before the application mounts", async () => {
    setLocale("en");
    document.documentElement.lang = "en";
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const getSettings = vi.fn(async () => ({ appearance: { language: "ko" } }) as AppSettings);
    await renderModelCatalogUnavailable(root, new Error("unauthorized-frame"), { getSettings });
    expect(root.textContent).toContain("인증되지 않은 프레임");
    expect(document.documentElement.lang).toBe("ko");
    expect(getSettings).toHaveBeenCalledOnce();
    expect(root.textContent).not.toContain("unauthorized-frame");
  });

  it("sets the English document language when settings cannot be read", async () => {
    setLocale("ko");
    document.documentElement.lang = "ko";
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const getSettings = vi.fn(async () => { throw new Error("settings unavailable"); });
    await renderModelCatalogUnavailable(root, new Error("catalog-unavailable"), { getSettings });
    expect(getSettings).toHaveBeenCalledOnce();
    expect(getLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(root.textContent).toContain(t("app.modelCatalogUnavailable"));
    expect(root.textContent).toContain(t("formatIpcError.catalogUnavailable"));
  });

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

  it("replaces the blank root with a visible reason and a reload without a settings channel", async () => {
    const root = document.createElement("div");
    root.append(document.createElement("span"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderModelCatalogUnavailable(root, new Error("catalog-unavailable"));
    const panel = root.querySelector('[data-testid="model-catalog-unavailable"]');
    expect(panel?.getAttribute("role")).toBe("alert");
    expect(root.children).toHaveLength(1);
    expect(panel?.textContent).toContain(t("app.modelCatalogUnavailable"));
    expect(panel?.textContent).toContain(t("formatIpcError.catalogUnavailable"));
    expect(panel?.textContent).not.toContain("catalog-unavailable");
    expect(panel?.querySelector("button")).not.toBeNull();
  });

  it("keeps transport diagnostics out of the startup panel", async () => {
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await renderModelCatalogUnavailable(root, new Error("invoke failed at a private transport"));
    expect(root.textContent).toContain(t("formatIpcError.catalogUnavailable"));
    expect(root.textContent).not.toContain("invoke failed at a private transport");
  });

  it("localizes the frame refusal from the host", async () => {
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = await installRendererModelCatalog({
      getModelCatalog: async () => ({ ok: false, error: "unauthorized-frame" }),
    }).catch((error: unknown) => error);
    await renderModelCatalogUnavailable(root, failure);
    expect(root.textContent).toContain(t("formatIpcError.unauthorizedFrame"));
    expect(root.textContent).not.toContain("unauthorized-frame");
  });

  it.each(["message", "stringification"])("keeps the reload usable when diagnostic %s is unreadable", async (failure) => {
    const error = failure === "message"
      ? Object.defineProperty(new Error(), "message", { get() { throw new Error("unreadable diagnostic fixture"); } })
      : { toString() { throw new Error("unprintable diagnostic fixture"); } };
    const root = document.createElement("div");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(renderModelCatalogUnavailable(root, error)).resolves.toBeUndefined();
    expect(root.textContent).toContain(t("formatIpcError.catalogUnavailable"));
    expect(root.querySelector("button")?.textContent).toBe("Reload");
    expect(root.outerHTML).not.toContain("diagnostic fixture");
  });

  it("uses one captured host API for catalog failure and saved language in the renderer entry", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    const api = {
      getModelCatalog: vi.fn(async () => ({ ok: false, error: "unauthorized-frame" })),
      getSettings: vi.fn(async () => ({ appearance: { language: "ko" } }) as AppSettings),
    };
    const getApi = vi.fn(() => api);
    const createRoot = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("../api-client.js", () => ({ getApi }));
    vi.doMock("../host-marketplace-api.js", () => ({ primeHostMarketplaceApi: vi.fn() }));
    vi.doMock("../App.js", () => ({ App: () => null }));
    vi.doMock("../context/I18nSettingsProvider.js", () => ({ I18nSettingsProvider: () => null }));
    vi.doMock("react-dom/client", () => ({ createRoot }));
    try {
      await import("../../../renderer.js");
      await waitFor(() => expect(root.textContent).toContain("인증되지 않은 프레임"));
      expect(getApi).toHaveBeenCalledOnce();
      expect(api.getSettings).toHaveBeenCalledOnce();
      expect(document.documentElement.lang).toBe("ko");
      expect(createRoot).not.toHaveBeenCalled();
    } finally {
      root.remove();
      vi.doUnmock("../api-client.js");
      vi.doUnmock("../host-marketplace-api.js");
      vi.doUnmock("../App.js");
      vi.doUnmock("../context/I18nSettingsProvider.js");
      vi.doUnmock("react-dom/client");
    }
  });
});
