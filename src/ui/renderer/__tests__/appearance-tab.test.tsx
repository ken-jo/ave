import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
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

function install(content: Partial<InstalledContentView> & { languages?: typeof FRENCH[] }) {
  const view = { languages: [], fonts: [], routineTemplates: [], broken: [], ...content } as InstalledContentView;
  applyInstalledContent(view);
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

function renderAppearance(initial: AppearanceSettings = DEFAULT_APPEARANCE) {
  return render(<SavedToastProvider value={() => {}}><ThemeProvider initialAppearance={initial}><AppearanceTab /></ThemeProvider></SavedToastProvider>);
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

  it("ignores a legacy installed language in the picker", () => {
    install({ languages: [FRENCH] });
    const { queryByTestId } = renderAppearance();
    expect(queryByTestId("language-option-fr")).toBeNull();
    expect(queryByTestId("appearance-tab:language-marketplace-badge:fr")).toBeNull();
  });

  it("keeps compiled locale options after legacy content is reapplied", () => {
    const { getByTestId, queryByTestId } = renderAppearance();
    act(() => install({ languages: [FRENCH] }));
    expect(queryByTestId("language-option-fr")).toBeNull();
    expect(getByTestId("language-option-ko")).toBeTruthy();
  });

  it("does not offer a marketplace language entry point", () => {
    const { queryByTestId, container } = renderAppearance();
    expect(queryByTestId("appearance-tab:marketplace-languages")).toBeNull();
    expect(Array.from(container.querySelectorAll('[data-testid^="language-option-"]')).map((radio) => radio.getAttribute("data-testid"))).toEqual(["language-option-en", "language-option-ko"]);
    expect(container.querySelector('[data-testid="language-option-en"]')).toHaveAttribute("role", "radio");
    expect(container.querySelector('[data-testid="language-option-ko"]')).toHaveAttribute("role", "radio");
    expect(container.querySelector('[data-testid^="appearance-tab:language-marketplace-badge:"]')).toBeNull();
  });

  it("offers Korean without an installed language package", () => {
    const originalLocale = getLocale();
    setLocale("en");
    try {
      const { getByTestId } = renderAppearance();
      expect(getByTestId("language-option-ko")).toHaveTextContent("한국어");
      expect(getByTestId("language-option-ko")).not.toHaveAttribute("data-marketplace-installed");
      fireEvent.click(getByTestId("language-option-ko"));
      expect(getLocale()).toBe("ko");
    } finally {
      setLocale(originalLocale);
    }
  });
});

it("moves one tab stop through mode, scheme and font radio groups with the keyboard", async () => {
  const { getByRole, getByTestId, container } = renderAppearance();
  const mode = getByRole("radiogroup", { name: "화면 모드" });
  expect(within(mode).getAllByRole("radio").filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
  const system = getByTestId("appearance-mode-system");
  system.focus();
  fireEvent.keyDown(system, { key: "ArrowRight" });
  expect(getByTestId("appearance-mode-dark")).toHaveFocus();
  expect(getByTestId("appearance-mode-dark")).toHaveAttribute("aria-checked", "true");
  expect(getByTestId("appearance-mode-dark")).toHaveAttribute("tabindex", "0");
  const scheme = container.querySelector('[data-scheme-id="github-dark"]') as HTMLButtonElement;
  scheme.focus();
  fireEvent.keyDown(scheme, { key: "End" });
  const last = container.querySelector('[data-scheme-id="solarized-dark"]');
  expect(last).toHaveFocus();
  expect(last).toHaveAttribute("aria-checked", "true");
  fireEvent.keyDown(last!, { key: "ArrowRight" });
  expect(scheme).toHaveFocus();
  const families = getByTestId("font-family-presets");
  await waitFor(() => expect(within(families).getAllByRole("radio").some((radio) => radio.getAttribute("aria-checked") === "true")).toBe(true));
  const first = within(families).getAllByRole("radio")[0]!;
  first.focus();
  fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(within(families).getAllByRole("radio")[1]).toHaveFocus();
  expect(within(families).getAllByRole("radio").filter((radio) => radio.tabIndex === 0)).toHaveLength(1);
  const sizes = getByTestId("font-size-scale");
  const activeSize = within(sizes).getAllByRole("radio").find((radio) => radio.tabIndex === 0)!;
  activeSize.focus();
  fireEvent.keyDown(activeSize, { key: "Home" });
  expect(within(sizes).getAllByRole("radio")[0]).toHaveFocus();
  expect(within(sizes).getAllByRole("radio")[0]).toHaveAttribute("aria-checked", "true");
});

describe("Window glass tint", () => {
  function stubReducedTransparency(reduced: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-transparency") ? reduced : false,
      media: query, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
    }));
  }
  function renderOnMac(initial: AppearanceSettings, glass: boolean) {
    (window as unknown as { avePlatform: unknown }).avePlatform = { isDarwin: true };
    if (glass) document.documentElement.setAttribute("data-glass", "");
    const { api } = makeMockAveApi({ settings: { appearance: initial } });
    const view = render(<SavedToastProvider value={() => {}}><ThemeProvider api={api as never} initialAppearance={initial}><AppearanceTab /></ThemeProvider></SavedToastProvider>);
    return { api, view };
  }
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).avePlatform;
    document.documentElement.removeAttribute("data-glass");
  });

  it("is absent off macOS", () => {
    const { queryByTestId } = renderAppearance();
    expect(queryByTestId("appearance-glass-tint")).toBeNull();
  });

  it("previews while dragging and saves when the drag ends", () => {
    stubReducedTransparency(false);
    const { api, view } = renderOnMac({ ...DEFAULT_APPEARANCE, mode: "light" }, true);
    const slider = view.getByRole("slider", { name: "창 유리 틴트" }) as HTMLInputElement;
    expect(slider.disabled).toBe(false);
    expect(slider.value).toBe("0");
    fireEvent.change(slider, { target: { value: "90" } });
    expect(document.documentElement.style.getPropertyValue("--glass-tint-alpha")).toBe("0.975");
    expect(api.updateSettings).not.toHaveBeenCalledWith({ appearance: { glassTint: 90 } });
    fireEvent.pointerUp(slider);
    // The same gesture's lost capture finds nothing pending: one save, not two.
    fireEvent.lostPointerCapture(slider);
    expect(api.updateSettings.mock.calls.filter(([patch]) => (patch as { appearance?: { glassTint?: number } }).appearance?.glassTint === 90)).toHaveLength(1);
  });

  it.each([
    ["pointercancel", (el: HTMLElement) => fireEvent.pointerCancel(el)],
    ["lostpointercapture", (el: HTMLElement) => fireEvent.lostPointerCapture(el)],
    ["keyup", (el: HTMLElement) => fireEvent.keyUp(el, { key: "ArrowRight" })],
    ["blur", (el: HTMLElement) => fireEvent.blur(el)],
  ])("saves a previewed tint when the gesture ends in %s", (_name, end) => {
    stubReducedTransparency(false);
    const { api, view } = renderOnMac({ ...DEFAULT_APPEARANCE, mode: "dark" }, true);
    const slider = view.getByRole("slider", { name: "창 유리 틴트" });
    fireEvent.change(slider, { target: { value: "40" } });
    end(slider);
    expect(api.updateSettings).toHaveBeenCalledWith({ appearance: { glassTint: 40 } });
  });

  it("saves nothing for a key that moved nothing", () => {
    stubReducedTransparency(false);
    const { api, view } = renderOnMac(DEFAULT_APPEARANCE, true);
    fireEvent.keyUp(view.getByRole("slider", { name: "창 유리 틴트" }), { key: "Tab" });
    expect(api.updateSettings).not.toHaveBeenCalledWith(expect.objectContaining({ appearance: expect.objectContaining({ glassTint: expect.anything() }) }));
  });

  it("is disabled with the reason when reduce transparency is on", () => {
    stubReducedTransparency(true);
    const { view } = renderOnMac(DEFAULT_APPEARANCE, true);
    expect((view.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
    expect(view.getByText(/투명도 줄이기/)).toBeTruthy();
  });

  it("is disabled when the window was created without the material", () => {
    stubReducedTransparency(false);
    const { view } = renderOnMac(DEFAULT_APPEARANCE, false);
    expect((view.getByRole("slider") as HTMLInputElement).disabled).toBe(true);
  });
});
