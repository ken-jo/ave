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

let directory: string;
let path: string;
const original = JSON.stringify({ documents: { openMode: "link" }, chat: { autoCompact: true } });
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "document-settings-floor-"));
  const userDataPath = join(directory, "Library", "Application Support", "Ave");
  mkdirSync(userDataPath, { recursive: true });
  path = join(userDataPath, "ave-settings.json");
  writeFileSync(path, original);
});
afterEach(async () => { await cleanupTmpDir(directory); });

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

});
