/**
 * Installed content in the renderer (blueprint 3.2–3.4): installed themes,
 * languages and fonts load from `aveApi.installedContent`, apply, and show
 * in the appearance pickers; a selected package that is gone falls back to
 * the default.
 */
import "../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, render, waitFor } from "@testing-library/react";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider.js";
import { AppearanceTab } from "../tabs/AppearanceTab.js";
import { DEFAULT_BUNDLE_ID } from "../theme/index.js";
import { moonstoneBundle } from "../theme/bundles/moonstone.js";
import { resetLoadedThemeBundleCacheForTests } from "../theme/bundles/index.js";
import { applyBundleToDocument } from "../theme/resolve-theme.js";
import { applyInstalledContent, ensureInstalledContent, fontFaceCss, resetInstalledContentForTests } from "../installed-content.js";
import { makeMockAveApi } from "../../../../test/renderer/mock-ave-api.js";
import { isLocale, loadLocaleMessages, localeInfo, setLocale, translate } from "../../../i18n/index.js";
import type { InstalledContentApi, InstalledContentView, InstalledThemeView } from "../../../shared/installed-content.js";

configure({ asyncUtilTimeout: 5000 });

const surfaces = {
  "surface-sunken": "220 16% 18%",
  surface: "222 16% 28%",
  "surface-raised": "220 17% 33%",
  "surface-overlay": "220 16% 37%",
  "border-subtle": "220 16% 32%",
  "border-strong": "220 16% 46%",
};

const harbor: InstalledThemeView = {
  id: "harbor",
  name: "Harbor",
  description: "Harbor theme.",
  shell: "dark",
  highContrast: false,
  tokens: { ...moonstoneBundle.tokens, background: "210 40% 12%" },
  surfaces,
  sourceId: "acme",
  version: "1.0.0",
};

const view = (patch: Partial<InstalledContentView> = {}): InstalledContentView => ({ themes: [], languages: [], fonts: [], broken: [], ...patch });

function bridge(content: InstalledContentView, messages: Record<string, Record<string, string>> = {}): InstalledContentApi {
  return {
    installed: vi.fn(async () => ({ ok: true as const, content })),
    languageMessages: vi.fn(async (locale: string) =>
      messages[locale] ? { ok: true as const, messages: messages[locale]! } : { ok: false as const, error: "language-not-installed" }),
  };
}

function Probe() {
  const { bundleId, effectiveBundleId } = useTheme();
  return <span data-testid="bundle">{`${bundleId}|${effectiveBundleId}`}</span>;
}

beforeEach(() => {
  resetInstalledContentForTests();
  resetLoadedThemeBundleCacheForTests();
});

afterEach(() => {
  cleanup();
  resetInstalledContentForTests();
  setLocale("en");
  const root = document.documentElement;
  root.removeAttribute("data-theme-bundle");
  root.removeAttribute("data-shell");
  root.style.cssText = "";
  delete (window as unknown as Record<string, unknown>).aveApi;
});

describe("installed themes (blueprint 3.2)", () => {
  it("applies a selected installed theme as inline properties, and a compiled bundle clears them", async () => {
    const { api } = makeMockAveApi({ settings: { appearance: { schemaVersion: 2, language: "en", bundleId: "harbor" } } });
    api.installedContent = bridge(view({ themes: [harbor] })) as never;
    const { getByTestId } = render(<ThemeProvider api={api as never}><Probe /></ThemeProvider>);

    await waitFor(() => expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("harbor"));
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--background")).toBe("210 40% 12%");
    expect(root.style.getPropertyValue("--surface-raised")).toBe("220 17% 33%");
    expect(root.style.getPropertyValue("--shadow-e1")).toContain("inset 0 1px 0");
    expect(root.style.getPropertyValue("color-scheme")).toBe("dark");
    expect(getByTestId("bundle").textContent).toBe("harbor|harbor");

    applyBundleToDocument(moonstoneBundle);
    expect(root.getAttribute("data-theme-bundle")).toBe("moonstone");
    expect(root.style.getPropertyValue("--background")).toBe("");
    expect(root.style.getPropertyValue("--surface-raised")).toBe("");
    expect(root.style.getPropertyValue("color-scheme")).toBe("");
  });

  it("falls back to the default bundle when the selected theme is not installed", async () => {
    const { api } = makeMockAveApi({ settings: { appearance: { schemaVersion: 2, language: "en", bundleId: "harbor" } } });
    api.installedContent = bridge(view()) as never;
    const { getByTestId } = render(<ThemeProvider api={api as never}><Probe /></ThemeProvider>);
    await waitFor(() => expect(getByTestId("bundle").textContent).toBe(`${DEFAULT_BUNDLE_ID}|${DEFAULT_BUNDLE_ID}`));
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe(DEFAULT_BUNDLE_ID);
    expect(document.documentElement.style.getPropertyValue("--background")).toBe("");
  });
});

describe("installed languages (blueprint 3.3)", () => {
  it("registers the locale and loads its catalog through the bridge, English answering the rest", async () => {
    const api = bridge(view({
      languages: [{ name: "french", locale: "fr", nativeName: "Français", englishName: "French", missingKeys: [], sourceId: "acme", version: "1.0.0" }],
    }), { fr: { "appearanceTab.pageTitle": "Apparence" } });
    await ensureInstalledContent({ installedContent: api });
    expect(isLocale("fr")).toBe(true);
    expect(localeInfo("fr")).toEqual({ nativeName: "Français", englishName: "French" });
    await loadLocaleMessages("fr");
    expect(api.languageMessages).toHaveBeenCalledWith("fr");
    expect(translate("fr", "appearanceTab.pageTitle")).toBe("Apparence");
    expect(translate("fr", "appearanceTab.themeSectionTitle")).toBe(translate("en", "appearanceTab.themeSectionTitle"));
  });

  it("forgets a locale whose package is gone", async () => {
    const api = bridge(view({
      languages: [{ name: "french", locale: "fr", nativeName: "Français", englishName: "French", missingKeys: [], sourceId: "acme", version: "1.0.0" }],
    }));
    applyInstalledContent(view({ languages: [{ name: "french", locale: "fr", nativeName: "Français", englishName: "French", missingKeys: [], sourceId: "acme", version: "1.0.0" }] }), api);
    applyInstalledContent(view(), api);
    expect(isLocale("fr")).toBe(false);
  });
});

describe("installed fonts (blueprint 3.4)", () => {
  it("declares @font-face rules only for ave-content font URLs", () => {
    const css = fontFaceCss([
      {
        name: "harbor-sans",
        family: "Harbor Sans",
        stack: "\"ave-font-harbor-sans\", system-ui",
        faces: [
          { url: "ave-content://0123456789abcdef0123456789abcdef/font/harbor-sans/files/HarborSans.woff2", format: "woff2", weight: "100 900", style: "normal" },
          { url: "https://evil.example/x.woff2", format: "woff2", weight: "400", style: "normal" },
        ],
        sourceId: "acme",
        version: "1.0.0",
      },
    ]);
    expect(css).toBe(
      '@font-face { font-family: "ave-font-harbor-sans"; src: url("ave-content://0123456789abcdef0123456789abcdef/font/harbor-sans/files/HarborSans.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }',
    );
  });
});

describe("appearance pickers list installed items (P3 exit)", () => {
  it("shows the installed theme, language and font", async () => {
    const { api } = makeMockAveApi();
    api.installedContent = bridge(view({
      themes: [harbor],
      languages: [{ name: "french", locale: "fr", nativeName: "Français", englishName: "French", missingKeys: [], sourceId: "acme", version: "1.0.0" }],
      fonts: [{ name: "harbor-sans", family: "Harbor Sans", stack: "\"ave-font-harbor-sans\", system-ui", faces: [], sourceId: "acme", version: "1.0.0" }],
    })) as never;
    (window as unknown as { aveApi: unknown }).aveApi = api;
    const { getByRole, getByTestId, getByText } = render(
      <ThemeProvider api={api as never}><AppearanceTab /></ThemeProvider>,
    );
    await act(async () => {
      await ensureInstalledContent(api as never);
    });
    await waitFor(() => expect(getByRole("radio", { name: "Theme: Harbor" })).toBeTruthy());
    expect(getByTestId("appearance-tab:theme-marketplace-badge:harbor")).toBeTruthy();
    expect(getByTestId("language-option-fr")).toHaveTextContent("Français");
    expect(getByTestId("language-option-fr")).toHaveAttribute("data-marketplace-installed", "true");
    expect(getByText("Harbor Sans")).toBeTruthy();
  });
});
