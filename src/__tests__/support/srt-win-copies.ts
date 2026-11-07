/** The product keeps each private srt-win helper copy until process exit (`prepareSrtWinExecutable`), and a Vitest worker is torn
 * down without running exit handlers, so a test file that prepares a copy must remove it. Record every copy the file makes, from
 * every module instance including those re-imported after `vi.resetModules()`, and remove exactly those, non-recursively as the
 * product does. The temp root is shared by every file running in parallel, so a pattern sweep would delete another file's live copy. */
import { existsSync, rmSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { retryOnTransientFsLock } from "../../lib/transient-fs-lock-retry.js";
import type * as SrtWinIntegrity from "../../permissions/srt-win-integrity.js";

/** `vi.mock` factory body: the real module, with `prepareSrtWinExecutable` recording each copy it returns into `made`. */
export function recordSrtWinCopies(original: typeof SrtWinIntegrity, made: Set<string>): typeof SrtWinIntegrity {
  return {
    ...original,
    prepareSrtWinExecutable: (...args: Parameters<typeof original.prepareSrtWinExecutable>) => {
      const executable = original.prepareSrtWinExecutable(...args);
      made.add(executable);
      return executable;
    },
  };
}

/** Remove the recorded copies: the two known files, then `bin` and its private outer directory. */
export async function removeSrtWinCopies(made: Set<string>): Promise<void> {
  for (const executable of made) {
    const bin = dirname(executable);
    await retryOnTransientFsLock(async () => {
      for (const name of ["srt-win.exe", "owner.json"]) rmSync(join(bin, name), { force: true });
      if (existsSync(bin)) rmdirSync(bin);
      if (existsSync(dirname(bin))) rmdirSync(dirname(bin));
    });
  }
  made.clear();
}
