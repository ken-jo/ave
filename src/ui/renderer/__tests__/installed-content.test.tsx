import "../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, render, waitFor } from "@testing-library/react";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider.js";
import { AppearanceTab } from "../tabs/AppearanceTab.js";
import { DEFAULT_BUNDLE_ID } from "../theme/index.js";
import { moonstoneBundle } from "../theme/bundles/moonstone.js";
import { applyBundleToDocument } from "../theme/resolve-theme.js";
import { applyInstalledContent, ensureInstalledContent, fontFaceCss, resetInstalledContentForTests, useInstalledContent } from "../installed-content.js";
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

const view = (patch: Partial<InstalledContentView> = {}): InstalledContentView => ({ themes: [], languages: [], fonts: [], routineTemplates: [], broken: [], ...patch });

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

describe("installed themes", () => {
  it("follows the OS scheme across the pair an installed theme declares", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("light"), media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    try {
      const harborLight: InstalledThemeView = { ...harbor, id: "harbor-light", name: "Harbor Light", shell: "light", pair: "harbor" };
      const { api } = makeMockAveApi({ settings: { appearance: { schemaVersion: 2, language: "en", bundleId: "harbor", followSystem: true } } });
      api.installedContent = bridge(view({ themes: [{ ...harbor, pair: "harbor-light" }, harborLight] })) as never;
      const { getByTestId } = render(<ThemeProvider api={api as never}><Probe /></ThemeProvider>);
      await waitFor(() => expect(getByTestId("bundle").textContent).toBe("harbor|harbor-light"));
      // The pair member resolves after the installed content loads.
      await waitFor(() => expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("harbor-light"));
    } finally {
      vi.unstubAllGlobals();
    }
  });

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

describe("installed languages", () => {
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

  it("keeps the language on screen translated when the installed content is read again", async () => {
    const french = { name: "french", locale: "fr", nativeName: "Français", englishName: "French", missingKeys: [], sourceId: "acme", version: "1.0.0" };
    const api = bridge(view({ languages: [french] }), { fr: { "appearanceTab.pageTitle": "Apparence" } });
    applyInstalledContent(view({ languages: [french] }), api);
    await loadLocaleMessages("fr");
    setLocale("fr");
    function Title() {
      useInstalledContent();
      return <span data-testid="title">{translate("fr", "appearanceTab.pageTitle")}</span>;
    }
    const { getByTestId } = render(<Title />);
    expect(getByTestId("title")).toHaveTextContent("Apparence");

    // A marketplace sync re-reads the same content after boot.
    act(() => applyInstalledContent(view({ languages: [french] }), api));
    await waitFor(() => expect(api.languageMessages).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(getByTestId("title")).toHaveTextContent("Apparence"));
  });
});

describe("marketplace changes", () => {
  it("reads the installed content again when the marketplace catalog changes", async () => {
    const french = { name: "french", locale: "fr", nativeName: "Français", englishName: "French", missingKeys: [], sourceId: "acme", version: "1.0.0" };
    const api = bridge(view());
    let changed: () => void = () => undefined;
    const off = vi.fn();
    await ensureInstalledContent({ installedContent: api, gitMarketplace: { onCatalogChanged: (listener) => ((changed = listener), off) } });
    expect(isLocale("fr")).toBe(false);

    vi.mocked(api.installed).mockResolvedValue({ ok: true, content: view({ languages: [french] }) });
    changed();
    await waitFor(() => expect(isLocale("fr")).toBe(true));
    expect(api.installed).toHaveBeenCalledTimes(2);

    resetInstalledContentForTests();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("reloads installed templates when extension contributions change", async () => {
    const api = bridge(view());
    let changed: () => void = () => undefined;
    const off = vi.fn();
    await ensureInstalledContent({ installedContent: api, onPersonaPromptsUpdated: (listener) => ((changed = listener), off) });
    vi.mocked(api.installed).mockResolvedValue({ ok: true, content: view({ routineTemplates: [{
      id: "daily", title: "Daily review", description: "Review", trigger: "shutdown",
      execution: "notification-only", notificationTitle: "Review", packageName: "sampleportal",
      version: "1.0.0", sourceKind: "extension",
    }] }) });
    changed();
    await waitFor(() => expect(api.installed).toHaveBeenCalledTimes(2));
    resetInstalledContentForTests();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe("installed fonts", () => {
  it("declares @font-face rules only for ave-content font URLs", () => {
    const css = fontFaceCss([
      {
        name: "harbor-sans",
        family: "Harbor Sans",
        stack: "\"ave-font-harbor-sans\", system-ui",
        faces: [
          { url: "ave-content://t0123456789abcdef0123456789abcdef/font/harbor-sans/files/HarborSans.woff2", format: "woff2", weight: "100 900", style: "normal" },
          { url: "https://evil.example/x.woff2", format: "woff2", weight: "400", style: "normal" },
        ],
        sourceId: "acme",
        version: "1.0.0",
      },
    ]);
    expect(css).toBe(
      '@font-face { font-family: "ave-font-harbor-sans"; src: url("ave-content://t0123456789abcdef0123456789abcdef/font/harbor-sans/files/HarborSans.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }',
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
