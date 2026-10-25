import type { WebContents } from "electron";

const windowControlOwnedIds = new Set<number>();

// Explicitly allow only host-owned shell contents for data-URL window controls; embedded remote content stays sandboxed.
export function markAsWindowControlOwned(contents: WebContents): void {
  const id = contents.id;
  windowControlOwnedIds.add(id);
  const drop = () => {
    windowControlOwnedIds.delete(id);
  };
  contents.once("destroyed", drop);
  contents.once("render-process-gone", drop);
}

export function isWindowControlOwned(contents: WebContents | null | undefined): boolean {
  return !!contents && windowControlOwnedIds.has(contents.id);
}
