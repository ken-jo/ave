/**
 * AppearanceTab v2 — bundle picker tests.
 *
 * The tab shows one card per compiled bundle and per installed theme package
 * in a single grid.
 * Clicking a card sets the active bundle and writes data-theme-bundle to <html>.
 *
 * followSystem toggle is shown only when the violet pair (violet-light / violet-dark)
 * is selected; hidden otherwise.
 *
 * The external URL (webView) section is unchanged from v1.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, configure, fireEvent, render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import { AppearanceTab } from "../tabs/AppearanceTab.js";
import { BUNDLES, DEFAULT_BUNDLE_ID } from "../theme/index.js";
import { moonstoneBundle } from "../theme/bundles/moonstone.js";
import { applyInstalledContent, resetInstalledContentForTests } from "../installed-content.js";
import type { InstalledContentView, InstalledThemeView } from "../../../shared/installed-content.js";
import { makeMockAveApi } from "../../../../test/renderer/mock-ave-api.js";
import { getLocale, setLocale } from "../../../i18n/runtime.js";

// ThemeProvider resolves the selected theme after the installed content loads.
// In isolation these tests pass well under the 1000ms default, but a saturated
// full-suite run can starve the worker long enough to exceed it. Give async
// assertions headroom so timing, not correctness, stops deciding the result.
configure({ asyncUtilTimeout: 5000 });

const FROM = { sourceId: "ave", version: "1.0.0" };

function theme(id: string, name: string, shell: "light" | "dark", highContrast = false): InstalledThemeView {
  return { ...FROM, id, name, description: `${name} theme.`, shell, highContrast, tokens: moonstoneBundle.tokens, surfaces: {} } as unknown as InstalledThemeView;
}

/** Every theme but Moonstone and Gallery is an installed package; these stand in for the ones used below. */
const THEMES = [
  theme("tokyo-night", "Tokyo Night", "dark"),
  theme("violet-light", "Violet Light", "light"),
  theme("violet-dark", "Violet Dark", "dark"),
  theme("high-contrast", "High Contrast", "dark", true),
];
// Not Korean: an installed `ko` package would replace the compiled catalog this suite renders in.
const FRENCH = { ...FROM, name: "french", locale: "fr", nativeName: "Français", englishName: "French", missingKeys: [] };

function install(content: Partial<InstalledContentView>) {
  const view = { themes: [], languages: [], fonts: [], broken: [], ...content } as InstalledContentView;
  applyInstalledContent(view, { installed: vi.fn(), languageMessages: vi.fn() } as never);
}

afterEach(() => {
  resetInstalledContentForTests();
  document.documentElement.removeAttribute("data-theme-bundle");
  document.documentElement.removeAttribute("data-shell");
  Array.from(document.documentElement.classList)
    .filter((c) => c.startsWith("ave-bundle-"))
    .forEach((c) => document.documentElement.classList.remove(c));
  delete (window as unknown as Record<string, unknown>).aveApi;
  vi.unstubAllGlobals();
});

function renderWithBundle(initialBundleId: string = DEFAULT_BUNDLE_ID, onOpenMarketplace?: (filter: "theme" | "language") => void) {
  return render(
    <ThemeProvider initialBundleId={initialBundleId}>
      <AppearanceTab onOpenMarketplace={onOpenMarketplace} />
    </ThemeProvider>,
  );
}

describe("AppearanceTab — bundle card grid", () => {
  it("renders exactly one card per compiled bundle when no theme is installed", () => {
    const { getAllByRole } = renderWithBundle();
    // All cards have role="radio" with aria-label "테마: <name>"
    const cards = getAllByRole("radio").filter((el) =>
      el.getAttribute("aria-label")?.startsWith("테마:"),
    );
    expect(cards).toHaveLength(BUNDLES.length);
  });

  it("renders a card for each compiled bundle", () => {
    const { getByRole, queryByRole } = renderWithBundle();
    for (const bundle of BUNDLES) {
      expect(getByRole("radio", { name: `테마: ${bundle.name}` })).toBeTruthy();
    }
    expect(queryByRole("radio", { name: /테마: Forest/ })).toBeNull();
  });

  it("the default bundle card has aria-checked=true", () => {
    const { getByRole } = renderWithBundle();
    const card = getByRole("radio", { name: /테마: Moonstone/ });
    expect(card.getAttribute("aria-checked")).toBe("true");
  });

  it("other cards have aria-checked=false initially", () => {
    const { getByRole } = renderWithBundle();
    const gallery = getByRole("radio", { name: /테마: Gallery/ });
    expect(gallery.getAttribute("aria-checked")).toBe("false");
  });

  it("clicking a bundle card writes data-theme-bundle to <html>", async () => {
    const { getByRole } = renderWithBundle();
    fireEvent.click(getByRole("radio", { name: /테마: Gallery/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("gallery");
    });
  });

  it("lists installed theme packages with their marketplace badge, and the selected one checked", async () => {
    install({ themes: THEMES });
    const { getByRole, getByTestId } = renderWithBundle("violet-dark");
    await waitFor(() => {
      expect(getByRole("radio", { name: /테마: Violet Dark/ }).getAttribute("aria-checked")).toBe("true");
    });
    expect(getByRole("radio", { name: /테마: Tokyo Night/ }).getAttribute("aria-checked")).toBe("false");
    expect(getByTestId("appearance-tab:theme-marketplace-badge:tokyo-night")).toHaveTextContent("마켓플레이스");
  });

  it("lists an installed language package with its marketplace badge", () => {
    install({ languages: [FRENCH] });
    const { getByTestId } = renderWithBundle();
    expect(getByTestId("language-option-fr")).toHaveAttribute("data-marketplace-installed", "true");
    expect(getByTestId("appearance-tab:language-marketplace-badge:fr")).toHaveTextContent("마켓플레이스");
  });

  it("reflects theme and language packages installed while the tab is open", async () => {
    const { getByRole, getByTestId, queryByRole, queryByTestId } = renderWithBundle();
    expect(queryByRole("radio", { name: /테마: Tokyo Night/ })).toBeNull();
    expect(queryByTestId("language-option-fr")).toBeNull();

    act(() => {
      install({ themes: THEMES, languages: [FRENCH] });
    });

    await waitFor(() => {
      expect(getByRole("radio", { name: /테마: Tokyo Night/ })).toBeTruthy();
      expect(getByTestId("language-option-fr")).toBeTruthy();
    });
  });

  it("opens Marketplace filters from theme and language CTAs", () => {
    const onOpenMarketplace = vi.fn();
    const { getByTestId } = renderWithBundle(DEFAULT_BUNDLE_ID, onOpenMarketplace);

    fireEvent.click(getByTestId("appearance-tab:marketplace-languages"));
    expect(onOpenMarketplace).toHaveBeenLastCalledWith("language");

    fireEvent.click(getByTestId("appearance-tab:marketplace-themes"));
    expect(onOpenMarketplace).toHaveBeenLastCalledWith("theme");
  });

  it("recommends the matching system language pack without installing it", async () => {
    const originalLanguage = navigator.language;
    Object.defineProperty(navigator, "language", {
      configurable: true,
      value: "ko-KR",
    });
    // The renderer suite renders in Korean; a Korean UI has nothing to
    // recommend, so this scenario runs under the English default.
    const originalLocale = getLocale();
    setLocale("en");
    const onOpenMarketplace = vi.fn();
    try {
      const { api } = makeMockAveApi();
      (window as unknown as { aveApi: unknown }).aveApi = api;

      const { getByTestId, queryByTestId } = renderWithBundle(DEFAULT_BUNDLE_ID, onOpenMarketplace);
      await waitFor(() => expect(api.getSettings).toHaveBeenCalled());

      expect(queryByTestId("language-option-ko")).toBeNull();
      expect(getByTestId("appearance-tab:language-recommendation"))
        .toHaveTextContent("Korean language pack matches your system language.");
      fireEvent.click(getByTestId("appearance-tab:language-recommendation-open:ko"));
      expect(onOpenMarketplace).toHaveBeenCalledWith("language");
    } finally {
      setLocale(originalLocale);
      Object.defineProperty(navigator, "language", {
        configurable: true,
        value: originalLanguage,
      });
    }
  });

  it("clicking back to a compiled theme writes data-theme-bundle=gallery", async () => {
    install({ themes: THEMES });
    const { getByRole } = renderWithBundle("violet-dark");
    fireEvent.click(getByRole("radio", { name: /테마: Gallery/ }));
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("gallery");
    });
  });

  it("checks an installed high-contrast theme when it is selected", async () => {
    install({ themes: THEMES });
    const { getByRole } = renderWithBundle("high-contrast");
    await waitFor(() => {
      expect(getByRole("radio", { name: /테마: High Contrast/ }).getAttribute("aria-checked")).toBe("true");
    });
  });

  it("selected card updates aria-checked after click", async () => {
    install({ themes: THEMES });
    const { getByRole } = renderWithBundle("tokyo-night");
    const gallery = getByRole("radio", { name: /테마: Gallery/ });
    fireEvent.click(gallery);
    await waitFor(() => {
      expect(gallery.getAttribute("aria-checked")).toBe("true");
    });
    expect(getByRole("radio", { name: /테마: Tokyo Night/ }).getAttribute("aria-checked")).toBe("false");
  });
});

describe("AppearanceTab — followSystem toggle (violet pair only)", () => {
  beforeEach(() => {
    install({ themes: THEMES });
  });

  it("followSystem toggle is hidden when a non-violet bundle is active", () => {
    const { queryByTestId } = renderWithBundle("tokyo-night");
    expect(queryByTestId("follow-system-toggle")).toBeNull();
  });

  it("followSystem toggle is shown when violet-light is active", async () => {
    const { getByTestId } = renderWithBundle("violet-light");
    await waitFor(() => {
      expect(getByTestId("follow-system-toggle")).toBeTruthy();
    });
  });

  it("followSystem toggle is shown when violet-dark is active", async () => {
    const { getByTestId } = renderWithBundle("violet-dark");
    // Already on violet-dark — toggle should be visible
    await waitFor(() => {
      expect(getByTestId("follow-system-toggle")).toBeTruthy();
    });
  });

  it("high-contrast card has no followSystem toggle", async () => {
    const { queryByTestId } = renderWithBundle("high-contrast");
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("high-contrast");
    });
    expect(queryByTestId("follow-system-toggle")).toBeNull();
  });
});
