import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { appOwnedSandboxActionRoot } from "../shared/sandbox-private-paths.js";

export interface SandboxActionDirectory {
  readonly path: string;
  cleanup(): void;
}

const liveDirectories = new Map<string, { directory: SandboxActionDirectory; device: bigint; inode: bigint }>();

export function sandboxActionDirectoriesInUse(): ReadonlySet<string> {
  return new Set(liveDirectories.keys());
}

/** Only directories minted by this host generation can receive an action write exception. */
export function isSandboxActionDirectory(path: string): boolean {
  const entry = liveDirectories.get(path);
  if (!entry) return false;
  try {
    const info = lstatSync(path, { bigint: true });
    return info.isDirectory() && info.dev === entry.device && info.ino === entry.inode && realpathSync.native(path) === path;
  }
  catch { return false; }
}

/** Release only a directory minted by this host; no caller-selected filesystem target is accepted. */
export function releaseSandboxActionDirectory(path: string): void {
  liveDirectories.get(path)?.directory.cleanup();
}

export function createSandboxActionDirectory(): SandboxActionDirectory {
  const root = appOwnedSandboxActionRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!lstatSync(root).isDirectory()) throw new Error("Invalid sandbox action root");
  const parent = realpathSync.native(root);
  const created = mkdtempSync(join(parent, "action-"));
  const path = realpathSync.native(created);
  if (!lstatSync(created).isDirectory() || dirname(path) !== parent) {
    rmSync(created, { recursive: true, force: true });
    throw new Error("Invalid sandbox action directory");
  }
  const info = lstatSync(path, { bigint: true });
  const directory: SandboxActionDirectory = {
    path,
    cleanup: () => {
      if (liveDirectories.get(path)?.directory !== directory) return;
      try {
        if (!isSandboxActionDirectory(path)) {
          lstatSync(path);
          throw new Error("Sandbox action directory identity changed");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      rmSync(path, { recursive: true, force: true });
      liveDirectories.delete(path);
    },
  };
  liveDirectories.set(path, { directory, device: info.dev, inode: info.ino });
  return directory;
}
