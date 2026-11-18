import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { createAutoUpdater, type UpdaterLike } from "../auto-updater.js";
import { hostFrameEvent, foreignFrameEvent } from "../../__tests__/test-helpers.js";
import type { AuditLogger } from "../../audit/audit-logger.js";

const stops: Array<() => void> = [];
afterEach(() => { for (const stop of stops.splice(0)) stop(); });

function updateCheckHarness() {
  const checkForUpdates = vi.fn(async () => undefined);
  const updater = { on: vi.fn(), checkForUpdates, downloadUpdate: vi.fn(), quitAndInstall: vi.fn() } as unknown as UpdaterLike;
  const log = vi.fn();
  const service = createAutoUpdater({
    getWindows: () => [], getDialogParent: () => null as BrowserWindow | null,
    isEnabled: () => false, updaterFactory: () => updater,
    auditLogger: { log } as unknown as AuditLogger,
  });
  stops.push(service.stop);
  return { service, checkForUpdates, log, updater };
}

describe("manual app update checks", () => {
  it("checks on a user request even with automatic checks disabled, without downloading", async () => {
    const { service, checkForUpdates, updater } = updateCheckHarness();
    await service.triggerCheck();
    expect(checkForUpdates).not.toHaveBeenCalled();
    await expect(service._testOnly.ipcCheckNow(hostFrameEvent())).resolves.toEqual({ ok: true });
    expect(checkForUpdates).toHaveBeenCalledExactlyOnceWith();
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it("surfaces a failed manual check instead of reporting completion", async () => {
    const { service, checkForUpdates } = updateCheckHarness();
    checkForUpdates.mockRejectedValueOnce(new Error("feed unavailable"));
    await expect(service._testOnly.ipcCheckNow(hostFrameEvent())).resolves.toEqual({ ok: false, reason: "update-check-failed" });
  });

  it("rejects a foreign sender before network access and records the refusal", async () => {
    const { service, checkForUpdates, log } = updateCheckHarness();
    await expect(service._testOnly.ipcCheckNow(foreignFrameEvent("https://untrusted.example/"))).resolves.toEqual({ ok: false, reason: "unauthorized-frame" });
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ input: expect.stringContaining("ave:update:check-now") }));
  });
});
