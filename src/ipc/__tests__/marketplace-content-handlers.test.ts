/**
 * The installed-content IPC (blueprint P3): the `ave-content:` handler is
 * registered with the IPC handlers, before any window loads (a frame binds
 * its scheme loaders when it commits); nothing is loaded until the renderer
 * or an asset request first asks, the load runs once, and a failed load
 * answers "unavailable" (IPC) or 404 (assets) instead of throwing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  protocolHandle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
  protocol: { handle: electron.protocolHandle },
}));

vi.mock("../gated.js", () => ({
  auditUnauthorized: vi.fn(),
  UNAUTHORIZED_FRAME: { ok: false, error: "unauthorized" },
  validateHostRendererSender: () => true,
}));

import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { registerMarketplaceContentHandlers } from "../domains/marketplace-content.js";

const content = { themes: [], languages: [], fonts: [], broken: [] };
const port = {
  installed: () => content,
  languageMessages: (locale: string) => {
    if (locale !== "fr") throw new Error(`${locale} is not installed`);
    return { "app.title": "Ave" };
  },
  servedFile: () => null,
};

type SchemeHandler = (request: { url: string }) => Promise<Response>;
const schemeHandler = (): SchemeHandler => {
  expect(electron.protocolHandle).toHaveBeenCalledWith("ave-content", expect.any(Function));
  return electron.protocolHandle.mock.calls[0]![1] as SchemeHandler;
};

describe("registerMarketplaceContentHandlers", () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.protocolHandle.mockClear();
  });

  it("registers the scheme handler up front and loads once, on the first request", async () => {
    const load = vi.fn(async () => port);
    registerMarketplaceContentHandlers({} as IpcDeps, load);
    schemeHandler();
    expect(load).not.toHaveBeenCalled();

    const installed = electron.handlers.get(CHANNELS.marketplaceContent.installed)!;
    const languageMessages = electron.handlers.get(CHANNELS.marketplaceContent.languageMessages)!;
    await expect(installed({})).resolves.toEqual({ ok: true, content });
    await expect(languageMessages({}, "fr")).resolves.toEqual({ ok: true, messages: { "app.title": "Ave" } });
    await expect(languageMessages({}, "de")).resolves.toMatchObject({ ok: false, error: "language-not-installed" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("serves an asset request through the same load, even before the renderer asks", async () => {
    const servedFile = vi.fn(() => null);
    const load = vi.fn(async () => ({ ...port, servedFile }));
    registerMarketplaceContentHandlers({} as IpcDeps, load);
    const response = await schemeHandler()({ url: "ave-content://font/harbor-serif/files/a.woff2" });
    expect(response.status).toBe(404);
    expect(servedFile).toHaveBeenCalledWith("font", "harbor-serif", "files/a.woff2");
    await electron.handlers.get(CHANNELS.marketplaceContent.installed)!({});
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("answers unavailable when the store cannot be loaded", async () => {
    registerMarketplaceContentHandlers({} as IpcDeps, async () => {
      throw new Error("ledger unreadable");
    });
    await expect(electron.handlers.get(CHANNELS.marketplaceContent.installed)!({})).resolves.toEqual({ ok: false, error: "installed-content-unavailable" });
    await expect(electron.handlers.get(CHANNELS.marketplaceContent.languageMessages)!({}, "fr")).resolves.toEqual({ ok: false, error: "installed-content-unavailable" });
    expect((await schemeHandler()({ url: "ave-content://font/harbor-serif/files/a.woff2" })).status).toBe(404);
  });
});
