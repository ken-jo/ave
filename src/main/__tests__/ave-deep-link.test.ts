/**
 * `handleAveUri` routes (design §16.2): a git marketplace link is held for
 * the marketplace tab and only opens its confirming UI; a link that arrives
 * before the services is kept whole for replay; the server-era slug and
 * mcp-login forms are refused; a plugin OAuth callback becomes a host event.
 * Surfacing a hidden window is `activateInlineSettings`'s job.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
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
vi.mock("../app-state.js", () => ({
  getMainWindow: (...a: unknown[]) => getMainWindow(...a),
  getServices: (...a: unknown[]) => getServices(...a),
  setPendingAveUri: (...a: unknown[]) => setPendingAveUri(...a),
  setPendingGitMarketplaceLink: (...a: unknown[]) => setPendingGitMarketplaceLink(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleAveUri", () => {
  const link = "ave://install/plugin/calendar@ave";

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

  it("re-emits a plugin OAuth callback as a host event", async () => {
    const code = "abcdefghijklmnop1234";
    const { handleAveUri } = await import("../ave-deep-link.js");
    await handleAveUri(`ave://plugin-auth/calendar?code=${code}`);
    expect(emitEvent).toHaveBeenCalledWith("plugin.auth.code.received", { pluginId: "calendar", code });
  });
});
