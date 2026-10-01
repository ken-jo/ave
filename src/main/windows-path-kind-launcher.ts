import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getHostResources } from "./host-resources.js";

/** How long one lookup may take; the helper opens nothing, so this only bounds a hung process. */
const QUERY_TIMEOUT_MS = 5_000;

export function resolveWindowsPathKindHelper(): string {
  const root = getHostResources().resourcePath;
  const binary = join(root, "windows-path-kind", process.arch, "ave-path-kind.exe");
  if (!existsSync(binary)) throw new Error(`Windows folder classifier is missing: ${binary}. Build the Windows native assets first.`);
  return binary;
}

/**
 * The current MS-DOS device mapping of a drive letter (`"Z:"` →
 * `\Device\Mup\…`), read by `native/windows-path-kind/` with
 * `QueryDosDeviceW`, which opens nothing on the drive (design
 * multi-source-git-marketplace.md §18.4.1 stage 2). Throws on any failure: the
 * folder input then treats the drive as on another computer, which only warns.
 */
export function queryDosDevice(drive: string): Promise<string> {
  if (process.platform !== "win32") return Promise.reject(new Error("the folder classifier requires Windows"));
  if (!/^[A-Za-z]:$/u.test(drive)) return Promise.reject(new Error(`not a drive letter: ${drive}`));
  let helper: string;
  try {
    helper = resolveWindowsPathKindHelper();
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    execFile(helper, [drive], { windowsHide: true, timeout: QUERY_TIMEOUT_MS, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`the folder classifier failed for ${drive}: ${stderr.trim() || error.message}`, { cause: error }));
        return;
      }
      const mapping = stdout.replace(/\r?\n$/u, "");
      if (mapping.length === 0 || /[\r\n]/u.test(mapping)) {
        reject(new Error(`the folder classifier answered ${JSON.stringify(stdout)} for ${drive}`));
        return;
      }
      resolve(mapping);
    });
  });
}
