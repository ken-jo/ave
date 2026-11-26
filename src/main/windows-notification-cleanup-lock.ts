import { closeSync, openSync } from "node:fs";
import { join } from "node:path";

/** Held open without sharing by build/uninstall-windows-notification-artifacts.ps1 for its whole run, in the user's roaming AppData folder. */
export const WINDOWS_NOTIFICATION_CLEANUP_LOCK = ".ave-notification-cleanup.lock";

/**
 * True while this user's uninstall notification cleanup holds its lock. The cleanup takes the lock and then requires that the
 * user has no Ave process, so a process that probes here before provisioning notification artifacts either was seen by that
 * check or sees the lock. Only a missing file or a successful open means free; any other error counts as held.
 */
export function isWindowsNotificationCleanupInProgress(appDataDir: string): boolean {
  let fd: number;
  try {
    fd = openSync(join(appDataDir, WINDOWS_NOTIFICATION_CLEANUP_LOCK), "r");
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code !== "ENOENT";
  }
  closeSync(fd);
  return false;
}
