import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { SETTINGS } from "../../../shared/ipc-channels.js";
import { apiRoundLlmSettings } from "../../../engine/turn/round-llm-settings.js";
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

describe("thinking budget settings IPC", () => {
  // Stored budgets retain intent. Numeric requests use the highest preset below output,
  // or output minus one when no preset fits; effort still comes from the original budget.
  it.each([
    [32_000, 32_000, 16_000, "xhigh"],
    [32_000, 16_000, 8_000, "xhigh"],
    [32_000, 32_001, 32_000, "xhigh"],
    [32_000, 2_000, 1_999, "xhigh"],
    [64_000, 2_000, 1_999, "max"],
    [14_000, 2_000, 1_999, "high"],
  ] as const)(
    "preserves budget %i with output %i through persistence and broadcast, bounding only the request", async (thinkingBudgetTokens, outputTokenLimit, requestBudget, effort) => {
      userDataPath = mkdtempSync(join(tmpdir(), "thinking-settings-ipc-"));
      const settingsService = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      const send = vi.fn();
      const { registerSettingsHandlers } = await import("../settings.js");
      registerSettingsHandlers({
        settingsService,
        conversationLoop: { refreshProvider: vi.fn() },
        auditLogger: { log: vi.fn() },
        getAppWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }],
        singleHopNetworkFetch: vi.fn(),
      } as never);

      await invoke(CHANNELS.settings.update, {
        llm: { vendors: { openai: { outputTokenLimit, thinkingBudgetTokens } } },
      });
      const expectedBlock = {
        model: "", enableThinking: true, outputTokenLimit, outputTokenLimitSetByUser: true, thinkingBudgetTokens,
      };
      const stored = settingsService.get("llm").vendors.openai!;
      expect(stored).toEqual(expectedBlock);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(SETTINGS.updated, expect.objectContaining({
        llm: expect.objectContaining({ vendors: expect.objectContaining({
          openai: expectedBlock,
        }) }),
      }));
      const reloaded = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
      expect(reloaded.get("llm").vendors.openai).toEqual(expectedBlock);

      const round = apiRoundLlmSettings(stored, {
        requested: outputTokenLimit, requestedSource: "user", effective: outputTokenLimit, effectiveSource: "user",
      }, "none");
      expect(round).toMatchObject({
        outputTokenLimit, requestedThinkingBudgetTokens: thinkingBudgetTokens,
        thinkingBudgetTokens: requestBudget, reasoningEffort: effort,
      });
      expect(settingsService.get("llm").vendors.openai).toEqual(expectedBlock);
    },
  );
});
