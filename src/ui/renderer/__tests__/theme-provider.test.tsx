import { ok as assertPresent } from "node:assert/strict";
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
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
  it("returns failure and restores a refused mode instead of reporting it saved", async () => {
    const { api } = makeMockAveApi({ settings: { appearance: { ...DEFAULT_APPEARANCE, mode: "light" } } });
    api.updateSettings.mockResolvedValueOnce({ ok: false, error: "invalid-args" });
    const { result } = renderHook(() => useTheme(), { wrapper: ({ children }) => <ThemeProvider api={api as never} initialAppearance={{ ...DEFAULT_APPEARANCE, mode: "light" }}>{children}</ThemeProvider> });
    await act(async () => { expect(await result.current.setMode("dark")).toEqual({ ok: false }); });
    expect(result.current.mode).toBe("light");
    expect(result.current.persistenceError).toBeTruthy();
    expect(document.documentElement.getAttribute("data-scheme")).toBe("github-light");
  });

  it("restores committed tint after a preview commit is refused", async () => {
    const { api } = makeMockAveApi({ settings: { appearance: DEFAULT_APPEARANCE } });
    api.updateSettings.mockResolvedValueOnce({ ok: false, error: "invalid-args" });
    const { result } = renderHook(() => useTheme(), { wrapper: ({ children }) => <ThemeProvider api={api as never} initialAppearance={DEFAULT_APPEARANCE}>{children}</ThemeProvider> });
    await act(async () => { expect(await result.current.setGlassTint(80, false)).toEqual({ ok: true }); });
    expect(result.current.appearance.glassTint).toBe(80);
    expect(api.updateSettings).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.setGlassTint(80, true)).toEqual({ ok: false }); });
    expect(result.current.appearance.glassTint).toBe(DEFAULT_APPEARANCE.glassTint);
  });

  it("restores the latest broadcast field and keeps unrelated appearance edits", async () => {
    const { api } = makeMockAveApi({ settings: { appearance: { ...DEFAULT_APPEARANCE, mode: "light" } } });
    let fail!: (value: { ok: false; error: string }) => void;
    api.updateSettings.mockImplementationOnce(() => new Promise((resolve) => { fail = resolve; }));
    const { result } = renderHook(() => useTheme(), { wrapper: ({ children }) => <ThemeProvider api={api as never} initialAppearance={{ ...DEFAULT_APPEARANCE, mode: "light" }}>{children}</ThemeProvider> });
    let saving!: ReturnType<typeof result.current.setMode>;
    act(() => { saving = result.current.setMode("dark"); });
    const snapshot = await api.getSettings();
    const [subscription] = api.onSettingsUpdated.mock.calls;
    assertPresent(subscription);
    const [broadcast] = subscription;
    act(() => broadcast({ ...snapshot, appearance: { ...DEFAULT_APPEARANCE, mode: "system", font: { ...DEFAULT_APPEARANCE.font, family: "Example Sans" } } }));
    expect(result.current.mode).toBe("dark");
    await act(async () => { fail({ ok: false, error: "invalid-args" }); await saving; });
    expect(result.current.mode).toBe("system");
    expect(result.current.appearance.font?.family).toBe("Example Sans");
  });

  it("keeps a newer confirmed mode when an older write later fails", async () => {
    const { api } = makeMockAveApi({ settings: { appearance: { ...DEFAULT_APPEARANCE, mode: "light" } } });
    let fail!: (value: { ok: false; error: string }) => void;
    const snapshot = await api.getSettings();
    api.updateSettings.mockImplementationOnce(() => new Promise((resolve) => { fail = resolve; }))
      .mockResolvedValueOnce({ ...snapshot, appearance: { ...DEFAULT_APPEARANCE, mode: "system" } });
    const { result } = renderHook(() => useTheme(), { wrapper: ({ children }) => <ThemeProvider api={api as never} initialAppearance={{ ...DEFAULT_APPEARANCE, mode: "light" }}>{children}</ThemeProvider> });
    let older!: ReturnType<typeof result.current.setMode>;
    act(() => { older = result.current.setMode("dark"); });
    await act(async () => { expect(await result.current.setMode("system")).toEqual({ ok: true }); });
    await act(async () => { fail({ ok: false, error: "invalid-args" }); await older; });
    expect(result.current.mode).toBe("system");
    expect(result.current.persistenceError).toBeNull();
  });

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
    act(() => { query.matches = true; assertPresent(listener); listener(); });
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
