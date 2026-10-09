import { execFile } from "node:child_process";
import { join } from "node:path";
import { getHostResources } from "../main/host-resources.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { BACKGROUND_ATTEMPTS, RENAME_FILE_LOCK_CODES, transientFsLockDelayMs } from "./transient-fs-lock-retry.js";

const HELPER_NAME = process.platform === "win32" ? "ave-rename-entry.exe" : "ave-rename-entry";
const RENAME_ERRORS = new Set(["EEXIST", "ENOTEMPTY", "EBUSY", "EACCES", "EPERM", "ENOENT", "ENOTDIR", "EXDEV", "ENOSYS", "EINVAL", "EIO"]);

/** Same-volume rename that atomically refuses even an empty existing directory. */
export async function renameEntryExclusive(
  from: string,
  to: string,
  onRetry?: (attempt: number, code: string) => void,
): Promise<void> {
  const helper = join(getHostResources().resourcePath, "rename-entry", process.arch, HELPER_NAME);
  for (let attempt = 1; ; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(helper, [from, to], {
          windowsHide: true,
          timeout: TOOL_TIMEOUT_POLICY.pluginSocketRenameMs,
          encoding: "utf8",
          maxBuffer: 1024,
        }, (error, stdout, stderr) => {
          if (!error && stdout === "" && stderr === "") return resolve();
          const code = stderr.trim();
          if (error?.code === 1 && !error.killed && stdout === "" && RENAME_ERRORS.has(code)) {
            reject(Object.assign(new Error(`Exclusive rename failed: ${code}`), { code }));
          } else {
            reject(new Error("Exclusive rename helper failed", { cause: error }));
          }
        });
      });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || code === undefined || !RENAME_FILE_LOCK_CODES.has(code) || attempt >= BACKGROUND_ATTEMPTS) throw error;
      onRetry?.(attempt, code);
      await new Promise((resolve) => setTimeout(resolve, transientFsLockDelayMs(attempt)));
    }
  }
}
