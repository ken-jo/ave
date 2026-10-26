import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

// Shell isolation and plugin-worker confinement are independent settings.
import { afterEach, describe, expect, it, vi } from "vitest";
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
let userDataPath: string;

afterEach(async () => {
  handlers.clear();
  await cleanupTmpDir(userDataPath);
});

describe("shell sandbox checkbox write", () => {
  it.each([
    [false, true, true],
    [true, false, true],
    [false, true, false],
    [true, false, false],
  ])(
    "osToolSandbox %s -> %s leaves pluginWorkerConfinement=%s untouched",
    async (shellBefore, shellAfter, workers) => {
      userDataPath = mkdtempSync(join(tmpdir(), "shell-sandbox-scope-ipc-"));
      const settingsService = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      await settingsService.patch({ features: { osToolSandbox: shellBefore, pluginWorkerConfinement: workers } });
      const { registerSettingsHandlers } = await import("../settings.js");
      registerSettingsHandlers({
        settingsService,
        conversationLoop: { refreshProvider: vi.fn() },
        auditLogger: { log: vi.fn() },
        getAppWindows: () => [],
        singleHopNetworkFetch: vi.fn(),
      } as never);

      const result = await invoke(CHANNELS.settings.update, { features: { osToolSandbox: shellAfter } });

      expect(result).not.toMatchObject({ ok: false });
      expect(settingsService.get("features")?.osToolSandbox).toBe(shellAfter);
      expect(settingsService.get("features")?.pluginWorkerConfinement).toBe(workers);
      const reread = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      expect(reread.get("features")?.osToolSandbox).toBe(shellAfter);
      expect(reread.get("features")?.pluginWorkerConfinement).toBe(workers);
    },
  );
});
