import { closeSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export const WINDOWS_NOTIFICATION_CLEANUP_LOCK = ".ave-notification-cleanup.lock";
const CLEANUP_LOCK_MARKER = Buffer.from("Ave notification cleanup v1", "ascii");

export function isWindowsNotificationCleanupInProgress(appDataDir: string): boolean {
  try {
    const fd = openSync(join(appDataDir, WINDOWS_NOTIFICATION_CLEANUP_LOCK), "r");
    try {
      // The cleanup writes its marker after acquiring an exclusive lock on byte zero.
      const marker = Buffer.alloc(CLEANUP_LOCK_MARKER.length + 1);
      const size = readSync(fd, marker, 0, marker.length, 1);
      if (size !== CLEANUP_LOCK_MARKER.length || !marker.subarray(0, size).equals(CLEANUP_LOCK_MARKER)) return false;
      try {
        readSync(fd, marker, 0, 1, 0);
        return false;
      } catch (cause) {
        // Windows reports a read of the locked byte as EBUSY.
        return (cause as NodeJS.ErrnoException).code === "EBUSY";
      }
    } finally {
      try {
        closeSync(fd);
      } catch {
        // The probe result is independent of descriptor disposal.
      }
    }
  } catch {
    return false;
  }
}
