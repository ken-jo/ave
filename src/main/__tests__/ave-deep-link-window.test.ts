/**
 * E4 cluster-review MAJOR-1 — deep-link × hidden window.
 *
 * A hidden auto-launch (launchMinimized) or a hide-to-tray close both leave an
 * alive-but-non-destroyed main window. When a `ave://` deep link arrives,
 * `handleAveUri` must fully SURFACE that window (showMainWindow: show +
 * restore + focus + moveTop) before running its confirmation dialog, not just
 * call `focus()` on an invisible window. These tests assert `showMainWindow` is
 * invoked when `getMainWindow` returns a hidden (non-destroyed) window on both
 * the marketplace-action branch and the mcp-login branch.
 *
 * MUTATION CONTRACT:
 *  - Reverting either `showMainWindow(mainWindow)` back to `mainWindow?.focus()`
 *    makes the matching test fail (the mocked showMainWindow is never called).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const showMainWindow = vi.fn();
const createWindow = vi.fn();
const getMainWindow = vi.fn();

vi.mock("electron", () => ({
  app: { isPackaged: false },
  dialog: {
    // Marketplace-uninstall with installed:false shows an info box then returns
    // before reaching any lifecycle import — keeps the test to the window path.
    showMessageBox: vi.fn(async () => ({ response: 0 })),
  },
}));
vi.mock("node:path", () => ({ resolve: (...p: string[]) => p.join("/") }));
vi.mock("../../i18n/index.js", () => ({ t: (k: string) => k }));
const sendToWindow = vi.fn();
vi.mock("../../ipc/safe-send.js", () => ({ sendToWindow: (...a: unknown[]) => sendToWindow(...a) }));
vi.mock("../../boot/types.js", () => ({ emitEvent: vi.fn() }));
vi.mock("../../shared/ave-home.js", () => ({ aveHome: () => "/tmp/ave" }));
vi.mock("../../plugins/install-lifecycle.js", () => ({ installMarketplacePluginWithLifecycle: vi.fn() }));
vi.mock("../../plugins/uninstall-lifecycle.js", () => ({ uninstallPluginWithLifecycle: vi.fn() }));
vi.mock("../../shared/network-access.js", () => ({
  buildNetworkAccessAcknowledgement: vi.fn(() => undefined),
  hasNetworkAccessDisclosure: vi.fn(() => false),
}));
// The mcp-login branch routes to the inline settings panel via
// `activateInlineSettings` (settings-inline-overhaul) — mock it so this test
// stays isolated from app-menu.js's heavy transitive graph (tray/window-manager
// /electron Menu), which would otherwise fail the bare `await import`.
const activateInlineSettings = vi.fn();
vi.mock("../app-menu.js", () => ({ activateInlineSettings: (...a: unknown[]) => activateInlineSettings(...a) }));
vi.mock("../main-window.js", () => ({
  createWindow: (...a: unknown[]) => createWindow(...a),
  getAppWindows: vi.fn(() => []),
  loadMainInterface: vi.fn(async () => undefined),
  registerMainWindowPluginEventBridge: vi.fn(),
  showMainWindow: (...a: unknown[]) => showMainWindow(...a),
}));

const getServices = vi.fn();
vi.mock("../app-state.js", () => ({
  getMainWindow: (...a: unknown[]) => getMainWindow(...a),
  getServices: (...a: unknown[]) => getServices(...a),
  setPendingAveUri: (...a: unknown[]) => setPendingAveUri(...a),
  setPendingGitMarketplaceLink: (...a: unknown[]) => setPendingGitMarketplaceLink(...a),
}));
const setPendingAveUri = vi.fn();
const setPendingGitMarketplaceLink = vi.fn();

function makeHiddenWindow() {
  // Hidden but NOT destroyed — the exact alive-but-hidden state a tray/hidden
  // launch produces.
  return { isDestroyed: vi.fn(() => false) };
}

function makeServices() {
  return {
    pluginMarketplace: {
      // Marketplace list drives resolveMarketplaceActionTarget → installed:false
      // so the uninstall path shows the "not installed" info dialog and returns.
      list: vi.fn(async () => [{ id: "test-plugin", slug: "test-plugin", name: "Test", installed: false }]),
    },
    mcpManager: { getConfigs: vi.fn(async () => []) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("handleAveUri surfaces a hidden window (MAJOR-1)", () => {
  it("marketplace-action branch calls showMainWindow on a hidden, non-destroyed window", async () => {
    const win = makeHiddenWindow();
    getMainWindow.mockReturnValue(win);
    getServices.mockReturnValue(makeServices());

    const { handleAveUri } = await import("../ave-deep-link.js");
    await handleAveUri("ave://uninstall/test-plugin");

    expect(showMainWindow).toHaveBeenCalledWith(win);
    // Existing live window → must NOT recreate one.
    expect(createWindow).not.toHaveBeenCalled();
  });

  it("mcp-login branch calls showMainWindow on a hidden, non-destroyed window", async () => {
    const win = makeHiddenWindow();
    getMainWindow.mockReturnValue(win);
    getServices.mockReturnValue(makeServices());

    const { handleAveUri } = await import("../ave-deep-link.js");
    await handleAveUri("ave://mcp-login/test-plugin");

    expect(showMainWindow).toHaveBeenCalledWith(win);
    expect(createWindow).not.toHaveBeenCalled();
  });
});

describe("handleAveUri git marketplace links (blueprint 4.6)", () => {
  const link = "ave://install/plugin/calendar@ave";

  it("holds the link for the marketplace tab, opens it, and tells an open tab to take it", async () => {
    vi.stubEnv("AVE_GIT_MARKETPLACE", "1");
    const win = makeHiddenWindow();
    getMainWindow.mockReturnValue(win);
    getServices.mockReturnValue(makeServices());

    const { handleAveUri } = await import("../ave-deep-link.js");
    await handleAveUri(link);

    expect(setPendingGitMarketplaceLink).toHaveBeenCalledWith({
      action: "install",
      key: { sourceId: "ave", kind: "plugin", name: "calendar" },
    });
    expect(activateInlineSettings).toHaveBeenCalledWith("marketplace");
    expect(sendToWindow).toHaveBeenCalledWith(win, "marketplace:deep-link", null, expect.anything());
    expect(setPendingAveUri).not.toHaveBeenCalled();
  });

  it("keeps the whole link for replay while the services are still starting", async () => {
    vi.stubEnv("AVE_GIT_MARKETPLACE", "1");
    getServices.mockReturnValue(null);

    const { handleAveUri } = await import("../ave-deep-link.js");
    await handleAveUri(link);

    expect(setPendingAveUri).toHaveBeenCalledWith(link);
    expect(setPendingGitMarketplaceLink).not.toHaveBeenCalled();
    expect(activateInlineSettings).not.toHaveBeenCalled();
  });

  it("ignores the link while the development switch is off, without falling through to the legacy parser", async () => {
    vi.stubEnv("AVE_GIT_MARKETPLACE", "");
    getMainWindow.mockReturnValue(makeHiddenWindow());
    getServices.mockReturnValue(makeServices());

    const { handleAveUri } = await import("../ave-deep-link.js");
    await handleAveUri(link);

    expect(setPendingGitMarketplaceLink).not.toHaveBeenCalled();
    expect(activateInlineSettings).not.toHaveBeenCalled();
    expect(showMainWindow).not.toHaveBeenCalled();
    expect(setPendingAveUri).not.toHaveBeenCalled();
  });
});
