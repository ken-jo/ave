import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { makeAppIpcInvoker } from "./test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)) },
}));
const invoke = makeAppIpcInvoker(handlers);
let directory: string;
let settingsService: SettingsService;

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "document-settings-ipc-"));
  settingsService = new SettingsService({ userDataPath: directory, encryption: unavailableSecretEncryption });
  const { registerSettingsHandlers } = await import("../settings.js");
  registerSettingsHandlers({
    settingsService,
    conversationLoop: { refreshProvider: vi.fn() },
    auditLogger: { log: vi.fn() },
    getAppWindows: () => [],
    singleHopNetworkFetch: vi.fn(),
  } as never);
});
afterEach(async () => { handlers.clear(); await cleanupTmpDir(directory); });

describe("document settings user transport", () => {
  it.each(["direct", "link"] as const)("accepts the user's %s choice through guarded settings IPC", async (openMode) => {
    const result = await invoke(CHANNELS.settings.update, { documents: { openMode } });
    expect(result).toHaveProperty("documents.openMode", openMode);
    expect(settingsService.get("documents").openMode).toBe(openMode);
    expect(new SettingsService({ userDataPath: directory, encryption: unavailableSecretEncryption }).get("documents").openMode).toBe(openMode);
  });
});
