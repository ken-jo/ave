import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { configureHostResources } from "../host-resources.js";
import {
  queryWindowsSystemDirectory,
  queryWindowsSystemDirectorySync,
  windowsPathKindHelperIn,
  windowsSystemDirectorySpawnOptions,
} from "../windows-path-kind-launcher.js";

const resourcePath = fileURLToPath(new URL("../../../resources/", import.meta.url));
const helper = windowsPathKindHelperIn(resourcePath);
const nativeHelperAvailable = process.platform === "win32" && existsSync(helper);
const parentKeys = [
  "HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT",
  "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR", "NODE_V8_COVERAGE", "AVE_PARENT_ONLY",
];

it.skipIf(!nativeHelperAvailable)(
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

it.skipIf(!nativeHelperAvailable)(
  "keeps permission-mode parent flags out of the native directory helper environment",
  async () => {
    configureHostResources({ resourcePath, isPackaged: true });
    const directory = await queryWindowsSystemDirectory();
    const parent = buildSync({
      stdin: {
        resolveDir: fileURLToPath(new URL("../", import.meta.url)),
        contents: String.raw`
          import { spawnSync } from "node:child_process";
          import { configureHostResources } from "./host-resources.ts";
          import { queryWindowsSystemDirectorySync, windowsSystemDirectorySpawnOptions } from "./windows-path-kind-launcher.ts";

          const [resourcePath, diagnostic] = process.argv.slice(1);
          configureHostResources({ resourcePath, isPackaged: true });
          const result = spawnSync(diagnostic, ["/d", "/c", "set"], windowsSystemDirectorySpawnOptions(diagnostic));
          if (result.error) throw result.error;
          if (result.status !== 0) throw new Error(result.stderr.toString());
          const nodeOptions = result.stdout.toString().split(/\r?\n/u)
            .find((line) => line.startsWith("NODE_OPTIONS="))?.slice("NODE_OPTIONS=".length);
          process.stdout.write(JSON.stringify({
            permissionEnabled: process.permission !== undefined,
            nodeOptions,
            directory: queryWindowsSystemDirectorySync(),
          }));
        `,
      },
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
    }).outputFiles[0].text;
    const result = spawnSync(process.execPath, [
      "--permission", "--allow-child-process", `--allow-fs-read=${helper}`, "--input-type=module", "--eval", parent,
      resourcePath, join(directory, "cmd.exe"),
    ], { env: { ...process.env, NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ permissionEnabled: true, nodeOptions: "--permission", directory });
  },
);
