import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCodexExecutableLocation } from "../../main/codex-executable-location.js";
import { normalizeFixtureAncestorPermissions, writeNativeExecutable } from "./native-executable.js";

vi.mock("node:child_process", async (importOriginal) =>
  (await import("./native-executable.js")).maskFixtureAncestorAcl(await importOriginal()));

const AUTHENTICATED_USERS = "*S-1-5-11";
const icacls = (...args: string[]): void => {
  execFileSync(win32.join(process.env.SystemRoot!, "System32", "icacls.exe"), args, { windowsHide: true, stdio: "ignore" });
};

const roots: { path: string; granted: boolean }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (root.granted) icacls(root.path, "/remove:g", AUTHENTICATED_USERS);
    rmSync(root.path, { recursive: true, force: true });
  }
});

function fixture(grant = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-fixture-ancestor-acl-")));
  roots.push({ path: root, granted: grant });
  normalizeFixtureAncestorPermissions(root);
  if (grant) icacls(root, "/grant", `${AUTHENTICATED_USERS}:(M)`);
  return writeNativeExecutable(join(root, "bin", "codex.exe"));
}

describe.skipIf(process.platform !== "win32")("Windows fixture ancestor ACL masking", () => {
  it("admits a clean fixture once only its shared ancestors read as owner-only", async () => {
    await expect(assertCodexExecutableLocation(fixture())).resolves.toBeUndefined();
  });

  it("keeps the real ACL of the fixture root itself", async () => {
    await expect(assertCodexExecutableLocation(fixture(true))).rejects.toThrow("Executable path is writable by another account");
  });
});
