import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteFileTool, EditFileTool } from "../file-tools.js";
import { ensureFileAccess } from "../file-access-policy.js";
import { SettingsService, settingsFilePath } from "../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { validateShellCommandPathPolicy } from "../shell-path-policy.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { createSensitivePathMatcher, protectRuntimeSettingsPath } from "../../permissions/sensitive-paths.js";

let directory: string;
let path: string;
const releases: Array<() => void> = [];
function protect(path: string): void {
  const release = protectRuntimeSettingsPath(path);
  if (typeof release === "function") releases.push(release);
}
const original = JSON.stringify({ documents: { openMode: "link" }, chat: { autoCompact: true } });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "document-settings-floor-"));
  const userDataPath = join(directory, "Library", "Application Support", "Ave");
  mkdirSync(userDataPath, { recursive: true });
  path = join(userDataPath, "ave-settings.json");
  writeFileSync(path, original);
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await cleanupTmpDir(directory);
});

describe("document settings user-only write floor", () => {
  it("protects the entire file with the existing sensitive-path policy", () => {
    expect(ensureFileAccess(path, { cwd: directory, extraAllowedDirectories: [], metadata: {} }, "write"))
      .toMatchObject({ isError: true, output: expect.stringContaining("Sensitive path:") });
  });

  it.each([
    { documents: { openMode: "direct" } },
    { documents: {} },
    { documents: null },
    {},
  ])("denies whole-file replacement with %j", async (replacement) => {
    const result = await new WriteFileTool().execute(
      { path, content: JSON.stringify(replacement) },
      { cwd: directory, extraAllowedDirectories: [], metadata: {} },
    );
    expect(result).toMatchObject({ isError: true, output: expect.stringContaining("Sensitive path:") });
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("denies an agent's nested mode edit", async () => {
    const result = await new EditFileTool().execute(
      { path, oldText: '"openMode":"link"', newText: '"openMode":"direct"' },
      { cwd: directory, extraAllowedDirectories: [], metadata: {} },
    );
    expect(result).toMatchObject({ isError: true, output: expect.stringContaining("Sensitive path:") });
    expect(readFileSync(path, "utf8")).toBe(original);
  });
  it("protects a relocated settings store through the same file-access floor", async () => {
    const userDataPath = join(directory, "custom-profile");
    const settings = new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
    await settings.patch({ documents: { openMode: "link" } });
    const relocated = settingsFilePath(userDataPath);
    protect(relocated);
    const before = readFileSync(relocated, "utf8");
    const context = { cwd: directory, extraAllowedDirectories: [], metadata: {} };
    expect(ensureFileAccess(relocated, context, "read")).toBeNull();
    expect(ensureFileAccess(relocated, context, "write")).toMatchObject({ isError: true, output: expect.stringContaining("Sensitive path:") });
    expect(ensureFileAccess(userDataPath, context, "write")).toMatchObject({ isError: true });
    expect(ensureFileAccess(join(userDataPath, "sibling.txt"), context, "write")).toBeNull();
    for (const command of [
      `mv ${shellQuote(userDataPath)} ${shellQuote(join(directory, "moved-profile"))}`,
      `mv ${shellQuote(join(directory, "prepared-profile"))} ${shellQuote(userDataPath)}`,
    ]) {
      expect(validateShellCommandPathPolicy(command, directory, directory, [], false,
        { dialect: "bash", environment: { HOME: directory, PWD: directory } })).toContain("Sensitive path:");
    }
    for (const replacement of [{}, { documents: null }, { documents: { openMode: "direct" } }]) {
      const result = await new WriteFileTool().execute({ path: relocated, content: JSON.stringify(replacement) }, context);
      expect(result).toMatchObject({ isError: true, output: expect.stringContaining("Sensitive path:") });
      expect(readFileSync(relocated, "utf8")).toBe(before);
    }
    const edited = await new EditFileTool().execute({ path: relocated, oldText: '"link"', newText: '"direct"' }, context);
    expect(edited).toMatchObject({ isError: true, output: expect.stringContaining("Sensitive path:") });
    expect(readFileSync(relocated, "utf8")).toBe(before);
  });

  it("protects only the settings file and its immediate directory", () => {
    const parent = join(directory, "profile");
    const settingsPath = settingsFilePath(parent);
    mkdirSync(parent);
    protect(settingsPath);
    const context = { cwd: directory, extraAllowedDirectories: [], metadata: {} };
    expect(ensureFileAccess(directory, context, "write")).toBeNull();
    expect(ensureFileAccess(parent, context, "write")).toMatchObject({ isError: true });
    expect(ensureFileAccess(settingsPath, context, "write")).toMatchObject({ isError: true });
    expect(ensureFileAccess(join(parent, "sibling.txt"), context, "write")).toBeNull();
    for (const command of ["cp a.txt .", "mkdir newdir", "rm -rf ./build", "git clean -fdx"]) {
      expect(validateShellCommandPathPolicy(command, directory, directory, [], false,
        { dialect: "bash", environment: { HOME: directory, PWD: directory } })).toBeNull();
    }
  });

  it("does not register protection when constructing standalone settings stores", () => {
    const userDataPath = join(directory, "standalone-profile");
    new SettingsService({ userDataPath, encryption: unavailableSecretEncryption });
    expect(ensureFileAccess(settingsFilePath(userDataPath),
      { cwd: directory, extraAllowedDirectories: [], metadata: {} }, "write")).toBeNull();
  });

  it("releases scoped registrations without releasing another live owner", () => {
    const settingsPath = settingsFilePath(join(directory, "scoped-profile"));
    const match = createSensitivePathMatcher("write");
    const first = protectRuntimeSettingsPath(settingsPath);
    const second = protectRuntimeSettingsPath(settingsPath);
    if (typeof first === "function") releases.push(first);
    if (typeof second === "function") releases.push(second);
    expect(typeof first).toBe("function");
    expect(typeof second).toBe("function");
    expect(match(settingsPath)).toBe("runtime-settings-file");
    const context = { cwd: directory, extraAllowedDirectories: [], metadata: {} };
    first();
    first();
    expect(ensureFileAccess(settingsPath, context, "write")).toMatchObject({ isError: true });
    second();
    expect(match(settingsPath)).toBeNull();
    expect(ensureFileAccess(settingsPath, context, "write")).toBeNull();
    expect(ensureFileAccess(join(directory, "scoped-profile"), context, "write")).toBeNull();
  });

});
