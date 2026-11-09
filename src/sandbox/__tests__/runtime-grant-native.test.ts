// [W] The runtime boundary's narrowed read grants, run for real: uv and a venv interpreter kept inside the owner-only
// `<AVE_HOME>/runtime` start under srt-win with only `hostRuntimeReads` granted, crossing the boundary through bypass-traverse,
// and the grant never lands on the boundary's own DACL (a grant entry left by a crash would otherwise refuse the next boot).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { join, relative, resolve } from "node:path";
import * as runtime from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { initializeRequiredSandbox } from "../../__tests__/support/native-sandbox.js";
import { setFixtureOwner } from "../../__tests__/support/fixture-owner.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { configureHostResources } from "../../main/host-resources.js";
import { checkAsrtDependencies, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../../permissions/asrt-sandbox.js";
import { windowsSandboxCanSpawn } from "../../permissions/__tests__/test-helpers.js";
import { holdWindowsFilesystemGrant } from "../../permissions/windows-acl-grant-holder.js";
import { _resetAveHomePrivacyForTest, ensureAveHomePrivate, readWindowsDirectoryDacls, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
import { resolveUvTarget } from "../../../scripts/uv-targets.mjs";
import { PYTHON_VERSION } from "../../../.github/scripts/python-archive-cache.mjs";
import { hostRuntimeReads } from "../wrap-bundled-command.js";

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
}));

describe.runIf(process.platform === "win32")("runtime boundary read grants under the native sandbox", () => {
  let container: string;
  let home: string;
  let work: string;

  beforeEach(async (context) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    // The long path: a short (8.3) spelling of the temp directory cannot be granted.
    const created = mkdtempSync(join(os.tmpdir(), "runtime-grant-native-"));
    // The fixture-owner guard matches the temp directory as spelled, so the owner is set before the spelling is expanded.
    setFixtureOwner(created);
    container = realpathSync.native(created);
    // Not `<HOME>/.ave`: HOME is stubbed to the container below, and the isolation guard refuses a sandbox initialized over what
    // it then sees as the real user's ~/.ave. AVE_HOME may sit anywhere; this one is a sibling of the stubbed profile's .ave.
    home = join(container, "ave-home");
    // The sandboxed program's working directory: granted at initialization and disjoint from the home, so the runtime grants
    // under test are the only grants that reach AVE_HOME.
    work = join(container, "work");
    mkdirSync(work);
    // Commands below are passed unquoted, so no shell quote handling sits between the test and the grant under test.
    expect(container).not.toMatch(/\s/);
    vi.stubEnv("HOME", container);
    vi.stubEnv("USERPROFILE", container);
    vi.stubEnv("AVE_HOME", home);
    vi.spyOn(os, "homedir").mockReturnValue(container);
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: container });
    const dependencies = await checkAsrtDependencies();
    if (dependencies.errors.length > 0) {
      const reason = `Native Windows sandbox unavailable: ${dependencies.errors.join("; ")}`;
      if (process.env.CI) throw new Error(reason);
      context.skip(reason);
    }
    if (!(await windowsSandboxCanSpawn())) {
      if (process.env.CI) throw new Error("Native Windows sandbox cannot spawn on the provisioned runner");
      context.skip("Native Windows sandbox cannot spawn on this host; see capability warning");
    }
    const privacy = ensureAveHomePrivate(home);
    expect(privacy, JSON.stringify(privacy)).toMatchObject({ enforcement: "win32-dacl" });
    setAveHomePrivacyAtBoot(privacy);
    // Keep every deny the sandbox stamps inside this fixture, as the other native suites do, so no host path is touched.
    const manager = runtime.SandboxManager;
    const initialize = manager.initialize.bind(manager);
    const wrap = manager.wrapWithSandboxArgv.bind(manager);
    const inside = (entry: runtime.FilesystemPathEntry) => {
      const rel = relative(container, typeof entry === "string" ? entry : entry.path);
      return rel === "" || (!rel.startsWith("..") && !rel.includes(":"));
    };
    vi.spyOn(manager, "wrapWithSandboxArgv").mockImplementation((command, shell, custom, ...rest) =>
      wrap(command, shell, custom?.filesystem ? { ...custom, filesystem: { ...custom.filesystem,
        denyRead: custom.filesystem.denyRead?.filter(inside), denyWrite: custom.filesystem.denyWrite?.filter(inside),
      } } : custom, ...rest));
    vi.spyOn(manager, "initialize").mockImplementation(async (next, ask, monitor) => {
      await initialize({ ...next, filesystem: { ...next.filesystem,
        denyRead: next.filesystem.denyRead.filter(inside), denyWrite: next.filesystem.denyWrite.filter(inside),
      } }, ask, monitor);
    });
  });

  afterEach(async () => {
    try {
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      _resetAveHomePrivacyForTest();
      // Removes links (uv's minor-version junctions) without following them before deleting the tree.
      await cleanupTmpDir(container);
    }
  });

  /** Only the owner's own entry, protected: what boot's boundary check (ave-home.ts) admits. */
  function expectBoundaryUntouched(): void {
    const [boundary] = readWindowsDirectoryDacls([join(home, "runtime")]);
    expect(boundary).toMatchObject({ protected: true, ownerSid: boundary!.currentUserSid });
    expect(boundary!.rules?.map((rule) => rule.sid)).toEqual([boundary!.currentUserSid]);
  }

  async function sandboxed(command: string, args: string): Promise<string> {
    const wrapped = await wrapToolCommand(`${command} ${args}`, { commandId: TEST_COMMAND_ID });
    return execFileSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
      env: { ...process.env, ...wrapped.env }, cwd: work, windowsHide: true, encoding: "utf8",
    });
  }

  it("runs uv and a venv interpreter from the runtime boundary with only their children granted", async () => {
    const target = resolveUvTarget(process.platform, process.arch);
    const uvDirectory = join(home, "runtime", "uv", target.dir, "fixture");
    mkdirSync(uvDirectory, { recursive: true });
    const uv = join(uvDirectory, target.bin);
    copyFileSync(resolve("resources", "uv", target.dir, target.bin), uv);
    // Built on the host as provisioning does, with the managed interpreter inside the env root, so the venv's base
    // interpreter is the `python` child the grant names.
    const env = join(home, "runtime", "python-envs", "fixture-env");
    mkdirSync(env, { recursive: true });
    const uvEnv = { ...process.env, UV_PYTHON_INSTALL_DIR: join(env, "python"), UV_CACHE_DIR: join(env, "uv-cache"),
      // Reuse only downloaded archives; the interpreter, venv and package cache remain inside this fixture.
      UV_PYTHON_CACHE_DIR: process.env.UV_PYTHON_CACHE_DIR ?? join(env, "python-archives"),
      ...(process.env.AVE_PYTHON_DOWNLOAD_MIRROR ? { UV_PYTHON_INSTALL_MIRROR: process.env.AVE_PYTHON_DOWNLOAD_MIRROR } : {}),
      UV_PYTHON_PREFERENCE: "only-managed", UV_NO_PROGRESS: "1" };
    execFileSync(uv, ["python", "install", PYTHON_VERSION], { env: uvEnv, windowsHide: true, stdio: "pipe" });
    execFileSync(uv, ["venv", join(env, "venv"), "--python", PYTHON_VERSION], { env: uvEnv, windowsHide: true, stdio: "pipe" });
    const python = join(env, "venv", "Scripts", "python.exe");
    // A pip-synced package, as provisioning installs one from the plugin lockfile: uv links it into site-packages from the uv cache
    // beside the venv (hardlinks on one volume), so the grant on `venv` must reach files whose other name sits in the ungranted cache.
    const requirements = join(env, "requirements.lock");
    writeFileSync(requirements, "six==1.16.0\n");
    execFileSync(uv, ["pip", "sync", requirements, "--python", python], { env: uvEnv, windowsHide: true, stdio: "pipe" });
    expectBoundaryUntouched();

    await initializeRequiredSandbox({ allowRead: [work], denyRead: [], denyWrite: [] });
    // Without a grant the owner-only boundary keeps the sandbox account out.
    await expect(sandboxed(uv, "--version")).rejects.toThrow();

    const uvReads = hostRuntimeReads(uv);
    expect(uvReads).toEqual([join(home, "runtime", "uv")]);
    const uvGrant = await holdWindowsFilesystemGrant({ label: "runtime-grant-native-uv", allowRead: uvReads, allowWrite: [] });
    try {
      expect(await sandboxed(uv, "--version")).toMatch(/^uv \d/);
      expectBoundaryUntouched();
    } finally { uvGrant.release(); }

    const pythonReads = hostRuntimeReads(python);
    expect(pythonReads).toEqual([join(env, "venv"), join(env, "python")]);
    const pythonGrant = await holdWindowsFilesystemGrant({ label: "runtime-grant-native-python", allowRead: pythonReads, allowWrite: [] });
    try {
      const probe = join(work, "probe.py");
      writeFileSync(probe, "import sys, six\nprint(sys.prefix)\nprint(sys.base_prefix)\nprint(six.__file__)\n");
      const output = await sandboxed(python, `-I ${probe}`);
      const [prefix, basePrefix, sixFile] = output.trim().split(/\r?\n/);
      expect(sixFile!.toLowerCase().startsWith(join(env, "venv").toLowerCase())).toBe(true);
      expect(prefix!.toLowerCase()).toBe(join(env, "venv").toLowerCase());
      expect(basePrefix!.toLowerCase().startsWith(join(env, "python").toLowerCase())).toBe(true);
      expectBoundaryUntouched();
    } finally { pythonGrant.release(); }
    expectBoundaryUntouched();
  }, 300_000);
});
