import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { windowsPeImageDigest } from "../../../scripts/lib/windows-path-kind-image-digest.mjs";
import { configureHostResources } from "../host-resources.js";
import {
  queryWindowsSystemDirectory,
  queryWindowsSystemDirectorySync,
  windowsPathKindHelperIn,
  windowsSystemDirectorySpawnOptions,
} from "../windows-path-kind-launcher.js";

vi.mock("node:child_process", async original => {
  const actual = await original<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile), spawnSync: vi.fn(actual.spawnSync) };
});

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

it.skipIf(process.platform !== "win32" || !existsSync(windowsPathKindHelperIn(resourcePath))).each([
  ["file", "sync"], ["directory", "async"],
])("protects the verified helper %s until %s process creation", async (entry, launch) => {
  const root = mkdtempSync(join(tmpdir(), "ave-verified-helper-"));
  const resources = join(root, "resources");
  const candidate = windowsPathKindHelperIn(resources);
  const source = windowsPathKindHelperIn(resourcePath);
  const bytes = readFileSync(source);
  const target = entry === "file" ? candidate : resources;
  const retired = join(root, "retired");
  configureHostResources({ resourcePath, isPackaged: true });
  const expected = queryWindowsSystemDirectorySync();
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  function replaceBeforeSpawn(): void {
    try {
      renameSync(target, retired);
    } catch (error) {
      expect(error).toHaveProperty("code", expect.stringMatching(/^(EACCES|EBUSY|EPERM)$/u));
      return;
    }
    mkdirSync(dirname(candidate), { recursive: true });
    writeFileSync(candidate, "replacement fixture");
  }
  try {
    mkdirSync(dirname(candidate), { recursive: true });
    copyFileSync(source, candidate);
    configureHostResources({ resourcePath: resources, isPackaged: true });
    vi.stubGlobal("__AVE_WINDOWS_PATH_KIND_SHA256__", windowsPeImageDigest(bytes));
    if (launch === "sync") {
      vi.mocked(spawnSync).mockImplementationOnce((file, args, options) => {
        replaceBeforeSpawn();
        return actual.spawnSync(file, args, options);
      });
      expect(queryWindowsSystemDirectorySync()).toBe(expected);
    } else {
      vi.mocked(execFile).mockImplementationOnce((...args) => {
        replaceBeforeSpawn();
        return Reflect.apply(actual.execFile, undefined, args);
      });
      await expect(queryWindowsSystemDirectory()).resolves.toBe(expected);
    }
    expect(readFileSync(candidate)).toEqual(bytes);
    expect(existsSync(retired)).toBe(false);
    renameSync(target, retired);
  } finally {
    vi.mocked(spawnSync).mockReset();
    vi.mocked(execFile).mockReset();
    vi.unstubAllGlobals();
    configureHostResources({ resourcePath, isPackaged: true });
    rmSync(root, { recursive: true, force: true });
  }
});
