import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor, cleanup } from "@testing-library/react";
import { ThemeProvider, useTheme } from "../ThemeProvider.js";
import { DEFAULT_BUNDLE_ID, setInstalledThemeBundles } from "../bundles/index.js";
import { moonstoneBundle } from "../bundles/moonstone.js";

// Every theme but Moonstone and Gallery is an installed package; these stand in for the ones used below.
const INSTALLED_THEMES = ["midnight", "violet-light", "tokyo-night"].map((id) => ({ ...moonstoneBundle, id, name: id }));

// `useTheme()` consumer that surfaces the effective bundleId as text so the test can assert what the provider initialised
// with.
function Probe() {
  const { bundleId } = useTheme();
  return <span data-testid="bundle">{bundleId}</span>;
}

beforeEach(() => {
  // Reset documentElement state between tests so attribute checks don't leak from one case into the next.
  document.documentElement.removeAttribute("data-theme-bundle");
  document.documentElement.removeAttribute("data-shell");
  document.documentElement.style.cssText = "";
  delete (window as { __aveInitialTheme?: unknown }).__aveInitialTheme;
  setInstalledThemeBundles(INSTALLED_THEMES);
});

afterEach(() => {
  setInstalledThemeBundles([]);
  // Each `render()` adds a fresh container to document.body; vitest doesn't auto-cleanup react-testing-library, so without
  // this every test would see prior tests' DOM and `getByTestId` would throw "found multiple".
  cleanup();
  delete (window as { __aveInitialTheme?: unknown }).__aveInitialTheme;
});

describe("ThemeProvider — initial theme (race-window-zero)", () => {
  it("reads window.__aveInitialTheme.bundleId when initialBundleId prop is omitted", () => {
    (window as { __aveInitialTheme: unknown }).__aveInitialTheme = {
      bundleId: "midnight",
      shell: "dark",
      tokens: {},
    };
    const { getByTestId } = render(
      <ThemeProvider><Probe /></ThemeProvider>
    );
    expect(getByTestId("bundle").textContent).toBe("midnight");
  });

  it("explicit initialBundleId prop overrides the global", () => {
    (window as { __aveInitialTheme: unknown }).__aveInitialTheme = {
      bundleId: "midnight",
      shell: "dark",
      tokens: {},
    };
    const { getByTestId } = render(
      <ThemeProvider initialBundleId="violet-light"><Probe /></ThemeProvider>
    );
    expect(getByTestId("bundle").textContent).toBe("violet-light");
  });

  it("falls back to DEFAULT_BUNDLE_ID when neither prop nor global is present", () => {
    const { getByTestId } = render(
      <ThemeProvider><Probe /></ThemeProvider>
    );
    // Pin the exact default — guards the chain `prop → global → DEFAULT`.
    expect(getByTestId("bundle").textContent).toBe(DEFAULT_BUNDLE_ID);
  });

  it("ignores a malformed bundleId in the global and falls back to DEFAULT_BUNDLE_ID", () => {
    (window as { __aveInitialTheme: unknown }).__aveInitialTheme = {
      bundleId: "Totally Not A Bundle",
      shell: "dark",
      tokens: {},
    };
    const { getByTestId } = render(
      <ThemeProvider><Probe /></ThemeProvider>
    );
    // `findBundle` rejects the unknown id → chain falls through to DEFAULT.
    expect(getByTestId("bundle").textContent).toBe(DEFAULT_BUNDLE_ID);
  });

  it("async settings hydrate later does not clobber the global-sourced initial (when values agree)", async () => {
    (window as { __aveInitialTheme: unknown }).__aveInitialTheme = {
      bundleId: "tokyo-night",
      shell: "dark",
      tokens: {},
    };
    const fakeApi = {
      getSettings: vi.fn().mockResolvedValue({
        appearance: { schemaVersion: 2, bundleId: "tokyo-night", followSystem: false },
      }),
      updateSettings: vi.fn(),
      notifyPluginTheme: vi.fn().mockResolvedValue(undefined),
      // ThemeProvider subscribes to cross-window settings broadcasts to stay in sync with sibling BrowserWindows. The mock
      // returns a no-op cleanup.
      onSettingsUpdated: vi.fn(() => () => {}),
    };
    const { getByTestId } = render(
      <ThemeProvider api={fakeApi as never}><Probe /></ThemeProvider>
    );
    await waitFor(() => {
      expect(fakeApi.getSettings).toHaveBeenCalled();
    });
    // Still tokyo-night — hydrate from settings agreed with the global.
    expect(getByTestId("bundle").textContent).toBe("tokyo-night");
  });
});
