/**
 * The installed-content IPC (blueprint P3): nothing is loaded and no scheme
 * handler is installed until the renderer first asks, the load runs once,
 * and a failed load answers "unavailable" instead of throwing.
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

describe("registerMarketplaceContentHandlers", () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.protocolHandle.mockClear();
  });

  it("loads once, on the first request, and installs the scheme handler before answering", async () => {
    const load = vi.fn(async () => port);
    registerMarketplaceContentHandlers({} as IpcDeps, load);
    expect(load).not.toHaveBeenCalled();
    expect(electron.protocolHandle).not.toHaveBeenCalled();

    const installed = electron.handlers.get(CHANNELS.marketplaceContent.installed)!;
    const languageMessages = electron.handlers.get(CHANNELS.marketplaceContent.languageMessages)!;
    await expect(installed({})).resolves.toEqual({ ok: true, content });
    expect(electron.protocolHandle).toHaveBeenCalledWith("ave-content", expect.any(Function));
    await expect(languageMessages({}, "fr")).resolves.toEqual({ ok: true, messages: { "app.title": "Ave" } });
    await expect(languageMessages({}, "de")).resolves.toMatchObject({ ok: false, error: "language-not-installed" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("answers unavailable when the store cannot be loaded", async () => {
    registerMarketplaceContentHandlers({} as IpcDeps, async () => {
      throw new Error("ledger unreadable");
    });
    await expect(electron.handlers.get(CHANNELS.marketplaceContent.installed)!({})).resolves.toEqual({ ok: false, error: "installed-content-unavailable" });
    await expect(electron.handlers.get(CHANNELS.marketplaceContent.languageMessages)!({}, "fr")).resolves.toEqual({ ok: false, error: "installed-content-unavailable" });
    expect(electron.protocolHandle).not.toHaveBeenCalled();
  });
});
