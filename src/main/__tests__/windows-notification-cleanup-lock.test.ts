import { afterEach, expect, it, vi } from "vitest";
import { isWindowsNotificationCleanupInProgress } from "../windows-notification-cleanup-lock.js";

const io = vi.hoisted(() => ({ openSync: vi.fn(), readSync: vi.fn(), closeSync: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:fs")>()), ...io }));

afterEach(() => vi.resetAllMocks());

it.each(["EBUSY", "EPERM", "EACCES"])("continues startup when opening the cleanup lock returns %s", (code) => {
  io.openSync.mockImplementationOnce(() => { throw Object.assign(new Error(code), { code }); });

  expect(isWindowsNotificationCleanupInProgress("fixture")).toBe(false);
});

it("continues startup when closing an unverified cleanup lock fails", () => {
  io.openSync.mockReturnValueOnce(1);
  io.readSync.mockReturnValueOnce(0);
  io.closeSync.mockImplementationOnce(() => { throw new Error("close failed"); });

  expect(isWindowsNotificationCleanupInProgress("fixture")).toBe(false);
});
