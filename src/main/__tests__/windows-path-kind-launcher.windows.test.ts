import { execFile, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { windowsPeImageDigest } from "../../../scripts/lib/windows-path-kind-image-digest.mjs";
import { heldFileOperations } from "../browser/browser-download-files.js";
import { configureHostResources } from "../host-resources.js";
import * as scriptRuntime from "../host-script-runtime.js";
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

it.skipIf(process.platform !== "win32")("refuses a substituted workbook helper before spawn", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-workbook-helper-"));
  const launcher = vi.fn();
  const candidate = windowsPathKindHelperIn(root);
  const directory = join(root, "skill-scripts");
  try {
    mkdirSync(dirname(candidate), { recursive: true });
    mkdirSync(directory);
    copyFileSync(windowsPathKindHelperIn(resourcePath), candidate);
    vi.stubGlobal("__AVE_WINDOWS_PATH_KIND_SHA256__", windowsPeImageDigest(readFileSync(candidate)));
    writeFileSync(candidate, "substituted fixture");
    configureHostResources({ resourcePath: root, isPackaged: true });
    await expect(async () => scriptRuntime.withWindowsWorkbookHelper([join(directory, "edit-xlsx.cjs"), candidate], launcher))
      .rejects.toThrow("Windows folder classifier does not match this build");
    expect(launcher).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    configureHostResources({ resourcePath, isPackaged: true });
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "win32")("holds the workbook helper and its parents across the awaited launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-held-workbook-helper-"));
  const candidate = windowsPathKindHelperIn(root);
  const directory = join(root, "skill-scripts");
  const retired = join(root, "retired");
  try {
    mkdirSync(dirname(candidate), { recursive: true });
    mkdirSync(directory);
    copyFileSync(windowsPathKindHelperIn(resourcePath), candidate);
    vi.stubGlobal("__AVE_WINDOWS_PATH_KIND_SHA256__", windowsPeImageDigest(readFileSync(candidate)));
    configureHostResources({ resourcePath: root, isPackaged: true });
    await scriptRuntime.withWindowsWorkbookHelper([join(directory, "edit-xlsx.cjs"), candidate], async () => {
      await Promise.resolve();
      for (const name of [candidate, dirname(candidate)]) {
        expect(() => renameSync(name, retired)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^(EACCES|EBUSY|EPERM)$/u) }));
      }
    });
    renameSync(candidate, retired);
  } finally {
    vi.unstubAllGlobals();
    configureHostResources({ resourcePath, isPackaged: true });
    rmSync(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "win32")("distinguishes a missing pinned executable from a failed open", async () => {
  const resources = mkdtempSync(join(tmpdir(), "ave-missing-helper-"));
  const helper = windowsPathKindHelperIn(resources);
  configureHostResources({ resourcePath: resources, isPackaged: true });
  vi.stubGlobal("__AVE_WINDOWS_PATH_KIND_SHA256__", null);
  try {
    mkdirSync(dirname(helper), { recursive: true });
    expect(() => heldFileOperations(resources)).toThrow(/cannot be used: it is missing\. Reinstall/u);
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("classifier is missing");

    mkdirSync(helper);
    expect(() => heldFileOperations(resources)).toThrow(/Could not hold the Windows executable path \(Windows error \d+\)\. Restart Ave; if it persists, reinstall Ave\. Reinstall/u);
    await expect(queryWindowsSystemDirectory()).rejects.toThrow("classifier could not be opened");
  } finally {
    vi.unstubAllGlobals();
    configureHostResources({ resourcePath, isPackaged: true });
    rmSync(resources, { recursive: true, force: true });
  }
});

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
