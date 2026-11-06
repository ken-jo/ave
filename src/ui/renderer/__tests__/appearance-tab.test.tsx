import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { ThemeProvider } from "../theme/ThemeProvider.js";
import { SavedToastProvider } from "../context/SavedToastContext.js";
import { AppearanceTab } from "../tabs/AppearanceTab.js";
import { SCHEMES } from "../theme/index.js";
import { DEFAULT_APPEARANCE, type AppearanceSettings } from "../../../shared/appearance-settings.js";
import { applyInstalledContent, resetInstalledContentForTests } from "../installed-content.js";
import type { InstalledContentView } from "../../../shared/installed-content.js";
import { makeMockAveApi } from "../../../../test/renderer/mock-ave-api.js";
import { getLocale, setLocale } from "../../../i18n/runtime.js";

const FRENCH = { sourceId: "ave", version: "1.0.0", name: "french", locale: "fr", nativeName: "Français", englishName: "French", missingKeys: [] };

function install(content: Partial<InstalledContentView>) {
  const view = { languages: [], fonts: [], routineTemplates: [], broken: [], ...content } as InstalledContentView;
  applyInstalledContent(view, { installed: vi.fn(), languageMessages: vi.fn() } as never);
}

beforeEach(() => {
  const { api } = makeMockAveApi();
  (window as unknown as { aveApi: unknown }).aveApi = api;
});

afterEach(() => {
  resetInstalledContentForTests();
  document.documentElement.removeAttribute("data-scheme");
  document.documentElement.removeAttribute("data-shell");
  delete (window as unknown as Record<string, unknown>).aveApi;
  vi.unstubAllGlobals();
});

function renderAppearance(initial: AppearanceSettings = DEFAULT_APPEARANCE, onOpenMarketplace?: (filter: "language") => void) {
  return render(<SavedToastProvider value={() => {}}><ThemeProvider initialAppearance={initial}><AppearanceTab onOpenMarketplace={onOpenMarketplace} /></ThemeProvider></SavedToastProvider>);
}

describe("Appearance settings", () => {
  it("shows all curated schemes in system mode and selects one per appearance", () => {
    const { container } = renderAppearance();
    expect(container.querySelectorAll("[data-scheme-id]")).toHaveLength(SCHEMES.length);
    for (const id of [DEFAULT_APPEARANCE.darkScheme, DEFAULT_APPEARANCE.lightScheme]) {
      expect(container.querySelector(`[data-scheme-id="${id}"]`)).toHaveAttribute("aria-checked", "true");
    }
  });

  it("limits the picker to the chosen mode and applies a scheme immediately", async () => {
    const { container, getByTestId } = renderAppearance();
    fireEvent.click(getByTestId("appearance-mode-dark"));
    expect(container.querySelectorAll("[data-scheme-id]")).toHaveLength(6);
    const card = container.querySelector('[data-scheme-id="nord"]')!;
    fireEvent.click(card);
    await waitFor(() => expect(card).toHaveAttribute("aria-checked", "true"));
    expect(document.documentElement).toHaveAttribute("data-scheme", "nord");
    expect(document.documentElement).toHaveAttribute("data-shell", "dark");
  });

  it("lists an installed language with its marketplace badge", () => {
    install({ languages: [FRENCH] });
    const { getByTestId } = renderAppearance();
    expect(getByTestId("language-option-fr")).toHaveAttribute("data-marketplace-installed", "true");
    expect(getByTestId("appearance-tab:language-marketplace-badge:fr")).toHaveTextContent("마켓플레이스");
  });

  it("reflects a language installed while the tab is open", async () => {
    const { getByTestId, queryByTestId } = renderAppearance();
    expect(queryByTestId("language-option-fr")).toBeNull();
    act(() => install({ languages: [FRENCH] }));
    await waitFor(() => expect(getByTestId("language-option-fr")).toBeTruthy());
  });

  it("opens the language marketplace filter", () => {
    const onOpenMarketplace = vi.fn();
    const { getByTestId } = renderAppearance(DEFAULT_APPEARANCE, onOpenMarketplace);
    fireEvent.click(getByTestId("appearance-tab:marketplace-languages"));
    expect(onOpenMarketplace).toHaveBeenCalledWith("language");
  });

  it("offers Korean without an installed language package", () => {
    const originalLocale = getLocale();
    setLocale("en");
    try {
      const { getByTestId } = renderAppearance();
      expect(getByTestId("language-option-ko")).toHaveTextContent("한국어");
      expect(getByTestId("language-option-ko")).toHaveAttribute("data-marketplace-installed", "false");
      fireEvent.click(getByTestId("language-option-ko"));
      expect(getLocale()).toBe("ko");
    } finally {
      setLocale(originalLocale);
    }
  });
});
