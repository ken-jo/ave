import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCodexExecutableLocation, assertCodexLocations } from "../../main/codex-executable-location.js";
import { codexExecutableArtifactFixture, fakeFixtureAclTransport, fixtureAclHost, maskFixtureAncestorAclTransport, normalizeFixtureAncestorPermissions, writeNativeExecutable } from "./native-executable.js";
import { configureHostResources, getHostResources } from "../../main/host-resources.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { cleanupTmpDir } from "./tmp-dir-teardown.js";

vi.mock("node:child_process", async (importOriginal) =>
  (await import("./native-executable.js")).maskFixtureAncestorAcl(await importOriginal()));

const AUTHENTICATED_USERS = "*S-1-5-11";
const icacls = (...args: string[]): void => {
  execFileSync(win32.join(process.env.SystemRoot!, "System32", "icacls.exe"), args, { windowsHide: true, stdio: "ignore" });
};

const roots: { path: string; granted: boolean }[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    if (root.granted) icacls(root.path, "/remove:g", AUTHENTICATED_USERS);
    await cleanupTmpDir(root.path);
  }
  vi.restoreAllMocks();
});

function fixture(grant = false): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-fixture-ancestor-acl-")));
  roots.push({ path: root, granted: grant });
  normalizeFixtureAncestorPermissions(root);
  if (grant) icacls(root, "/grant", `${AUTHENTICATED_USERS}:(M)`);
  return writeNativeExecutable(join(root, "bin", "codex.exe"));
}

it("composes packaged resources before fixture access-rule transports query the operating system", () => {
  const previousHost = fixtureAclHost.current;
  for (const createTransport of [() => fakeFixtureAclTransport(execFile), () => maskFixtureAncestorAclTransport(spawn)]) {
    configureHostResources({ resourcePath: join(tmpdir(), "uncomposed-fixture"), isPackaged: false });
    const transport = createTransport();
    expect(getHostResources()).toEqual({ resourcePath: resolve("resources"), isPackaged: false });
    transport.discard();
  }
  fixtureAclHost.current = previousHost;
});

it("composes the resource instance used by dynamically imported artifact helpers after a module reset", { timeout: TOOL_TIMEOUT_POLICY.globalCeilingMs }, async () => {
  vi.resetModules();
  const resources = await import("../../main/host-resources.js");
  expect(() => resources.getHostResources()).toThrow("host-resources-unavailable");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-artifact-module-generation-")));
  roots.push({ path: root, granted: false });
  normalizeFixtureAncestorPermissions(root);
  const artifact = await codexExecutableArtifactFixture(root);
  expect(resources.getHostResources()).toEqual({ resourcePath: resolve("resources"), isPackaged: false });
  expect(artifact.executable.startsWith(root)).toBe(true);
  const location = await import("../../main/codex-executable-location.js");
  location._resetWindowsAclHostForTest();
});

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
