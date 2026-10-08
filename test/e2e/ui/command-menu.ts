import type { ElectronApplication } from 'playwright';
import { UI } from '../../../src/shared/ipc-channels.js';

/**
 * The command button's menu is the OS's, so there is no popover to locate. What
 * the renderer builds for it crosses one IPC channel to main; these helpers
 * replace main's handler for that channel with one that records the payload and
 * shows nothing. The renderer side cannot be stubbed instead: the preload
 * bridge's objects are copies the page cannot patch.
 */

export type MenuRow = { id: string; label: string; submenu?: MenuRow[] };
export type MenuPayload = { requestId: string; x: number; y: number; sections: Array<{ items: MenuRow[] }> };

/** Record every menu the renderer asks main to show, from now on, instead of showing it. */
export async function captureCommandMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }, channel) => {
    const captured: unknown[] = [];
    (globalThis as { __aveMenuPayloads?: unknown[] }).__aveMenuPayloads = captured;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, payload: unknown) => {
      captured.push(payload);
      return { ok: true };
    });
  }, UI.dynamicMenu);
}

/** The menus recorded since {@link captureCommandMenus}, oldest first. */
export async function capturedCommandMenus(app: ElectronApplication): Promise<MenuPayload[]> {
  return app.evaluate(() => ((globalThis as { __aveMenuPayloads?: unknown[] }).__aveMenuPayloads ?? []) as MenuPayload[]);
}

/** The ids of a menu's rows and of the rows of each submenu. */
export function menuRowIds(payload: MenuPayload): string[] {
  return payload.sections
    .flatMap((section) => section.items)
    .flatMap((row) => [row.id, ...(row.submenu ?? []).map((leaf) => leaf.id)]);
}
