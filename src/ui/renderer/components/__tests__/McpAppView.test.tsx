// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpAppView } from "../McpAppView.js";
import { McpAppPipPanel } from "../McpAppPipPanel.js";
import { ThemeProvider, useTheme } from "../../theme/index.js";
import { DEFAULT_BUNDLE_ID } from "../../theme/index.js";
import { setInstalledThemeBundles } from "../../theme/bundles/index.js";
import { moonstoneBundle } from "../../theme/bundles/moonstone.js";
import { ThemeWrapper } from "./mcp-app-test-helpers.js";
import { mcpAppPartitionName } from "../../../../shared/mcp-app-partition.js";
import { MCP_APP_CARD_MAX_HEIGHT_PX } from "../../../../shared/mcp-app-card-size.js";
import { __resetMcpAppCardLocationStoreForTests } from "../../state/mcp-app-card-location-store.js";
import type { McpUiPayload } from "../../../../mcp/types.js";
import { mcpUiPayload as payload } from "./mcp-app-panel-fixture.js";
import { applyInstalledContent, resetInstalledContentForTests } from "../../installed-content.js";
import { makeMockAveApi } from "../../../../../test/renderer/mock-ave-api.js";
import { installedTheme, installedThemeContent, NO_LANGUAGE_BRIDGE } from "../../../../../test/renderer/installed-theme.js";

// Use vi.hoisted for bridge fixtures because mock factories execute before local const initialization.
const { createMcpAppBridgeMock } = vi.hoisted(() => ({ createMcpAppBridgeMock: vi.fn() }));
vi.mock("../mcp-app-bridge.js", () => ({
  createMcpAppBridge: createMcpAppBridgeMock,
}));

const renderCard = (payload: McpUiPayload) =>
  render(<McpAppView payload={payload} />, { wrapper: ThemeWrapper });

/** Renders a button that drives a live theme change via the real ThemeProvider context. */
function ThemeToggleButton({ toBundleId }: { toBundleId: string }) {
  const { setBundle } = useTheme();
  return (
    <button type="button" data-testid="theme-toggle" onClick={() => setBundle(toBundleId)}>
      toggle
    </button>
  );
}

let disconnectHandler: ((serverId: string) => void) | null = null;
// Main now returns a BUNDLE: the sandbox-proxy URL the <webview> navigates to, plus the app HTML that is handed to the
// proxy over the bridge (never in the URL).
const readUiResource = vi.fn(async (serverId: string) => ({
  proxyUrl: `ave-mcp-app://${Buffer.from(serverId, "utf8").toString("hex")}/proxy.html?t=tok-${serverId}`,
  html: "<html><body>card</body></html>",
}));
const disposeUiSession = vi.fn();
/** The gated save path behind `ondownloadfile`. */
const downloadFile = vi.fn(async () => ({ ok: true as const, disposition: "saved" as const }));
/** The gated per-card context slot behind `onupdatemodelcontext`. Declared with its real arity so the assertions below can
 * read the THREE renderer-supplied bindings positionally. */
const postUiModelContext = vi.fn(
  async (_serverId: string, _sessionId: string, _cardId: string, _params: unknown) => ({
    ok: true as const,
    disposition: "stored" as const,
  }),
);

function stubAve() {
  disconnectHandler = null;
  vi.stubGlobal("ave", {
    mcp: {
      readUiResource,
      disposeUiSession,
      downloadFile,
      postUiModelContext,
      onServerDisconnected: (handler: (serverId: string) => void) => {
        disconnectHandler = handler;
        return () => {
          disconnectHandler = null;
        };
      },
    },
  });
  (window as unknown as { ave: unknown }).ave = (globalThis as unknown as { ave: unknown }).ave;
}

/** The display-mode halves (5th arg) of the deps createMcpAppBridge was seeded with. */
function seededDisplayDeps() {
  return createMcpAppBridgeMock.mock.calls[0]![4] as {
    getDisplayMode: () => string;
    applyDisplayMode: (mode: string) => Promise<string>;
  };
}

/** The hostContext (4th arg) of the first createMcpAppBridge call. */
function seededContext() {
  return createMcpAppBridgeMock.mock.calls[0]![3] as {
    displayMode?: string;
    availableDisplayModes?: string[];
  };
}

/** applyDisplayMode of the FIRST (home) createMcpAppBridge call. */
const homeDeps = () =>
  createMcpAppBridgeMock.mock.calls[0]![4] as { applyDisplayMode: (mode: string) => Promise<string> };

/** applyDisplayMode of the SECOND (pip) createMcpAppBridge call. */
const pipDeps = () =>
  createMcpAppBridgeMock.mock.calls[1]![4] as { applyDisplayMode: (mode: string) => Promise<string> };

beforeEach(() => {
  // The pip / location-store describe blocks below write the MODULE-SINGLETON card
  // location store (moveCard / reviveCardIfAt via applyDisplayMode). Reset it per test
  // so order-coupled shared state never leaks between cases (the store test and
  // McpAppPipPanel.test.tsx already do this).
  __resetMcpAppCardLocationStoreForTests();
  // The dark theme the theme-change case switches to is an installed package.
  setInstalledThemeBundles([{ ...moonstoneBundle, id: "midnight", name: "Midnight", shell: "dark" }]);
  readUiResource.mockClear();
  stubAve();
  createMcpAppBridgeMock.mockClear();
  // Default fake bridge for every test in this file: a `setHostContext` spy plus
  // a no-op `transport.close()` (invoked on unmount / re-attach). Individual tests
  // read `createMcpAppBridgeMock.mock.calls` / `.mock.results` to inspect the
  // hostContext argument and the returned bridge's `setHostContext` calls.
  createMcpAppBridgeMock.mockImplementation(() => ({
    bridge: { setHostContext: vi.fn() },
    transport: { close: vi.fn() },
    connected: Promise.resolve(),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetMcpAppCardLocationStoreForTests();
  resetInstalledContentForTests();
  setInstalledThemeBundles([]);
});

/** Query the MOUNTED <webview> node (asserts the node attribute, not a setter). */
function webviewNode(container: HTMLElement): Element | null {
  return container.querySelector("webview");
}

describe("McpAppView — MAJOR-1 per-server partition as a createElement PROP", () => {
  it("sets partition=ave-mcp-app:<enc(serverId)> on the MOUNTED webview node", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const node = webviewNode(container)!;
    // Partition must be an initial webview attribute because it binds before src loads.
    expect(node.getAttribute("partition")).toBe(mcpAppPartitionName("github"));
    // Sandbox posture also declared as creation-time props.
    expect(node.getAttribute("webpreferences")).toContain("contextIsolation=yes");
    expect(node.getAttribute("webpreferences")).toContain("sandbox=yes");
    // The webview now navigates to the host-owned sandbox-proxy document on the
    // privileged scheme — NOT a `data:` URL carrying the app HTML. The app HTML
    // travels over the bridge instead, so it never hits the ~2MB data:-URL cap and
    // the document gets a real origin + a real CSP response header.
    expect(node.getAttribute("src")?.startsWith("ave-mcp-app://")).toBe(true);
    expect(node.getAttribute("src")).not.toContain("data:text/html");
    // No preload ATTRIBUTE: it is silently ignored under sandbox=yes and stripped by the will-attach guards. The relay preload
    // is session-registered.
    expect(node.getAttribute("preload")).toBeNull();
  });

  it("distinct serverIds yield distinct partition attributes", async () => {
    const a = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(a.container)).toBeTruthy());
    const b = renderCard(payload("gitlab"));
    await waitFor(() => expect(webviewNode(b.container)).toBeTruthy());

    const pa = webviewNode(a.container)!.getAttribute("partition");
    const pb = webviewNode(b.container)!.getAttribute("partition");
    expect(pa).toBe(mcpAppPartitionName("github"));
    expect(pb).toBe(mcpAppPartitionName("gitlab"));
    expect(pa).not.toBe(pb);
  });
});

describe("McpAppView — b3 disable-in-place on disconnect", () => {
  it("swaps the webview for a placeholder when its own server disconnects", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    act(() => {
      disconnectHandler?.("github");
    });

    // The live webview is torn down; the placeholder takes the same card frame.
    expect(webviewNode(container)).toBeNull();
    expect(screen.getByTestId("mcp-app-disconnected")).toBeInTheDocument();
  });

  it("ignores a disconnect for a DIFFERENT server", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    act(() => {
      disconnectHandler?.("some-other-server");
    });

    expect(webviewNode(container)).toBeTruthy();
    expect(screen.queryByTestId("mcp-app-disconnected")).toBeNull();
  });
});

describe("McpAppView — standard McpUiHostContext wiring (P0)", () => {
  it("seeds createMcpAppBridge with a populated, leak-free hostContext, then pushes updates via bridge.setHostContext on a theme change", async () => {
    const { container, getByTestId } = render(<McpAppView payload={payload("github")} />, {
      // `initialBundleId={DEFAULT_BUNDLE_ID}` ("moonstone", shell "light") gives a known starting theme. The toggle button (real
      // ThemeProvider context) later drives a switch to "midnight" (shell "dark") to exercise the update path.
      wrapper: ({ children }) => (
        <ThemeProvider initialBundleId={DEFAULT_BUNDLE_ID}>
          <ThemeToggleButton toBundleId="midnight" />
          {children}
        </ThemeProvider>
      ),
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    // (a) The INITIAL seed: createMcpAppBridge's 4th arg is a populated, standard hostContext — theme present, at least one
    // standard `--color-*` style variable, and NEVER a proprietary `--ave-*` key (the portability guarantee).
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
    const seededContext = createMcpAppBridgeMock.mock.calls[0]![3] as {
      theme?: string;
      styles?: { variables?: Record<string, string> };
    };
    expect(seededContext.theme).toBe("light");
    const seededKeys = Object.keys(seededContext.styles?.variables ?? {});
    expect(seededKeys.some((k) => k.startsWith("--color-"))).toBe(true);
    expect(seededKeys.some((k) => k.startsWith("--ave-"))).toBe(false);

    const fakeBridge = createMcpAppBridgeMock.mock.results[0]!.value.bridge as {
      setHostContext: ReturnType<typeof vi.fn>;
    };
    expect(fakeBridge.setHostContext).not.toHaveBeenCalled();

    // (b) THE UPDATE PATH — the flagship guard: switching the active theme via the real ThemeProvider must reach the mounted
    // bridge through `setHostContext`, NOT re-create the bridge (attachWebview stays keyed on [payload, bundle]).
    act(() => {
      fireEvent.click(getByTestId("theme-toggle"));
    });

    // "midnight" resolves after the installed content, so `effectiveBundleId` flips to
    // "midnight" a render before the bundle itself resolves — McpAppView's
    // host-context effect may push an interim call before `resolved` catches up.
    // Poll on the LAST call converging to "dark" rather than "called once" so the
    // assertion is robust to that intermediate render.
    await waitFor(() => {
      const calls = fakeBridge.setHostContext.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect((calls[calls.length - 1]![0] as { theme?: string }).theme).toBe("dark");
    });
    // The bridge was never re-created for a theme-only change.
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
  });

  it("pushes the new values when the shown theme is updated in place (same id, same shell)", async () => {
    const harbor = installedTheme("harbor", "dark", { background: "210 40% 12%" });
    const { api } = makeMockAveApi({ settings: { appearance: { schemaVersion: 2, bundleId: "harbor" } } });
    act(() => { applyInstalledContent(installedThemeContent([harbor]), NO_LANGUAGE_BRIDGE); });
    render(
      <ThemeProvider api={api as never} initialBundleId="harbor">
        <McpAppView payload={payload("sample")} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const seeded = createMcpAppBridgeMock.mock.calls[0]![3] as { styles: { variables: Record<string, string> } };
    expect(seeded.styles.variables["--color-background-primary"]).toBe("hsl(210, 40%, 12%)");
    const appBridge = createMcpAppBridgeMock.mock.results[0]!.value.bridge as { setHostContext: ReturnType<typeof vi.fn> };
    appBridge.setHostContext.mockClear();

    await act(async () => {
      applyInstalledContent(installedThemeContent([{ ...harbor, tokens: { ...harbor.tokens, background: "210 40% 18%" } }]), NO_LANGUAGE_BRIDGE);
    });

    await waitFor(() => expect(appBridge.setHostContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ styles: expect.objectContaining({ variables: expect.objectContaining({ "--color-background-primary": "hsl(210, 40%, 18%)" }) }) }),
    ));
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
  });

  /** What an app is told, beside what :root holds at that moment. */
  type Seen = { shell: string; background: string; root: string };
  const seen = (context: { theme?: string; styles?: { variables?: Record<string, string> } }): Seen => ({
    shell: context.theme ?? "",
    background: context.styles?.variables?.["--color-background-primary"] ?? "",
    root: document.documentElement.style.getPropertyValue("--background"),
  });
  const pairedThemes = () => {
    const bright = installedTheme("harbor-light", "light", { background: "210 40% 92%" });
    const dark = installedTheme("harbor-dark", "dark", { background: "210 40% 12%" });
    act(() => { applyInstalledContent(installedThemeContent([bright, dark]), NO_LANGUAGE_BRIDGE); });
    return { bright, dark };
  };
  const BRIGHT: Seen = { shell: "light", background: "hsl(210, 40%, 92%)", root: "210 40% 92%" };
  const DARK: Seen = { shell: "dark", background: "hsl(210, 40%, 12%)", root: "210 40% 12%" };

  it("tells a mounted app about a switched theme only once :root holds it, shell and tokens from that one theme", async () => {
    const { bright, dark } = pairedThemes();
    const { api } = makeMockAveApi({ settings: { appearance: { schemaVersion: 2, bundleId: bright.id } } });
    const view = render(
      <ThemeProvider api={api as never} initialBundleId={bright.id}>
        <ThemeToggleButton toBundleId={dark.id} />
        <McpAppView payload={payload("sample")} />
      </ThemeProvider>,
    );
    await waitFor(() => expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1));
    await act(async () => {});
    const appBridge = createMcpAppBridgeMock.mock.results[0]!.value.bridge as { setHostContext: ReturnType<typeof vi.fn> };
    const told: Seen[] = [];
    appBridge.setHostContext.mockImplementation((context: never) => { told.push(seen(context)); });

    await act(async () => { fireEvent.click(view.getByTestId("theme-toggle")); });

    // One push, after the write: never the old shell with the new tokens, nor the new pair over the old :root.
    expect(told).toEqual([DARK]);
  });

  it("seeds an app that mounts while a switch is on its way with the theme :root holds, then sends the new one", async () => {
    const { bright, dark } = pairedThemes();
    const { api } = makeMockAveApi({ settings: { appearance: { schemaVersion: 2, bundleId: bright.id } } });
    let release: (resource: { proxyUrl: string; html: string }) => void = () => undefined;
    readUiResource.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const seeds: Seen[] = [];
    const told: Seen[] = [];
    createMcpAppBridgeMock.mockImplementation((...args: unknown[]) => {
      seeds.push(seen(args[3] as never));
      return { bridge: { setHostContext: vi.fn((context: never) => { told.push(seen(context)); }) }, transport: { close: vi.fn() }, connected: Promise.resolve() };
    });
    const view = render(
      <ThemeProvider api={api as never} initialBundleId={bright.id}>
        <ThemeToggleButton toBundleId={dark.id} />
        <McpAppView payload={payload("sample")} />
      </ThemeProvider>,
    );
    await act(async () => {});
    expect(createMcpAppBridgeMock).not.toHaveBeenCalled();

    // The app's resource arrives in the same batch as the switch: it mounts before the new theme is written.
    await act(async () => {
      release({ proxyUrl: "ave-mcp-app://73616d706c65/proxy.html?t=tok-sample", html: "<html><body>card</body></html>" });
      fireEvent.click(view.getByTestId("theme-toggle"));
    });

    expect(seeds).toEqual([BRIGHT]);
    expect(told).toEqual([DARK]);
  });
});

describe("McpAppView — app-driven resize + open-link adapters (P1a)", () => {
  /** The `deps` (5th) arg createMcpAppBridge was seeded with on the first mount. */
  function seededDeps() {
    return createMcpAppBridgeMock.mock.calls[0]![4] as {
      onResize: (next: { width?: number; height?: number }) => void;
      openLink: (url: string) => Promise<{ ok: boolean }>;
    };
  }

  it("seeds the webview at payload height, then grows it when the app reports a size change", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const node = () => webviewNode(container) as HTMLElement;

    // Initial seed = payload.height ?? 300.
    expect(node().style.height).toBe("300px");
    expect(node().style.width).toBe("100%");

    // Driving the injected onsizechange sink updates the live <webview> height…
    act(() => {
      seededDeps().onResize({ height: 512 });
    });
    await waitFor(() => expect((webviewNode(container) as HTMLElement).style.height).toBe("512px"));
    // …without re-creating the bridge (resize is a state update, not a re-mount)…
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
    // …and a height-only notification leaves width responsive.
    expect(node().style.width).toBe("100%");
  });

  it("CLAMPS an absurd height — the only real bound (CSS max-height:100% caps nothing here)", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    act(() => {
      seededDeps().onResize({ height: 10_000_000 });
    });

    await waitFor(() =>
      expect((webviewNode(container) as HTMLElement).style.height).toBe(`${MCP_APP_CARD_MAX_HEIGHT_PX}px`),
    );
    // And the misleading percentage cap is gone: the px value IS the bound.
    expect((webviewNode(container) as HTMLElement).style.maxHeight).toBe("");
  });

  it("REFUSES a non-finite / non-positive size — the card keeps the height it had", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    act(() => {
      seededDeps().onResize({ height: 512 });
    });
    await waitFor(() => expect((webviewNode(container) as HTMLElement).style.height).toBe("512px"));

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -900]) {
      act(() => {
        seededDeps().onResize({ height: bad });
      });
      expect((webviewNode(container) as HTMLElement).style.height, `height=${String(bad)}`).toBe("512px");
    }
  });

  it("bounds the SERVER-declared height seed too (the payload is untrusted as well)", async () => {
    const { container } = renderCard({ serverId: "github", resourceUri: "ui://card/1", height: 10_000_000 });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    expect((webviewNode(container) as HTMLElement).style.height).toBe(`${MCP_APP_CARD_MAX_HEIGHT_PX}px`);
  });

  it("routes onopenlink through window.aveApi.openExternalUrl (the gated egress), returning ok", async () => {
    const openExternalUrl = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("aveApi", { openExternalUrl });

    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    const result = await seededDeps().openLink("https://example.com");

    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
    expect(result).toEqual({ ok: true });
  });
});

describe("McpAppView — display-mode applier (the EXISTING window seams, reused)", () => {
  it("seeds an inline card's host context with displayMode=inline + the advertised set", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    expect(seededContext().displayMode).toBe("inline");
    expect(seededContext().availableDisplayModes).toEqual(["inline", "fullscreen", "pip"]);
    expect(seededDisplayDeps().getDisplayMode()).toBe("inline");
  });

  it("seeds a FULLSCREEN mount as fullscreen — the fullscreen panel IS that presentation", async () => {
    const { container } = render(<McpAppView payload={payload("github")} displayMode="fullscreen" />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    expect(seededContext().displayMode).toBe("fullscreen");
    expect(seededDisplayDeps().getDisplayMode()).toBe("fullscreen");
  });

  it("fullscreen REPLACES the card IN THIS RENDERER — no window is opened, and THIS mount stops being a live app", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const transport = createMcpAppBridgeMock.mock.results[0]!.value.transport as {
      close: ReturnType<typeof vi.fn>;
    };

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("fullscreen"));

    // `fullscreen` is a surface inside this renderer, served by the shared location store.
    expect(applied).toBe("fullscreen");

    // Replace, don't clone. The inline instance is gone — no <webview>, and its bridge/transport were torn down. Exactly one
    // live bridge exists for this card, and it is the one the fullscreen panel mounts.
    await waitFor(() => expect(screen.getByTestId("mcp-app-fullscreen")).toBeInTheDocument());
    expect(webviewNode(container)).toBeNull();
    expect(transport.close).toHaveBeenCalledTimes(1);
    // No second bridge was created in this mount.
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
  });

  it("NEVER reports a mode it is not in: the dormant inline mount stays `inline`, never `fullscreen`", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const bridge = createMcpAppBridgeMock.mock.results[0]!.value.bridge as {
      setHostContext: ReturnType<typeof vi.fn>;
    };

    await act(() => seededDisplayDeps().applyDisplayMode("fullscreen"));

    // The old bug: this mount set `displayMode = "fullscreen"` and pushed it into its own (still live) host context, so a
    // spec-conformant app swapped to its fullscreen layout inside a 300px transcript box. It must never publish that.
    expect(seededDisplayDeps().getDisplayMode()).toBe("inline");
    for (const call of bridge.setHostContext.mock.calls) {
      expect((call[0] as { displayMode?: string }).displayMode).not.toBe("fullscreen");
    }
  });

  it("fullscreen -> inline: a SECOND mount (the fullscreen surface) revives the home mount through the store", async () => {
    const locationId = "shared-loc-fullscreen-inline";
    const home = render(<McpAppView payload={payload("github")} locationId={locationId} />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());

    await act(() => homeDeps().applyDisplayMode("fullscreen"));
    await waitFor(() =>
      expect(home.container.querySelector('[data-testid="mcp-app-fullscreen"]')).toBeTruthy(),
    );
    expect(webviewNode(home.container)).toBeNull();

    // The FULLSCREEN mount (McpAppFullscreenPanel's own McpAppView instance) — SAME locationId, a SEPARATE React tree,
    // coexisting with the now-dormant home mount.
    const full = render(
      <McpAppView payload={payload("github")} displayMode="fullscreen" locationId={locationId} />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNode(full.container)).toBeTruthy());

    // The app inside the FULLSCREEN mount requests "inline".
    const applied = await act(() => pipDeps().applyDisplayMode("inline"));
    expect(applied).toBe("inline");

    // Reviving is a pure store move.
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());
    expect(home.container.querySelector('[data-testid="mcp-app-fullscreen"]')).toBeNull();
  });

  it("an inline request that the store guard rejects does not claim a move that never happened", async () => {
    // This mount has no store entry (nothing ever moved this card here), so the guarded
    // revive declines — and the mount must report the mode it is STILL in. The inverse
    // (returning "inline" anyway) is how a card ends up telling a spec-conformant app it
    // is embedded in a transcript while it is still filling the window.
    const { container } = render(<McpAppView payload={payload("github")} displayMode="fullscreen" />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    await expect(act(() => seededDisplayDeps().applyDisplayMode("inline"))).resolves.toBe("fullscreen");
    expect(webviewNode(container)).toBeTruthy();
  });

  it("is a no-op when the app asks for the mode it is already in", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    await expect(act(() => seededDisplayDeps().applyDisplayMode("inline"))).resolves.toBe("inline");
  });
});

describe("McpAppView — pip (the shared location store, not a second window stack)", () => {
  it("seeds a PIP mount with displayMode=pip", async () => {
    const { container } = render(<McpAppView payload={payload("github")} displayMode="pip" />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    expect(seededContext().displayMode).toBe("pip");
    expect(seededDisplayDeps().getDisplayMode()).toBe("pip");
  });

  it("inline -> pip: REPLACES the card — no IPC, no window, this mount stops being live", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const transport = createMcpAppBridgeMock.mock.results[0]!.value.transport as {
      close: ReturnType<typeof vi.fn>;
    };

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("pip"));

    expect(applied).toBe("pip");
    await waitFor(() => expect(screen.getByTestId("mcp-app-pip")).toBeInTheDocument());
    expect(webviewNode(container)).toBeNull();
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(1);
  });

  it("NEVER reports a mode it is not in: the dormant inline mount stays `inline`, never `pip`", async () => {
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const bridge = createMcpAppBridgeMock.mock.results[0]!.value.bridge as {
      setHostContext: ReturnType<typeof vi.fn>;
    };

    await act(() => seededDisplayDeps().applyDisplayMode("pip"));

    expect(seededDisplayDeps().getDisplayMode()).toBe("inline");
    for (const call of bridge.setHostContext.mock.calls) {
      expect((call[0] as { displayMode?: string }).displayMode).not.toBe("pip");
    }
  });

  it("pip -> inline: a SECOND mount (the pip surface) revives the home mount directly through the store — no IPC", async () => {
    const locationId = "shared-loc-pip-inline";

    // The HOME mount — explicit shared `locationId` so a second, independently rendered McpAppView (below) can address the
    // SAME store entry, exactly like McpAppPipPanel does with the home's real (randomUUID) id.
    const home = render(<McpAppView payload={payload("github")} locationId={locationId} />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());

    await act(() => homeDeps().applyDisplayMode("pip"));
    await waitFor(() => expect(home.container.querySelector('[data-testid="mcp-app-pip"]')).toBeTruthy());
    expect(webviewNode(home.container)).toBeNull();

    // The PIP mount (McpAppPipPanel's own McpAppView instance) — SAME locationId, a SEPARATE React tree, coexisting with the
    // (now dormant) home mount.
    const pip = render(
      <McpAppView payload={payload("github")} displayMode="pip" locationId={locationId} />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNode(pip.container)).toBeTruthy());
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(2); // home's (torn down) + pip's live one // The app inside the PIP mount requests "inline".
    const applied = await act(() => pipDeps().applyDisplayMode("inline"));
    expect(applied).toBe("inline");

    // The home mount comes back to life — a fresh, THIRD bridge for it.
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());
    expect(home.container.querySelector('[data-testid="mcp-app-pip"]')).toBeNull();
    expect(createMcpAppBridgeMock).toHaveBeenCalledTimes(3);
  });

  it("round trip inline -> pip -> inline keeps exactly ONE live bridge at every step (coexisting home + pip mounts)", async () => {
    const locationId = "shared-loc-round-trip";
    const home = render(<McpAppView payload={payload("github")} locationId={locationId} />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());

    // inline -> pip
    await act(() => homeDeps().applyDisplayMode("pip"));
    expect(webviewNode(home.container)).toBeNull(); // home: dormant

    const pip = render(
      <McpAppView payload={payload("github")} displayMode="pip" locationId={locationId} />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNode(pip.container)).toBeTruthy()); // pip: live // Exactly one <webview> across BOTH trees at this step.
    expect([webviewNode(home.container), webviewNode(pip.container)].filter(Boolean)).toHaveLength(1);

    // pip -> inline
    await act(() => pipDeps().applyDisplayMode("inline"));
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy()); // home: live again
    // Still exactly one <webview> across both trees — the pip mount does not also
    // stay live (production McpAppPipPanel unmounts it via the occupant-null branch;
    // here we assert the STORE side, which is what makes that unmount correct: this
    // card's location is no longer "pip").
    const { getCardLocation } = await import("../../state/mcp-app-card-location-store.js");
    expect(getCardLocation(locationId)).toEqual({ kind: "inline" });
  });

  it("pip -> fullscreen: moves the STORE location to fullscreen, with no window IPC", async () => {
    const locationId = "loc-shared-pip-fullscreen";
    const { container } = render(
      <McpAppView payload={payload("github")} displayMode="pip" locationId={locationId} />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("fullscreen"));

    expect(applied).toBe("fullscreen");
    // Away mounts are retired by their parent panels, not their own location read; isolated mounts therefore remain live until
    // explicitly unmounted.
    const { getCardLocation, getSlotOccupant } = await import(
      "../../state/mcp-app-card-location-store.js"
    );
    expect(getCardLocation(locationId)).toEqual({ kind: "fullscreen" });
    // BOTH ends of the move: the pip slot the card LEFT is empty, so the pip panel tears its bridge down instead of keeping a
    // second live copy of the card.
    expect(getSlotOccupant("pip")).toBeNull();
    expect(getSlotOccupant("fullscreen")?.cardId).toBe(locationId);
  });

  it("fullscreen -> pip: a symmetric in-renderer move, no longer declined", async () => {
    const locationId = "loc-shared-fullscreen-pip";
    const { container } = render(
      <McpAppView payload={payload("github")} displayMode="fullscreen" locationId={locationId} />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());

    const applied = await act(() => seededDisplayDeps().applyDisplayMode("pip"));

    // Both away surfaces live in THIS renderer's heap, so the move is the same store write in either direction — the old
    // cross-process decline has no reason to exist.
    expect(applied).toBe("pip");
    const { getCardLocation } = await import("../../state/mcp-app-card-location-store.js");
    expect(getCardLocation(locationId)).toEqual({ kind: "pip" });
  });

});

describe("McpAppView — home-mount unmount reclaims a leaked away entry (MAJOR-2)", () => {
  function homeDeps() {
    return createMcpAppBridgeMock.mock.calls[0]![4] as {
      applyDisplayMode: (mode: string) => Promise<string>;
    };
  }

  it("home-mount unmount while the card is in pip reclaims the entry and tears the bridge down", async () => {
    const { getCardLocation, getSlotOccupant } = await import("../../state/mcp-app-card-location-store.js");
    const locationId = "loc-unmount-reclaim";

    // Production topology: a transcript HOME mount + the session-independent pip panel.
    const home = render(<McpAppView payload={payload("github")} locationId={locationId} />, {
      wrapper: ThemeWrapper,
    });
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());
    const pip = render(<McpAppPipPanel />, { wrapper: ThemeWrapper });

    // The app moves the card to pip: the home goes dormant, the panel mounts a live away card.
    await act(() => homeDeps().applyDisplayMode("pip"));
    await waitFor(() => expect(pip.container.querySelector("webview")).toBeTruthy());
    expect(getCardLocation(locationId)).toEqual({ kind: "pip" });
    expect(webviewNode(home.container)).toBeNull(); // home dormant // The user leaves the conversation → the transcript child (the HOME mount) unmounts.
    home.unmount();

    // The leaked entry is reclaimed and the pip bridge torn down: store back to inline, nobody occupies pip, and the panel
    // renders nothing (its away McpAppView unmounted).
    await waitFor(() => expect(getSlotOccupant("pip")).toBeNull());
    expect(getCardLocation(locationId)).toEqual({ kind: "inline" });
    expect(pip.container.querySelector('[data-testid="mcp-app-pip-panel"]')).toBeNull();
  });

  it("a card in pip within a live conversation is NOT killed by an unrelated home re-render", async () => {
    const { getCardLocation, getSlotOccupant } = await import("../../state/mcp-app-card-location-store.js");
    const locationId = "loc-rerender-safe";
    // Stable payload identity so a re-render does NOT re-run the payload effect (which has its own fresh-card reclaim) — this
    // isolates the unmount effect under test.
    const p = payload("github");

    const home = render(<McpAppView payload={p} locationId={locationId} />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(webviewNode(home.container)).toBeTruthy());

    await act(() => homeDeps().applyDisplayMode("pip"));
    expect(getCardLocation(locationId)).toEqual({ kind: "pip" });

    // A benign re-render of the still-MOUNTED home (e.g. a parent state change) — no unmount. The unmount cleanup must not
    // fire, so the pip card survives.
    home.rerender(<McpAppView payload={p} locationId={locationId} />);

    expect(getCardLocation(locationId)).toEqual({ kind: "pip" });
    expect(getSlotOccupant("pip")?.cardId).toBe(locationId);
    // The home stayed mounted throughout, showing its own dormant pip placeholder.
    expect(home.container.querySelector('[data-testid="mcp-app-pip"]')).toBeTruthy();
  });
});

describe("McpAppView — download sink is BOUND to the card's server", () => {
  it("passes the card's serverId (the app names none) plus the spec params, untouched", async () => {
    downloadFile.mockClear();
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const deps = createMcpAppBridgeMock.mock.calls[0]![4] as {
      downloadFile: (params: unknown) => Promise<{ ok: boolean }>;
    };

    const params = { contents: [{ type: "resource", resource: { uri: "ui://card/a.csv", text: "a,b" } }] };
    await deps.downloadFile(params);

    expect(downloadFile).toHaveBeenCalledWith("github", params);
  });
});

describe("McpAppView — model-context sink is BOUND to server + session + card", () => {
  it("supplies all three bindings the app cannot name, plus the spec params", async () => {
    postUiModelContext.mockClear();
    const { container } = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const deps = createMcpAppBridgeMock.mock.calls[0]![4] as {
      updateModelContext: (params: unknown) => Promise<{ ok: boolean }>;
    };

    const params = { content: [{ type: "text", text: "cart: 3 items" }] };
    await deps.updateModelContext(params);

    expect(postUiModelContext).toHaveBeenCalledTimes(1);
    const [serverId, sessionId, cardId, forwarded] = postUiModelContext.mock.calls[0]!;
    expect(serverId).toBe("github");
    // No ChatContext in this harness → the origin session is empty, which is never the live session id, so main drops the
    // update. Fail-safe, same as `onmessage`.
    expect(sessionId).toBe("");
    // A card id the RENDERER minted: stable, non-empty, and never named by the app.
    expect(cardId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(forwarded).toEqual(params);
  });

  it("a mount with no ChatContext posts the host-threaded origin session, so its updates actually land", async () => {
    postUiModelContext.mockClear();
    // This is how a card mounts outside the chat subtree: no ChatContext anywhere in the
    // tree, and the origin session threaded in explicitly. Without the prop the card would
    // post "" and main would drop every update on the session check — forever, silently,
    // since `ui/update-model-context` has no error channel in the spec.
    const { container } = render(
      <McpAppView payload={payload("github")} originSessionId="sess-abc" />,
      { wrapper: ThemeWrapper },
    );
    await waitFor(() => expect(webviewNode(container)).toBeTruthy());
    const deps = createMcpAppBridgeMock.mock.calls[0]![4] as {
      updateModelContext: (params: unknown) => Promise<{ ok: boolean }>;
      postMessage: (params: unknown) => Promise<{ ok: boolean }>;
    };

    await deps.updateModelContext({ content: [{ type: "text", text: "cart: 3 items" }] });

    const [serverId, sessionId] = postUiModelContext.mock.calls[0]!;
    expect(serverId).toBe("github");
    expect(sessionId).toBe("sess-abc");
  });

  it("gives two mounted cards DIFFERENT ids, so one cannot overwrite the other's slot", async () => {
    postUiModelContext.mockClear();
    const first = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(first.container)).toBeTruthy());
    const second = renderCard(payload("github"));
    await waitFor(() => expect(webviewNode(second.container)).toBeTruthy());

    const depsOf = (index: number) =>
      createMcpAppBridgeMock.mock.calls[index]![4] as {
        updateModelContext: (params: unknown) => Promise<{ ok: boolean }>;
      };
    await depsOf(0).updateModelContext({ content: [] });
    await depsOf(1).updateModelContext({ content: [] });

    const cardIdA = postUiModelContext.mock.calls[0]![2];
    const cardIdB = postUiModelContext.mock.calls[1]![2];
    expect(cardIdA).not.toBe(cardIdB);
  });
});
