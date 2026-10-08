/**
 * First-boot bootstrap status surface.
 *
 * The marketplace boot pass (default and required installs, design §10.2)
 * runs once after boot and is graceful by design: an unreachable source or a
 * per-package install failure never throws out of `boot()`. Without a status
 * those outcomes would be silent — only `log.warn` lines, nothing the user
 * could see.
 *
 * This module emits a status snapshot to the renderer over
 * `CHANNELS.bootstrap.status` — the contract is the only place that channel
 * is spelled, here as in the preload bridge — so a small banner / toast can
 * surface "X plugins pending, retry?". Three lifecycle states are reported:
 *   - `start`       — bootstrap call enqueued (renderer can show a spinner)
 *   - `complete`    — finished; payload lists installed + failed + skipped
 *   - `error`       — bootstrap itself threw (catalog fetch failure, etc.)
 *
 * The renderer subscribes via `window.ave.onBootstrapStatus`, but on a cold
 * boot the whole sequence is already over before the renderer exists:
 * `main.ts` awaits `bootstrap()` while the window still shows the splash
 * document, so every send lands on a webContents with no listener. Each
 * snapshot is therefore also recorded in module state and served over
 * `CHANNELS.bootstrap.statusGet`, which the renderer hook pulls once on
 * mount — a live event that arrives first always wins over the pull, so the
 * older snapshot can never overwrite a newer event. The record is
 * process-lifetime only: nothing is written to disk, and the next boot
 * re-emits from the cached registry state.
 */

import type { BrowserWindow } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import type { AppBootstrapStatus } from "../shared/bootstrap-status.js";

/**
 * The last snapshot passed to `notifyBootstrapStatus`, or `null` before the
 * first one. Process-lifetime only.
 */
let recordedStatus: AppBootstrapStatus | null = null;

/**
 * The last bootstrap status this process reported. `CHANNELS.bootstrap.statusGet`
 * serves it so a renderer that mounted after boot still sees the outcome.
 */
export function latestBootstrapStatus(): AppBootstrapStatus | null {
  return recordedStatus;
}

/**
 * Record a bootstrap status snapshot and send it to the renderer. Safe to
 * call before the window is ready — the send is best-effort and silent on
 * failure, and the record is what a late-mounting renderer reads back over
 * `CHANNELS.bootstrap.statusGet`.
 */
export function notifyBootstrapStatus(
  mainWindow: BrowserWindow | null | undefined,
  status: AppBootstrapStatus,
): void {
  // Recorded before the send gate: a cold boot has no listener yet, and that
  // is precisely the case the pull exists to cover.
  recordedStatus = status;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send(CHANNELS.bootstrap.status, status);
  } catch {
    // Best-effort: a destroyed/loading webContents shouldn't take down boot.
  }
}
