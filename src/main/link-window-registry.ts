// Only registered external-link webContents bypass the global webview guard; scoped navigation guards remain responsible.
import type { WebContents } from "electron";

const linkOwnedIds = new Set<number>();

export function markAsLinkOwned(contents: WebContents): void {
  const id = contents.id;
  linkOwnedIds.add(id);
  const drop = () => {
    linkOwnedIds.delete(id);
  };
  contents.once("destroyed", drop);
  contents.once("render-process-gone", drop);
}

export function isLinkOwned(contents: WebContents): boolean {
  return linkOwnedIds.has(contents.id);
}
