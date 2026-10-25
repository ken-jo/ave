import { beforeEach, describe, expect, it, vi } from "vitest";

const electronApp = vi.hoisted(() => ({ isPackaged: false }));
vi.mock("electron", () => ({ app: electronApp }));
const warn = vi.fn();
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: (...a: unknown[]) => warn(...a), error: vi.fn(), debug: vi.fn() }),
}));
const sendToWindow = vi.fn();
vi.mock("../../ipc/safe-send.js", () => ({ sendToWindow: (...a: unknown[]) => sendToWindow(...a) }));
const emitEvent = vi.fn();
vi.mock("../../boot/types.js", () => ({ emitEvent: (...a: unknown[]) => emitEvent(...a) }));
const activateInlineSettings = vi.fn();
vi.mock("../app-menu.js", () => ({ activateInlineSettings: (...a: unknown[]) => activateInlineSettings(...a) }));
const getMainWindow = vi.fn();
const getServices = vi.fn();
const setPendingAveUri = vi.fn();
const setPendingGitMarketplaceLink = vi.fn();
let lifetime = new AbortController();
vi.mock("../app-state.js", () => ({
  getMarketplaceLifetime: () => lifetime,
  getMainWindow: (...a: unknown[]) => getMainWindow(...a),
  getServices: (...a: unknown[]) => getServices(...a),
  setPendingAveUri: (...a: unknown[]) => setPendingAveUri(...a),
  setPendingGitMarketplaceLink: (...a: unknown[]) => setPendingGitMarketplaceLink(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  electronApp.isPackaged = false;
  lifetime = new AbortController();
});

describe("handleAveUri", () => {
  const link = "ave://install/plugin/calendar@ave";

  it("refuses a git marketplace link once the marketplace's lifetime has ended: nothing is held, opened or sent", async () => {
    getMainWindow.mockReturnValue({ isDestroyed: () => false });
    getServices.mockReturnValue({});
    lifetime.abort();

    const { handleAveUri } = await import("../ave-deep-link.js");
    await handleAveUri(link);

    expect(setPendingGitMarketplaceLink).not.toHaveBeenCalled();
    expect(setPendingAveUri).not.toHaveBeenCalled();
    expect(activateInlineSettings).not.toHaveBeenCalled();
    expect(sendToWindow).not.toHaveBeenCalled();
  });

  it("holds a git marketplace link for the tab, opens it, and tells an open tab to take it", async () => {
    const win = { isDestroyed: () => false };
    getMainWindow.mockReturnValue(win);
    getServices.mockReturnValue({});

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
    getServices.mockReturnValue(null);

    const { handleAveUri } = await import("../ave-deep-link.js");
    await handleAveUri(link);

    expect(setPendingAveUri).toHaveBeenCalledWith(link);
    expect(setPendingGitMarketplaceLink).not.toHaveBeenCalled();
    expect(activateInlineSettings).not.toHaveBeenCalled();
  });

  it("refuses the server-era slug and mcp-login links, even before the services start", async () => {
    getServices.mockReturnValue(null);

    const { handleAveUri } = await import("../ave-deep-link.js");
    for (const url of ["ave://install/calendar", "ave://uninstall/plugin/calendar", "ave://mcp-login/context7-mcp"]) {
      await handleAveUri(url);
    }

    expect(setPendingAveUri).not.toHaveBeenCalled();
    expect(setPendingGitMarketplaceLink).not.toHaveBeenCalled();
    expect(activateInlineSettings).not.toHaveBeenCalled();
  });

  it("logs a refused link in a packaged build too, without its query", async () => {
    electronApp.isPackaged = true;

    const { handleAveUri } = await import("../ave-deep-link.js");
    await handleAveUri("ave://install/calendar?token=secret#frag");

    expect(warn).toHaveBeenCalledWith({ link: "ave://install/calendar" }, expect.stringContaining("unrecognized"));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });

  it("re-emits a plugin OAuth callback as a host event", async () => {
    const code = "abcdefghijklmnop1234";
    const { handleAveUri } = await import("../ave-deep-link.js");
    await handleAveUri(`ave://plugin-auth/calendar?code=${code}`);
    expect(emitEvent).toHaveBeenCalledWith("plugin.auth.code.received", { pluginId: "calendar", code });
  });
});
