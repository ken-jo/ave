import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getHostResources } from "./host-resources.js";

// The drive query opens nothing, so its lookup timeout only bounds a hung process.
const QUERY_TIMEOUT_MS = 5_000;

// The helper's one answer about a drive: the OS has no mapping for it (native/windows-path-kind/README.md).
const EXIT_NO_MAPPING = 1;

// What to do when the helper is broken: it ships with Ave, so the install is incomplete.
const REPAIR = "Reinstall Ave; in a development checkout, build it with scripts/build-windows-job.ps1 -Helper path-kind.";

export function resolveWindowsPathKindHelper(): string {
  const root = getHostResources().resourcePath;
  const binary = join(root, "windows-path-kind", process.arch, "ave-path-kind.exe");
  if (!existsSync(binary)) {
    throw new Error(`Windows folder classifier is missing: ${binary}. Ave cannot tell whether a drive is on another computer, so it reads no folder on a drive. ${REPAIR}`);
  }
  return binary;
}

// QueryDosDeviceW opens nothing on the drive; no-mapping is a classification, while helper failure is a broken-install error.
// See multi-source-git-marketplace.md §18.4.1 for the path contract.
export function queryDosDevice(drive: string): Promise<string | null> {
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
        // A numeric code is the helper's exit status; a string one (ENOENT, EACCES) is a launch failure.
        if (error.code === EXIT_NO_MAPPING && !error.killed) {
          resolve(null);
          return;
        }
        const why = error.killed ? `did not answer within ${QUERY_TIMEOUT_MS} ms` : stderr.trim() || error.message;
        reject(new Error(`the Windows folder classifier failed for ${drive}: ${why}. ${REPAIR}`, { cause: error }));
        return;
      }
      const mapping = stdout.replace(/\r?\n$/u, "");
      if (mapping.length === 0 || /[\r\n]/u.test(mapping)) {
        reject(new Error(`the Windows folder classifier answered ${JSON.stringify(stdout)} for ${drive}, not one mapping. ${REPAIR}`));
        return;
      }
      resolve(mapping);
    });
  });
}
