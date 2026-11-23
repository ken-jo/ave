import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { configureHostResources } from "../host-resources.js";
import {
  queryWindowsSystemDirectory,
  queryWindowsSystemDirectorySync,
  windowsPathKindHelperIn,
  windowsSystemDirectorySpawnOptions,
} from "../windows-path-kind-launcher.js";

const resourcePath = fileURLToPath(new URL("../../../resources/", import.meta.url));
const parentKeys = [
  "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT",
  "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR", "NODE_V8_COVERAGE", "AVE_PARENT_ONLY",
];

it.skipIf(process.platform !== "win32" || !existsSync(windowsPathKindHelperIn(resourcePath)))(
  "keeps parent values out of a real child and still queries the OS directory",
  async () => {
    configureHostResources({ resourcePath, isPackaged: true });
    const directory = await queryWindowsSystemDirectory();
    const diagnostic = join(directory, "cmd.exe");
    try {
      for (const key of parentKeys) vi.stubEnv(key, `hostile-parent-${key}`);
      const result = spawnSync(diagnostic, ["/d", "/c", "set"], windowsSystemDirectorySpawnOptions(diagnostic));
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      const output = result.stdout.toString();
      for (const key of parentKeys) expect.soft(output).not.toContain(`hostile-parent-${key}`);
      expect(queryWindowsSystemDirectorySync()).toBe(directory);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
