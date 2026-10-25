import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCodexExecutableLocation, assertCodexLocations } from "../../main/codex-executable-location.js";
import { fixtureAclHost, normalizeFixtureAncestorPermissions, writeNativeExecutable } from "./native-executable.js";

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

  it("reads a fixture's changed ACL again inside the same ACL host", async () => {
    const executable = fixture();
    await expect(assertCodexExecutableLocation(executable)).resolves.toBeUndefined();
    const host = fixtureAclHost.current!;
    const { pid, starts } = host;
    expect(pid).toBeDefined();
    const root = roots.at(-1)!;
    root.granted = true;
    icacls(root.path, "/grant", `${AUTHENTICATED_USERS}:(M)`);
    await expect(assertCodexExecutableLocation(executable)).rejects.toThrow("Executable path is writable by another account");
    expect(host.pid).toBe(pid);
    expect(host.starts).toBe(starts);
  });

  it("refuses a batch when one file's directory alone grants modify access to another account", async () => {
    const root = dirname(dirname(fixture()));
    const clean = [1, 2, 3].map((index) => writeNativeExecutable(join(root, `clean-${index}`, "codex.exe")));
    const shared = join(root, "shared");
    const exposed = writeNativeExecutable(join(shared, "codex.exe"));
    roots.unshift({ path: shared, granted: true });
    icacls(shared, "/grant", `${AUTHENTICATED_USERS}:(M)`);
    const requests = (paths: string[]) => paths.map((path) => ({ path, kind: "executable" as const }));
    await expect(assertCodexLocations(requests(clean))).resolves.toBeUndefined();
    await expect(assertCodexLocations(requests([clean[0]!, exposed, ...clean.slice(1)])))
      .rejects.toThrow("Executable path is writable by another account");
  });
});
