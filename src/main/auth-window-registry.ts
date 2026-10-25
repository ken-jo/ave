// Only registered auth webContents bypass the global navigation guard; their scoped guards remain responsible. Clear ownership on destruction and
// renderer loss so reused IDs cannot inherit it.
import type { WebContents } from "electron";

const authOwnedIds = new Set<number>();

// Tag a webContents as belonging to an auth-window flow. The host-level navigation guard will defer to the auth-window's own scoped policy for any webContents tagged here.
export function markAsAuthOwned(contents: WebContents): void {
  const id = contents.id;
  authOwnedIds.add(id);
  const drop = () => {
    authOwnedIds.delete(id);
  };
  contents.once("destroyed", drop);
  contents.once("render-process-gone", drop);
}

// Whether the given webContents was registered as auth-owned.
export function isAuthOwned(contents: WebContents): boolean {
  return authOwnedIds.has(contents.id);
}
