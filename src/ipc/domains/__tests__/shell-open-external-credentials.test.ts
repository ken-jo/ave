// Exercise credential rejection through the real link producer and shell IPC consumer.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CHANNELS } from "../../../contract/app-contract.js";
import { makeAppIpcInvoker } from "./test-helpers.js";
import { createOnOpenLink } from "../../../ui/renderer/components/mcp-app-bridge/handlers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const openExternalSpy = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  shell: { openExternal: openExternalSpy },
}));

const invoke = makeAppIpcInvoker(handlers);

function makeDeps() {
  return {
    settingsService: {
      getAll: vi.fn(() => ({})),
      get: vi.fn(() => ({})),
      patch: vi.fn(async (p: unknown) => p),
      replaceLlm: vi.fn(async (l: unknown) => l),
      getSecret: vi.fn(() => null),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined),
    },
    conversationLoop: { refreshProvider: vi.fn() },
    sideChatConversationLoop: { refreshProvider: vi.fn() },
    auditLogger: { log: vi.fn() },
    getAppWindows: vi.fn(() => []),
  };
}

async function openLinkFromMcpApp(url: string): Promise<{ isError?: boolean }> {
  const { registerSettingsHandlers } = await import("../settings.js");
  registerSettingsHandlers(makeDeps() as never);
  const onOpenLink = createOnOpenLink({
    openLink: (u) => invoke(CHANNELS.shell.openExternal, u) as Promise<{ ok: boolean }>,
  });
  return (onOpenLink as (p: { url: string }) => Promise<{ isError?: boolean }>)({ url });
}

beforeEach(() => {
  handlers.clear();
  openExternalSpy.mockClear();
  vi.resetModules();
});

describe("shell.openExternal — MCP app open-link egress", () => {
  it("hands a plain https URL to shell.openExternal", async () => {
    const result = await openLinkFromMcpApp("https://example.com/docs");

    expect(openExternalSpy).toHaveBeenCalledWith("https://example.com/docs");
    expect(result).toEqual({});
  });

  it("never hands a credentialed URL to shell.openExternal, and reports isError", async () => {
    const result = await openLinkFromMcpApp("https://trusted.example@evil.tld/");

    expect(openExternalSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ isError: true });
  });

  it("never hands a password-only credentialed URL to shell.openExternal", async () => {
    const result = await openLinkFromMcpApp("https://:hunter2@evil.tld/pay");

    expect(openExternalSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ isError: true });
  });

  it("returns the structured verdict to the renderer for a credentialed URL", async () => {
    const { registerSettingsHandlers } = await import("../settings.js");
    registerSettingsHandlers(makeDeps() as never);

    const raw = await invoke(CHANNELS.shell.openExternal, "https://a:b@evil.tld/");

    expect(raw).toEqual({ ok: false, error: "embedded-credentials" });
    expect(openExternalSpy).not.toHaveBeenCalled();
  });
});
