import type { ElectronApplication } from 'playwright';
import { UI } from '../../../src/shared/ipc-channels.js';

// Record native-menu requests at main IPC because the renderer bridge cannot be patched.

export type MenuRow = { id: string; label: string; submenu?: MenuRow[] };
export type MenuPayload = { requestId: string; x: number; y: number; sections: Array<{ items: MenuRow[] }> };

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

export async function capturedCommandMenus(app: ElectronApplication): Promise<MenuPayload[]> {
  return app.evaluate(() => ((globalThis as { __aveMenuPayloads?: unknown[] }).__aveMenuPayloads ?? []) as MenuPayload[]);
}

export function menuRowIds(payload: MenuPayload): string[] {
  return payload.sections
    .flatMap((section) => section.items)
    .flatMap((row) => [row.id, ...(row.submenu ?? []).map((leaf) => leaf.id)]);
}
