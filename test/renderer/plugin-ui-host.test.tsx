// Initial guest attachment must load the real shell and register before entry resolution.
import "./setup.js";
import { describe, it, expect, afterEach, vi } from "vitest";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { PaneFrame } from "../../src/ui/renderer/components/PaneFrame.js";
import { PluginUiHostView, type PluginUiExtensionView } from "../../src/plugin-ui-host.js";

const SHELL_URL = "file:///c:/dist/src/plugin-ui-shell.html";
const PRELOAD_URL = "file:///c:/dist/src/plugin-preload.js";

const VIEW: PluginUiExtensionView = {
  pluginId: "com.example.test-plugin",
  extension: {
    id: "test-view",
    slot: "sidebar",
    kind: "embedded-module",
    title: "Test",
    entry: "ui/index.js",
    exportName: "mount",
  },
  entryUrl: "file:///c:/plugins/example/dist/ui/index.js",
};

let activeRoot: Root | null = null;

function mountHost(view: PluginUiExtensionView | null): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  activeRoot = root;
  act(() => {
    root.render(<PluginUiHostView view={view} />);
  });
  return container;
}

// Attachment events expose no id payload; model the webview accessor the runtime actually uses.
function fireDidAttach(webview: Element, webContentsId: number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (webview as any).getWebContentsId = () => webContentsId;
  webview.dispatchEvent(new Event("did-attach"));
}

function fireDidFailLoad(webview: Element, isMainFrame: boolean) {
  const event = new Event("did-fail-load");
  Object.defineProperty(event, "isMainFrame", { value: isMainFrame });
  webview.dispatchEvent(event);
}

afterEach(() => {
  if (activeRoot) {
    act(() => activeRoot!.unmount());
    activeRoot = null;
  }
  for (const el of Array.from(document.body.children)) {
    el.remove();
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (HTMLElement.prototype as any).getWebContentsId;
  vi.unstubAllGlobals();
});

describe("PluginUiHostView — webview attach flow", () => {
  it("mounts webview with src=shellUrl from the start (preload only runs at first attach)", async () => {
    // Preload runs only on first guest attach; mount with the real shell URL.
    // Host pending-entry handling absorbs registration timing.
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");

    expect(webview).not.toBeNull();
    expect(webview?.getAttribute("src")).toBe(SHELL_URL);
    expect(webview?.getAttribute("preload")).toBe(PRELOAD_URL);

    await act(async () => {
      fireDidAttach(webview!, 42);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(registerPluginWebview).toHaveBeenCalledWith({
      webContentsId: 42,
      pluginId: VIEW.pluginId,
      entryUrl: VIEW.entryUrl,
    });
    expect(webview?.getAttribute("src")).toBe(SHELL_URL);
  });

  it("registers from the ref lifecycle when did-attach is missed on cold boot", async () => {
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });
    // The real accessor throws before attachment; unconditional ids would hide lifecycle errors.
    let attached = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLElement.prototype as any).getWebContentsId = () => {
      if (!attached) {
        throw new Error(
          "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.",
        );
      }
      return 84;
    };

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(registerPluginWebview).toHaveBeenCalledTimes(0);

    attached = true;
    await act(async () => {
      webview!.dispatchEvent(new Event("dom-ready"));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(registerPluginWebview).toHaveBeenCalledTimes(1);
    expect(registerPluginWebview).toHaveBeenCalledWith({
      webContentsId: 84,
      pluginId: VIEW.pluginId,
      entryUrl: VIEW.entryUrl,
    });

    await act(async () => {
      webview!.dispatchEvent(new Event("did-finish-load"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(registerPluginWebview).toHaveBeenCalledTimes(1);
  });

  it("keeps the live webview when an equal-valued view object arrives", async () => {
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
      ensurePluginPartition: vi.fn().mockResolvedValue({ ok: true }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLElement.prototype as any).getWebContentsId = () => 84;

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    activeRoot = root;
    act(() => { root.render(<PluginUiHostView view={VIEW} />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const first = container.querySelector("webview");
    expect(first).not.toBeNull();

    // Equivalent view objects must not remount the guest or restart partition setup.
    await act(async () => {
      root.render(<PluginUiHostView view={{ ...VIEW, extension: { ...VIEW.extension } }} />);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector("webview")).toBe(first);
  });

  it("remounts the webview when the plugin runtime revision changes", () => {
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    activeRoot = root;

    act(() => {
      root.render(<PluginUiHostView view={{ ...VIEW, runtimeRevision: 1 }} />);
    });
    const firstWebview = container.querySelector("webview");
    expect(firstWebview).not.toBeNull();

    act(() => {
      root.render(<PluginUiHostView view={{ ...VIEW, runtimeRevision: 2 }} />);
    });
    const secondWebview = container.querySelector("webview");

    expect(secondWebview).not.toBeNull();
    expect(secondWebview).not.toBe(firstWebview);
  });

  it("shows error text and removes webview when registration returns ok=false", async () => {
    const registerPluginWebview = vi.fn().mockResolvedValue({ ok: false, error: "unknown-plugin-id" });
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview,
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();

    await act(async () => {
      fireDidAttach(webview!, 7);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(container.querySelector("webview")).toBeNull();
    expect(container.textContent).toMatch(/unknown-plugin-id/);
  });

  it("keeps the guest alive when only a child-frame navigation fails", () => {
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();

    act(() => {
      fireDidFailLoad(webview!, false);
    });

    expect(container.querySelector("webview")).toBe(webview);
  });

  it("shows an error and retires the guest when its main frame fails", () => {
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });

    const container = mountHost(VIEW);
    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();

    act(() => {
      fireDidFailLoad(webview!, true);
    });

    expect(container.querySelector("webview")).toBeNull();
    expect(container.textContent ?? "").not.toBe("");
  });

  it("falls back to error text when aveApi.pluginShellUrl is missing", () => {
    vi.stubGlobal("aveApi", { pluginPreloadUrl: PRELOAD_URL });

    const container = mountHost(VIEW);

    const webview = container.querySelector("webview");
    expect(webview).toBeNull();
    expect(container.textContent ?? "").toMatch(/aveApi/);
  });

  it("falls back to error text when aveApi.pluginPreloadUrl is missing", () => {
    vi.stubGlobal("aveApi", { pluginShellUrl: SHELL_URL });

    const container = mountHost(VIEW);

    const webview = container.querySelector("webview");
    expect(webview).toBeNull();
    expect(container.textContent ?? "").toMatch(/aveApi/);
  });
});

describe("PluginUiHostView — webview security attributes", () => {
  // Renderer preference requests are not enforcement; main must validate all three at guest attachment.
  it("requests the isolated, unprivileged configuration", () => {
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });

    const prefs = mountHost(VIEW).querySelector("webview")?.getAttribute("webpreferences") ?? "";

    expect(prefs).toContain("contextIsolation=yes");
    expect(prefs).toContain("nodeIntegration=no");
    expect(prefs).toContain("sandbox=yes");
  });

  it("runs the plugin in its own session partition", () => {
    // The partition isolates storage and identifies plugin frames to the main attach guard.
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });

    const partition = mountHost(VIEW).querySelector("webview")?.getAttribute("partition") ?? "";
    expect(partition).toMatch(/^persist:plugin:[0-9a-f]{8}$/);
  });
});

describe("PluginUiHostView — focus follow-through", () => {
  // Guest clicks do not bubble into host DOM; capture focus on the host element to update pane ownership.
  it("raises the webview's own focus into the frame's onFocus", () => {
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });
    const onFocus = vi.fn();

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    activeRoot = root;
    act(() => {
      root.render(
        <TooltipProvider>
          <PaneFrame title="Test" onFocus={onFocus}>
            <PluginUiHostView view={VIEW} />
          </PaneFrame>
        </TooltipProvider>,
      );
    });

    const webview = container.querySelector("webview");
    expect(webview).not.toBeNull();
    expect(onFocus).not.toHaveBeenCalled();

    act(() => {
      webview!.dispatchEvent(new FocusEvent("focus"));
    });

    expect(onFocus).toHaveBeenCalled();
  });
});

describe("PluginUiHostView — panel width", () => {
  // Plugin panes must use available host width rather than a reading-column clamp.
  it("hands the plugin the full pane instead of the reading column", () => {
    vi.stubGlobal("aveApi", {
      pluginShellUrl: SHELL_URL,
      pluginPreloadUrl: PRELOAD_URL,
      registerPluginWebview: vi.fn().mockResolvedValue({ ok: true }),
    });

    const container = mountHost(VIEW);

    // Assert the shell exists before testing absence of a width clamp.
    expect(container.querySelector('[data-testid="plugin-page-shell"]')).not.toBeNull();

    // Inspect the inner column because it owns the clamp.
    expect(container.querySelector('[class*="max-w-(--reading-column-max)"]')).toBeNull();
  });
});
