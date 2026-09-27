/**
 * Theme system v2 — ThemeProvider unit tests.
 *
 * Covers:
 *  - applyBundleToDocument() writes data-theme-bundle + data-shell + class
 *  - resolveSystemPair() picks the theme of a pair whose shell matches matchMedia
 *  - <ThemeProvider> hydrates bundleId from settings (v2 shape)
 *  - setBundle persists + updates DOM
 *  - followSystem (a theme with a declared pair) persists + tracks OS scheme
 *  - bundleToPluginTokens() returns correct token map
 *  - useTheme outside provider throws
 *  - useOptionalTheme returns null without provider
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { ThemeProvider, useTheme, useOptionalTheme } from "../theme/ThemeProvider.js";
import { applyBundleToDocument, resolveSystemPair } from "../theme/resolve-theme.js";
import { bundleToPluginTokens } from "../theme/plugin-token-map.js";
import {
  findBundle,
  DEFAULT_BUNDLE_ID,
  setInstalledThemeBundles,
  type ThemeBundle,
} from "../theme/bundles/index.js";
import { moonstoneBundle } from "../theme/bundles/moonstone.js";
import { applyInstalledContent, resetInstalledContentForTests } from "../installed-content.js";
import type { InstalledContentView } from "../../../shared/installed-content.js";
import { makeMockAveApi, MOCK_DEFAULT_SETTINGS } from "../../../../test/renderer/mock-ave-api.js";

/** Every theme but Moonstone and Gallery is an installed package; these stand in for the ones used below. */
function installed(id: string, shell: "light" | "dark", tokens: Partial<ThemeBundle["tokens"]> = {}, highContrast = false, pair?: string): ThemeBundle {
  return { ...moonstoneBundle, id, name: id, shell, highContrast, tokens: { ...moonstoneBundle.tokens, ...tokens }, ...(pair ? { pair } : {}) };
}
const INSTALLED_THEMES: ThemeBundle[] = [
  installed("tokyo-night", "dark"),
  installed("midnight", "dark"),
  installed("forest", "light", { background: "0 0% 100%" }),
  installed("violet-light", "light", {}, false, "violet-dark"),
  installed("violet-dark", "dark", { primary: "253 100% 65%" }, false, "violet-light"),
  // A pair whose other half is not installed, and one whose pair has the same shell.
  installed("lonely-dark", "dark", {}, false, "lonely-light"),
  installed("dusk", "dark", {}, false, "midnight"),
  installed("high-contrast", "dark", { primary: "60 100% 50%" }, true),
];

afterEach(() => {
  document.documentElement.removeAttribute("data-theme-bundle");
  document.documentElement.removeAttribute("data-shell");
  // Remove all ave-bundle-* classes
  Array.from(document.documentElement.classList)
    .filter((c) => c.startsWith("ave-bundle-"))
    .forEach((c) => document.documentElement.classList.remove(c));
  vi.unstubAllGlobals();
  resetInstalledContentForTests();
});

beforeEach(() => {
  setInstalledThemeBundles(INSTALLED_THEMES);
});

describe("applyBundleToDocument", () => {
  it("writes data-theme-bundle and data-shell", () => {
    const bundle = findBundle("tokyo-night")!;
    applyBundleToDocument(bundle);
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("tokyo-night");
    expect(document.documentElement.getAttribute("data-shell")).toBe("dark");
  });

  it("adds ave-bundle-<id> class", () => {
    const bundle = findBundle("forest")!;
    applyBundleToDocument(bundle);
    expect(document.documentElement.classList.contains("ave-bundle-forest")).toBe(true);
  });

  it("removes prior ave-bundle-* class when switching", () => {
    applyBundleToDocument(findBundle("tokyo-night")!);
    applyBundleToDocument(findBundle("forest")!);
    expect(document.documentElement.classList.contains("ave-bundle-tokyo-night")).toBe(false);
    expect(document.documentElement.classList.contains("ave-bundle-forest")).toBe(true);
  });

  it("sets data-shell=light for light bundles", () => {
    applyBundleToDocument(findBundle("violet-light")!);
    expect(document.documentElement.getAttribute("data-shell")).toBe("light");
  });
});

describe("resolveSystemPair", () => {
  const dark = { id: "harbor-dark", shell: "dark" as const };
  const light = { id: "harbor-light", shell: "light" as const };

  it("returns the light theme of the pair when prefers-color-scheme: light matches", () => {
    const win = { matchMedia: () => ({ matches: true } as MediaQueryList) } as unknown as Window;
    expect(resolveSystemPair(dark, light, win)).toBe("harbor-light");
    expect(resolveSystemPair(light, dark, win)).toBe("harbor-light");
  });

  it("returns the dark theme of the pair when prefers-color-scheme: light does not match", () => {
    const win = { matchMedia: () => ({ matches: false } as MediaQueryList) } as unknown as Window;
    expect(resolveSystemPair(light, dark, win)).toBe("harbor-dark");
  });

  it("returns the dark theme when matchMedia is unavailable", () => {
    expect(resolveSystemPair(light, dark, undefined)).toBe("harbor-dark");
  });
});

describe("bundleToPluginTokens", () => {
  it("tokyo-night bundle — returns full --ave-* token map with correct key count", () => {
    const bundle = findBundle("tokyo-night")!;
    const tokens = bundleToPluginTokens(bundle);
    // Should have at least 20 keys (invariant + bundle-specific)
    expect(Object.keys(tokens).length).toBeGreaterThanOrEqual(20);
    expect(typeof tokens["--ave-bg"]).toBe("string");
    expect(tokens["--ave-bg"]).toMatch(/^hsl\(/);
    expect(tokens["--ave-radius"]).toBe("0.6rem");
  });

  it("violet-dark — primary maps to vivid purple", () => {
    const bundle = findBundle("violet-dark")!;
    const tokens = bundleToPluginTokens(bundle);
    expect(tokens["--ave-primary"]).toContain("253");  // hsl(253, 100%, 65%)
  });

  it("high-contrast — primary is yellow", () => {
    const bundle = findBundle("high-contrast")!;
    const tokens = bundleToPluginTokens(bundle);
    expect(tokens["--ave-primary"]).toContain("60");  // hsl(60, 100%, 50%)
  });

  it("forest bundle — bg is white (light shell)", () => {
    const bundle = findBundle("forest")!;
    const tokens = bundleToPluginTokens(bundle);
    // forest background = "0 0% 100%" → hsl(0, 0%, 100%)
    expect(tokens["--ave-bg"]).toContain("100%");
  });
});

describe("<ThemeProvider>", () => {
  function Probe({ onValue }: { onValue: (v: ReturnType<typeof useTheme>) => void }) {
    const v = useTheme();
    useEffect(() => { onValue(v); }, [v, onValue]);
    return null;
  }

  it("hydrates bundleId from api.getSettings() on mount (v2 shape)", async () => {
    const { api } = makeMockAveApi({
      settings: {
        ...MOCK_DEFAULT_SETTINGS,
        appearance: { schemaVersion: 2, bundleId: "midnight" },
      },
    });
    const seen: string[] = [];
    render(
      <ThemeProvider api={api as never}>
        <Probe onValue={(v) => seen.push(v.bundleId)} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(seen).toContain("midnight");
    });
    expect(api.getSettings).toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("midnight");
  });

  it("falls back to DEFAULT_BUNDLE_ID when settings load fails", async () => {
    const { api } = makeMockAveApi();
    api.getSettings.mockRejectedValueOnce(new Error("boom"));
    let observed: string | null = null;
    render(
      <ThemeProvider api={api as never}>
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(observed).not.toBeNull();
    });
    expect(observed).toBe(DEFAULT_BUNDLE_ID);
  });

  it("setBundle persists via api.updateSettings and updates DOM", async () => {
    const { api } = makeMockAveApi();
    let setter: ((id: string) => void) | null = null;
    function Capture() {
      const { setBundle } = useTheme();
      setter = setBundle;
      return null;
    }
    render(
      <ThemeProvider api={api as never}>
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    act(() => { setter!("midnight"); });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("midnight");
    });
    expect(api.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: expect.objectContaining({ bundleId: "midnight" }) }),
    );
  });

  it("applies settings:update broadcasts from another window without restart", async () => {
    const { api } = makeMockAveApi({
      settings: {
        ...MOCK_DEFAULT_SETTINGS,
        appearance: { schemaVersion: 2, bundleId: "tokyo-night" },
      },
    });
    let observed: string | null = null;
    render(
      <ThemeProvider api={api as never}>
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(observed).toBe("tokyo-night");
    });

    await act(async () => {
      await api.updateSettings({ appearance: { schemaVersion: 2, bundleId: "forest" } });
    });

    await waitFor(() => {
      expect(observed).toBe("forest");
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("forest");
    });
  });

  it("persistence roundtrip: set midnight → simulated reload → still midnight", async () => {
    let stored: { schemaVersion: 2; bundleId: string } = { schemaVersion: 2, bundleId: "tokyo-night" };
    const settingsBacking = {
      ...MOCK_DEFAULT_SETTINGS,
      appearance: stored,
    };
    const { api: api1 } = makeMockAveApi({ settings: settingsBacking });
    api1.updateSettings.mockImplementation(async (patch: any) => {
      if (patch.appearance) stored = { ...stored, ...patch.appearance };
      return { ...settingsBacking, appearance: stored };
    });
    let setter: ((id: string) => void) | null = null;
    function Capture() {
      const { setBundle } = useTheme();
      setter = setBundle;
      return null;
    }
    const first = render(
      <ThemeProvider api={api1 as never}>
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    act(() => { setter!("midnight"); });
    await waitFor(() => {
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("midnight");
    });
    expect(stored.bundleId).toBe("midnight");
    first.unmount();

    const { api: api2 } = makeMockAveApi({
      settings: { ...settingsBacking, appearance: stored },
    });
    let observed: string | null = null;
    render(
      <ThemeProvider api={api2 as never}>
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );
    await waitFor(() => {
      expect(observed).toBe("midnight");
    });
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("midnight");
  });

  it("uses initialBundleId when no api is provided", () => {
    let observed: string | null = null;
    render(
      <ThemeProvider initialBundleId="high-contrast">
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );
    expect(observed).toBe("high-contrast");
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("high-contrast");
  });

  it("falls back to the default bundle when the selected theme is not installed", async () => {
    setInstalledThemeBundles([]);

    let observed: string | null = null;
    render(
      <ThemeProvider initialBundleId="tokyo-night">
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );

    await waitFor(() => {
      expect(observed).toBe(DEFAULT_BUNDLE_ID);
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe(DEFAULT_BUNDLE_ID);
    });
  });

  it("applies the saved theme once its package is installed after the window started", async () => {
    // The first boot after the upgrade: `nord` is selected, and its package arrives with the migration.
    setInstalledThemeBundles([]);
    const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, appearance: { schemaVersion: 2, bundleId: "nord" } } });

    let observed: string | null = null;
    render(
      <ThemeProvider api={api as never}>
        <Probe onValue={(v) => { observed = v.bundleId; }} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme-bundle")).toBe(DEFAULT_BUNDLE_ID));

    const nord = installed("nord", "dark");
    const view = { themes: [{ ...nord, preview: null }], languages: [], fonts: [], routineTemplates: [], broken: [] } as unknown as InstalledContentView;
    act(() => {
      applyInstalledContent(view, { installed: vi.fn(), languageMessages: vi.fn() } as never);
    });

    await waitFor(() => {
      expect(observed).toBe("nord");
      expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("nord");
    });
  });

  it("useTheme throws when called outside the provider", () => {
    function BadConsumer() {
      useTheme();
      return null;
    }
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<BadConsumer />)).toThrow(/ThemeProvider/);
    errSpy.mockRestore();
  });

  it("useOptionalTheme returns null without a provider (escape hatch)", () => {
    let observed: unknown = "untouched";
    function OptConsumer() {
      observed = useOptionalTheme();
      return null;
    }
    render(<OptConsumer />);
    expect(observed).toBeNull();
  });

  it("resolved property reflects active bundle shell", async () => {
    let observed: string | null = null;
    function Capture() {
      const { resolved } = useTheme();
      useEffect(() => { observed = resolved; }, [resolved]);
      return null;
    }
    render(
      <ThemeProvider initialBundleId="forest">
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(observed).toBe("light"); });
  });

  it("setFollowSystem persists and is togglable", async () => {
    const { api } = makeMockAveApi();
    let setter: ((next: boolean) => void) | null = null;
    let observed: boolean | null = null;
    function Capture() {
      const { setFollowSystem, followSystem } = useTheme();
      setter = setFollowSystem;
      useEffect(() => { observed = followSystem; }, [followSystem]);
      return null;
    }
    render(
      <ThemeProvider api={api as never} initialBundleId="violet-dark">
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => { expect(setter).not.toBeNull(); });
    act(() => { setter!(true); });
    await waitFor(() => { expect(observed).toBe(true); });
    expect(api.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ appearance: expect.objectContaining({ followSystem: true }) }),
    );
  });

  it("follows the OS scheme across a declared pair, and only when the pair is installed with the other shell", async () => {
    let light = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("light") ? light : false,
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    const seen: Record<string, unknown> = {};
    let pick: ((id: string) => void) | null = null;
    function Capture() {
      const theme = useTheme();
      pick = theme.setBundle;
      seen.effective = theme.effectiveBundleId;
      seen.follow = theme.followSystem;
      seen.can = theme.canFollowSystem;
      return null;
    }
    const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, appearance: { schemaVersion: 2, bundleId: "violet-dark", followSystem: true } } });
    const view = render(
      <ThemeProvider api={api as never} initialBundleId="violet-dark" initialFollowSystem>
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await waitFor(() => expect(seen.effective).toBe("violet-light"));
    expect(seen.can).toBe(true);

    light = false;
    act(() => { for (const listener of listeners) listener(); });
    await waitFor(() => expect(seen.effective).toBe("violet-dark"));

    // No installed counterpart, or one of the same shell: the selection applies as is.
    act(() => { pick!("lonely-dark"); });
    await waitFor(() => expect(seen.effective).toBe("lonely-dark"));
    expect(seen.can).toBe(false);
    act(() => { pick!("dusk"); });
    await waitFor(() => expect(seen.effective).toBe("dusk"));
    expect(seen.can).toBe(false);
    view.unmount();
  });

  it("an explicit pick of a paired theme turns followSystem off, so the pick is what shows", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
    const seen: Record<string, unknown> = {};
    let pick: ((id: string) => void) | null = null;
    function Capture() {
      const theme = useTheme();
      pick = theme.setBundle;
      seen.effective = theme.effectiveBundleId;
      seen.follow = theme.followSystem;
      return null;
    }
    const { api } = makeMockAveApi({ settings: { ...MOCK_DEFAULT_SETTINGS, appearance: { schemaVersion: 2, bundleId: "violet-light", followSystem: true } } });
    render(
      <ThemeProvider api={api as never} initialBundleId="violet-light" initialFollowSystem>
        <Capture />
      </ThemeProvider>,
    );
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await waitFor(() => expect(seen.effective).toBe("violet-light"));
    act(() => { pick!("violet-dark"); });
    await waitFor(() => expect(seen.effective).toBe("violet-dark"));
    expect(seen.follow).toBe(false);
    expect(api.updateSettings).toHaveBeenCalledWith({ appearance: { schemaVersion: 2, bundleId: "violet-dark", followSystem: false } });
  });

  it("ThemeProvider calls notifyPluginTheme with tokens field", async () => {
    const { api } = makeMockAveApi();
    await act(async () => {
      render(
        <ThemeProvider api={api} initialBundleId="violet-dark">
          <div />
        </ThemeProvider>,
      );
    });
    expect(api.notifyPluginTheme).toHaveBeenCalled();
    const call = (api.notifyPluginTheme as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.tokens).toBeDefined();
    expect(typeof call.tokens["--ave-bg"]).toBe("string");
    expect(call.tokens["--ave-primary"]).toContain("253");  // vivid purple
  });
});

describe("<ThemeProvider> + reduced-motion", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("reduce"),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
  });

  it("does not throw and applies bundle cleanly when reduced-motion is set", () => {
    render(
      <ThemeProvider initialBundleId="tokyo-night">
        <div />
      </ThemeProvider>,
    );
    const inline = document.documentElement.getAttribute("style") ?? "";
    expect(inline).not.toMatch(/transition/i);
    expect(document.documentElement.getAttribute("data-theme-bundle")).toBe("tokyo-night");
  });
});
