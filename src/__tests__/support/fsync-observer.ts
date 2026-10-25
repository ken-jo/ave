/** Count FileHandle.sync calls so durability assertions fail for unsynced rename-only writes. */
import { promises as fsp } from "node:fs";

export interface FileHandleSyncObserver {
  calls(): number;
  /** Restore the patched open function in finally. */
  restore(): void;
}

export function observeFileHandleSyncs(): FileHandleSyncObserver {
  const realOpen = fsp.open.bind(fsp);
  let calls = 0;
  const patched = (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await realOpen(...(args as [never]));
    const realSync = handle.sync.bind(handle);
    (handle as { sync: () => Promise<void> }).sync = async () => {
      calls += 1;
      return realSync();
    };
    return handle;
  }) as typeof fsp.open;
  (fsp as { open: typeof fsp.open }).open = patched;
  return {
    calls: () => calls,
    restore: () => {
      (fsp as { open: typeof fsp.open }).open = realOpen;
    },
  };
}
