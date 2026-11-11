import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThemeProvider, useTheme } from "../theme/ThemeProvider.js";
import { DEFAULT_APPEARANCE } from "../../../shared/appearance-settings.js";
import { applyAppearance } from "../theme/resolve-theme.js";
import { schemeToHostTokens } from "../theme/host-theme-tokens.js";
import { makeMockAveApi } from "../../../../test/renderer/mock-ave-api.js";

function Picker() {
  const theme = useTheme();
  return <>
    <span data-testid="scheme">{theme.appliedTheme.id}</span>
    <button onClick={() => theme.setMode("dark")}>Dark</button>
    <button onClick={() => theme.setScheme("dark", "nord")}>Nord</button>
  </>;
}

describe("appearance provider", () => {
  it("applies mode and scheme immediately and persists each choice", async () => {
    const { api } = makeMockAveApi({ settings: { appearance: { ...DEFAULT_APPEARANCE, mode: "light" } } });
    render(<ThemeProvider api={api as never} initialAppearance={{ ...DEFAULT_APPEARANCE, mode: "light" }}><Picker /></ThemeProvider>);
    expect(document.documentElement.getAttribute("data-scheme")).toBe("github-light");
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    fireEvent.click(screen.getByText("Dark"));
    expect(document.documentElement.getAttribute("data-scheme")).toBe("github-dark");
    expect(api.updateSettings).toHaveBeenCalledWith({ appearance: { mode: "dark" } });
    fireEvent.click(screen.getByText("Nord"));
    expect(document.documentElement.getAttribute("data-scheme")).toBe("nord");
    await waitFor(() => expect(api.notifyPluginTheme).toHaveBeenLastCalledWith(expect.objectContaining({ bundleId: "nord", shell: "dark" })));
  });

  it("follows OS changes using the saved scheme for each mode", () => {
    let listener: (() => void) | undefined;
    const query = { matches: false, addEventListener: (_event: string, callback: () => void) => { listener = callback; }, removeEventListener: vi.fn() };
    const media = vi.spyOn(window, "matchMedia").mockReturnValue(query as unknown as MediaQueryList);
    const view = render(<ThemeProvider initialAppearance={{ ...DEFAULT_APPEARANCE, darkScheme: "nord", lightScheme: "one-light" }}><Picker /></ThemeProvider>);
    expect(screen.getByTestId("scheme")).toHaveTextContent("one-light");
    act(() => { query.matches = true; listener!(); });
    expect(screen.getByTestId("scheme")).toHaveTextContent("nord");
    view.unmount();
    expect(query.removeEventListener).toHaveBeenCalled();
    media.mockRestore();
  });

  it("keeps cross-window colors and fonts synchronized", async () => {
    const { api } = makeMockAveApi();
    render(<ThemeProvider api={api as never}><Picker /></ThemeProvider>);
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await act(async () => {
      await api.updateSettings({ appearance: { ...DEFAULT_APPEARANCE, mode: "dark", darkScheme: "tokyo-night", font: { family: "Example Mono", sizeScale: 1 } } });
    });
    expect(screen.getByTestId("scheme")).toHaveTextContent("tokyo-night");
    expect(document.documentElement.style.getPropertyValue("--ave-font-family")).toBe("Example Mono");
    expect(document.documentElement.style.getPropertyValue("--ave-font-size-scale")).toBe("1");
  });

  it("applies the same color and font path before and after hydration", () => {
    const appearance = { ...DEFAULT_APPEARANCE, mode: "dark" as const, font: { family: "Example Sans", sizeScale: 1 as const } };
    const theme = applyAppearance(appearance);
    const first = document.documentElement.style.cssText;
    render(<ThemeProvider initialAppearance={appearance}><Picker /></ThemeProvider>);
    expect(document.documentElement.style.cssText).toBe(first);
    expect(schemeToHostTokens(theme)["--ave-bg"]).toMatch(/^hsl\(/);
    expect(schemeToHostTokens(theme)["--ave-motion-fast"]).toBe("120ms");
  });

  it("requires the provider at required consumers", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Picker />)).toThrow("must be used inside");
    error.mockRestore();
  });
});

describe("glass tint token", () => {
  it.each(["light", "dark"] as const)("writes percent cover for the %s shell including bare material", (mode) => {
    const root = document.documentElement;
    applyAppearance({ ...DEFAULT_APPEARANCE, mode });
    expect(root.style.getPropertyValue("--glass-tint-alpha")).toBe("0.4");
    applyAppearance({ ...DEFAULT_APPEARANCE, mode, glassTint: 0 });
    expect(root.style.getPropertyValue("--glass-tint-alpha")).toBe("0");
    applyAppearance({ ...DEFAULT_APPEARANCE, mode, glassTint: 100 });
    expect(root.style.getPropertyValue("--glass-tint-alpha")).toBe("1");
    applyAppearance({ ...DEFAULT_APPEARANCE, mode, glassTint: 50 });
    expect(root.style.getPropertyValue("--glass-tint-alpha")).toBe("0.5");
  });

  it("previews a tint without saving and saves it on commit", () => {
    const { api } = makeMockAveApi({ settings: { appearance: { ...DEFAULT_APPEARANCE, mode: "dark" } } });
    function Tint() {
      const theme = useTheme();
      return <>
        <button onClick={() => theme.setGlassTint(80, false)}>Preview</button>
        <button onClick={() => theme.setGlassTint(80, true)}>Commit</button>
      </>;
    }
    render(<ThemeProvider api={api as never} initialAppearance={{ ...DEFAULT_APPEARANCE, mode: "dark" }}><Tint /></ThemeProvider>);
    fireEvent.click(screen.getByText("Preview"));
    expect(document.documentElement.style.getPropertyValue("--glass-tint-alpha")).toBe("0.8");
    expect(api.updateSettings).not.toHaveBeenCalledWith({ appearance: { glassTint: 80 } });
    fireEvent.click(screen.getByText("Commit"));
    expect(api.updateSettings).toHaveBeenCalledWith({ appearance: { glassTint: 80 } });
  });
});
