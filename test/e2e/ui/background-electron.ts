import { execFileSync } from "node:child_process";
import { constants, cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

let backgroundExecutable: string | undefined;

/** Bundle metadata prevents launch-time activation before the main entrypoint can apply its test policy. */
export function resolveE2eExecutable(options: { executablePath?: string; env?: Record<string, string | undefined> } | undefined): string | undefined {
  if (process.platform !== "darwin" || options?.executablePath || options?.env?.AVE_NATIVE_FIXTURE_MODE === "foreground") return options?.executablePath;
  if (backgroundExecutable) return backgroundExecutable;
  const executable = createRequire(import.meta.url)("electron") as string;
  const root = mkdtempSync(join(tmpdir(), "ave-e2e-background-"));
  const bundle = join(root, "Electron.app");
  try {
    cpSync(dirname(dirname(dirname(executable))), bundle, { recursive: true, mode: constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    const plist = join(bundle, "Contents", "Info.plist");
    execFileSync("/usr/bin/plutil", ["-replace", "LSUIElement", "-bool", "YES", plist]);
    backgroundExecutable = join(bundle, "Contents", "MacOS", basename(executable));
    process.once("exit", () => rmSync(root, { recursive: true, force: true }));
    return backgroundExecutable;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
