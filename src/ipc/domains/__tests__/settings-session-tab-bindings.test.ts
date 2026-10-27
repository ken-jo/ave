import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { hostFrameEvent } from "../../../__tests__/test-helpers.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { browserTabRegistry } from "../../../main/browser/browser-tab-registry.js";
import type { MainLayoutSnapshot } from "../../../shared/main-layout.js";
import { registerSettingsHandlers } from "../settings.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const primarySender = { id: 50 };
const secondarySender = { id: 60 };
vi.mock("electron", () => ({ ipcMain: {
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
} }));
vi.mock("../../../main/app-state.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../main/app-state.js")>(),
  getPrimaryMainWindow: () => ({ id: 7 }),
  mainWindowForContents: (sender: unknown) => sender === primarySender ? { id: 7 } : sender === secondarySender ? { id: 8 } : null,
}));

let directory: string;
let settings: SettingsService;

function layout(): MainLayoutSnapshot {
  return { version: 1, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main", surfaces: {}, panelOpenIds: [], thumbnailOpenIds: [],
    sideTabs: { main: [{ kind: "terminal", tabId: "terminal:0000000a-1", ordinal: 1, cwd: "/work", url: null }] } };
}

function update(sender: unknown, snapshot: unknown): Promise<unknown> {
  return Promise.resolve(handlers.get(CHANNELS.settings.update)!({ ...hostFrameEvent(), sender }, { system: { mainLayout: snapshot } }));
}

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "ave-binding-layout-ipc-"));
  settings = new SettingsService({ userDataPath: directory, encryption: unavailableSecretEncryption });
  await settings.patch({ system: { ...settings.get("system"), mainLayout: layout() } });
  browserTabRegistry.__reset();
  browserTabRegistry.setBindingPersistence({
    savedWindowId: () => 7,
    load: (id) => id === 7 ? settings.get("system").mainLayout : undefined,
    save: async (id, snapshot) => { if (id === 7) await settings.patch({ system: { ...settings.get("system"), mainLayout: snapshot } }); },
    sessionExists: () => true,
  });
  registerSettingsHandlers({ settingsService: settings, conversationLoop: { refreshProvider: vi.fn() }, auditLogger: { log: vi.fn() }, getAppWindows: () => [] } as never);
});

afterEach(async () => {
  await browserTabRegistry.flushBindingWrites();
  browserTabRegistry.__reset();
  handlers.clear();
  await cleanupTmpDir(directory);
});

describe("main-owned bindings in layout IPC", () => {
  it("decorates geometry from main state and ignores a forged renderer association", async () => {
    browserTabRegistry.bindConversationSurface("actual-session", { windowId: 7, surface: { kind: "terminal", tabId: "terminal:0000000a-1" } });
    const forged = layout();
    forged.sideTabs.main![0]!.binding = { paneSessionId: "forged-session" };
    await update(primarySender, forged);
    expect(settings.get("system").mainLayout?.sideTabs.main?.[0]?.binding).toEqual({ paneSessionId: "actual-session" });
    const reloaded = new SettingsService({ userDataPath: directory, encryption: unavailableSecretEncryption });
    expect(reloaded.get("system").mainLayout?.sideTabs.main?.[0]?.binding).toEqual({ paneSessionId: "actual-session" });
  });

  it("refuses secondary-window and malformed layout writes without changing saved tabs", async () => {
    expect(await update(secondarySender, layout())).toEqual({ ok: false, error: "bad-request" });
    expect(await update(primarySender, { version: 99 })).toEqual({ ok: false, error: "invalid-input" });
    expect(settings.get("system").mainLayout).toEqual(layout());
  });
});
