vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));

import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
// The adapter stays inactive until initialized and resets inactive; per-command overrides contain only filesystem policy and cannot weaken sandbox/network gates. Isolate home paths without changing USERPROFILE needed by process creation.
import {
  describe,
  it,
  expect,
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  vi,
  type MockInstance,
} from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { lookup as lookupAll } from "node:dns/promises";
// Ave patch test seam, reached by file path (not on the package entry).
import { setDestinationResolverForTesting } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";
import type { SandboxManager as SandboxManagerType, SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as os from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { shellQuote } from "../../lib/shell-resolver.js";
import { gitFixtureEnv } from "../../__tests__/support/git-fixture-env.mjs";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { getLocale, setLocale } from "../../i18n/index.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { windowsReadDenyKey, type WindowsReadDenyEvidence } from "../../shared/windows-read-deny-evidence.js";
import * as readDenyEvidenceModule from "../../shared/windows-read-deny-evidence.js";
import { win32SystemBinary } from "../../shared/ave-home.js";
import * as windowsStampTargets from "../windows-stamp-targets.js";
import { configureHostResources } from "../../main/host-resources.js";

vi.mock("../../shared/policy-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/policy-home.js")>();
  const os = await import("node:os");
  return { ...actual, policyHomeAnchors: () => [os.homedir()] };
});

// Policy-composition fixtures on another kernel cannot open native Windows handles.
vi.mock("../windows-stamp-targets.js", async original => {
  const actual = await original<typeof import("../windows-stamp-targets.js")>();
  const { normalizePathForSandbox } = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js");
  const nativeWindows = process.platform === "win32";
  return { ...actual, pinWindowsFilesystemConfig: (filesystem: Parameters<typeof actual.pinWindowsFilesystemConfig>[0]) => {
    if (nativeWindows || process.platform !== "win32" || filesystem === undefined) return actual.pinWindowsFilesystemConfig(filesystem);
    return { ...filesystem, ...Object.fromEntries((["allowRead", "allowWrite"] as const)
      .filter(field => filesystem[field] !== undefined).map(field => [field, filesystem[field]!.map(entry =>
        normalizePathForSandbox(typeof entry === "string" ? entry : entry.path))])) };
  } };
});

beforeAll(() => { configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }); });

it.each(["linux", "darwin"] as const)("never rechecks native Windows evidence on a captured %s host after platform simulation", async platform => {
  const original = process.platform;
  vi.resetModules();
  const resources = await import("../../main/host-resources.js");
  resources.configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  setProcessPlatform(platform);
  try {
    const sandbox = await import("../asrt-sandbox.js");
    const evidence = await import("../../shared/windows-read-deny-evidence.js");
    const recheck = vi.spyOn(evidence, "recheckWindowsReadDenyEvidence");
    setProcessPlatform("win32");
    sandbox.buildSandboxConfig({ denyRead: [join(tmpdir(), "captured-host", ".ssh")] }, new Map());
    expect(recheck).not.toHaveBeenCalled();
    recheck.mockRestore();
  } finally { setProcessPlatform(original); vi.resetModules(); }
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { simulatedConfigurationFs } = await import("../../__tests__/support/simulated-win32-drive.js");
  return { ...simulatedConfigurationFs(actual), lstatSync: vi.fn(actual.lstatSync) };
});

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    homedir: () => {
      const isolated = process.env.AVE_ASRT_TEST_HOME;
      return process.platform === "win32" && isolated ? isolated : original.homedir();
    },
    userInfo: () => {
      const info = original.userInfo();
      const isolated = process.env.AVE_ASRT_TEST_HOME;
      return process.platform === "win32" && isolated ? { ...info, homedir: isolated } : info;
    },
  };
});

import {
  isAsrtSandboxActive,
  initializeAsrtSandbox,
  resetAsrtSandbox,
  wrapToolCommand,
  wrapWorkerCommand,
  wrapTerminalCommand,
  cleanupAsrtSandboxAfterCommand,
  normalizeUnionForAsrt,
  computeDynamicEndpointHosts,
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
  getVendoredSrtWinExePath,
  buildSandboxConfig,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  getBuiltinShellReadPolicy,
  appOwnedSandboxPrivateRoots,
  registerWorkerUnixSocketDir,
  unregisterWorkerUnixSocketDir,
  buildPerCommandSandboxCustomConfig,
  getVendoredApplySeccompPath,
  getVendoredJavaProxyAgentJarPath,
  checkAsrtDependencies,
  _getWindowsReadDenySnapshotForTest,
  getWindowsProfileReadDenyWarnings,
} from "../asrt-sandbox.js";
import { buildMandatorySandboxWritePolicy } from "../sandbox-write-policy.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { getApplySeccompBinaryPath } from "@anthropic-ai/sandbox-runtime/dist/sandbox/generate-seccomp-filter.js";
import { asrtCanInitialize } from "./test-helpers.js";
import { _resetConfinedProcessPhaseForTests, confinedProcessesMayBeRunning } from "../../lib/confined-process-phase.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { retryOnTransientFsLock } from "../../lib/transient-fs-lock-retry.js";
import { srtWinPrivateDirectories } from "../srt-win-integrity.js";
import { spawnWithSandbox } from "../../tools/shell-tools.js";
import { prepareSandboxFixture } from "../../tools/__tests__/support/prepared-shell.js";
import { preparedShellExecutableReadPaths } from "../../tools/prepared-shell-invocation.js";
// ASRT-contract guards: the real vendored matcher + parent-proxy resolver, so the host-side fixes are proven against ASRT's ACTUAL semantics (not a re-implementation that could drift from the package).
import { matchesDomainPattern } from "@anthropic-ai/sandbox-runtime/dist/sandbox/domain-pattern.js";
import { resolveParentProxy } from "@anthropic-ai/sandbox-runtime/dist/sandbox/parent-proxy.js";
import { rankWindowsFsAccess } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import * as sensitivePaths from "../sensitive-paths.js";
import { getDefaultWritePaths, normalizePathForSandbox } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";
import type { FilesystemConfig, FilesystemPathEntry } from "@anthropic-ai/sandbox-runtime";

useVerifiedAveHomePrivacy();

let originalAsrtTestHome: string | undefined;
let originalAveHome: string | undefined;
let originalHome: string | undefined;
let isolatedWindowsHome: string | undefined;
let restoreNativeFixturePolicy: (() => void) | undefined;

beforeAll(async () => {
  if (process.platform !== "win32") return;

  originalAsrtTestHome = process.env.AVE_ASRT_TEST_HOME;
  originalAveHome = process.env.AVE_HOME;
  originalHome = process.env.HOME;
  isolatedWindowsHome = mkdtempSync(join(tmpdir(), "ave-asrt-test-home-"));
  process.env.AVE_ASRT_TEST_HOME = isolatedWindowsHome;
  process.env.AVE_HOME = join(isolatedWindowsHome, "app");
  process.env.HOME = isolatedWindowsHome;
  const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
  const nativeInitialize = SandboxManager.initialize.bind(SandboxManager);
  const nativeWrap = SandboxManager.wrapWithSandboxArgv.bind(SandboxManager);
  const fixtureFilesystem = <T extends Partial<FilesystemConfig>>(filesystem: T): T => {
    const withinFixture = (entry: FilesystemPathEntry): boolean => {
      const path = resolve(typeof entry === "string" ? entry : entry.path).toLowerCase();
      return [isolatedWindowsHome!, tmpdir()].some((root) => {
        const base = resolve(root).toLowerCase();
        return path === base || path.startsWith(base + sep);
      });
    };
    return {
      ...filesystem,
      ...(filesystem.denyRead === undefined ? {} : { denyRead: filesystem.denyRead.filter(withinFixture) }),
      ...(filesystem.denyWrite === undefined ? {} : { denyWrite: filesystem.denyWrite.filter(withinFixture) }),
      ...(filesystem.allowRead === undefined ? {} : { allowRead: filesystem.allowRead.filter(withinFixture) }),
      ...(filesystem.allowWrite === undefined ? {} : { allowWrite: filesystem.allowWrite.filter(withinFixture) }),
    };
  };
  const initialize = vi.spyOn(SandboxManager, "initialize").mockImplementation((config, ...args) =>
    nativeInitialize({ ...config, filesystem: fixtureFilesystem(config.filesystem) }, ...args));
  const wrap = vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation((command, binShell, config, ...args) =>
    nativeWrap(command, binShell, config?.filesystem ? { ...config, filesystem: fixtureFilesystem(config.filesystem) } : config, ...args));
  restoreNativeFixturePolicy = () => { wrap.mockRestore(); initialize.mockRestore(); };
});

afterAll(async () => {
  if (process.platform !== "win32" || isolatedWindowsHome === undefined) return;
  restoreNativeFixturePolicy?.();

  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalAsrtTestHome === undefined) {
    delete process.env.AVE_ASRT_TEST_HOME;
  } else {
    process.env.AVE_ASRT_TEST_HOME = originalAsrtTestHome;
  }
  if (originalAveHome === undefined) {
    delete process.env.AVE_HOME;
  } else {
    process.env.AVE_HOME = originalAveHome;
  }
  await cleanupTmpDir(isolatedWindowsHome);
});

// The product keeps its private srt-win copy until process exit, which a Vitest worker outlives; remove it non-recursively, as the product does.
afterAll(async () => {
  for (const directory of srtWinPrivateDirectories()) {
    await retryOnTransientFsLock(async () => {
      for (const name of ["srt-win.exe", "owner.json"]) rmSync(join(directory, name), { force: true });
      if (existsSync(directory)) rmdirSync(directory);
      if (existsSync(dirname(directory))) rmdirSync(dirname(directory));
    });
  }
});

afterEach(async () => {
  // Always return to the gated-OFF baseline so cross-test state never leaks.
  if (isAsrtSandboxActive()) {
    await resetAsrtSandbox();
  }
});

// Strip the directory marker only for comparisons with the literal floor.
function bare(paths: readonly FilesystemPathEntry[]): string[] {
  return paths.map(path => (typeof path === "string" ? path : path.path).replace(/[\\/]$/, ""));
}

// Windows also omits absent targets at the handoff.
function reachesAsrt(path: string): boolean {
  if (process.platform !== "win32") return true;
  const home = homedir().toLowerCase();
  const folded = path.toLowerCase();
  return existsSync(path) && !path.startsWith("/") && folded !== home && !folded.startsWith(home.endsWith(sep) ? home : home + sep);
}

const ORIGINAL_PLATFORM_FOR_DENY_TEST = process.platform;

function runArgv(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    const child = spawn(cmd as string, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env,
      cwd,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      }),
    );
    child.on("error", (e) => resolve({ code: null, stdout: "", stderr: e.message }));
  });
}

describe("asrt-sandbox — gate default OFF", () => {
  it("isAsrtSandboxActive() is false before any initialize (the shipped default)", () => {
    expect(isAsrtSandboxActive()).toBe(false);
  });
});

describe("asrt-sandbox — active flag lifecycle (boot-time, no runtime injection)", () => {
  it("flips to true on initialize and back to false on reset", async () => {
    if (!(await asrtCanInitialize())) {
      // Unsupported platform or missing sandbox deps — initialize would fail-closed at boot anyway; the gate stays OFF.
      expect(isAsrtSandboxActive()).toBe(false);
      return;
    }
    expect(isAsrtSandboxActive()).toBe(false);
    await initializeAsrtSandbox({ allowedDomains: [] });
    expect(isAsrtSandboxActive()).toBe(true);
    await resetAsrtSandbox();
    expect(isAsrtSandboxActive()).toBe(false);
  });
});

describe("asrt-sandbox — gate ON wraps a real command under the OS sandbox", () => {
  it.runIf(process.platform === "win32")("stamps an isolated profile without traversing the whole profile", async (context) => {
    const dependencies = await checkAsrtDependencies();
    if (dependencies.errors.length > 0) {
      console.info(`Native ACL stamp timing unavailable: ${dependencies.errors.join("; ")}`);
      return context.skip(dependencies.errors.join("; "));
    }
    if (!(await asrtCanInitialize())) return context.skip("The native sandbox cannot spawn on this host");
    const work = mkdtempSync(join(tmpdir(), "asrt-stamp-timing-"));
    try {
      const started = performance.now();
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, allowWrite: [work] });
      const elapsed = performance.now() - started;
      console.info(`Native sandbox initialization including ACL stamp: ${elapsed.toFixed(0)} ms`);
      expect(elapsed).toBeLessThan(60_000);
    } finally {
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
      await cleanupTmpDir(work);
    }
  }, 60_000);

  it("returns ASRT argv whose wrapped echo runs and resolves vendor binaries", async () => {
    if (!(await asrtCanInitialize())) return;

    const writeDir = mkdtempSync(join(tmpdir(), "asrt-test-"));
    try {
      await initializeAsrtSandbox({ allowedDomains: [], allowWrite: [writeDir] });

      const { argv, env } = await wrapToolCommand(
        "echo asrt-ok",
        process.platform === "win32"
          ? { commandId: TEST_COMMAND_ID }
          : { commandId: TEST_COMMAND_ID, filesystem: { allowWrite: [writeDir], allowRead: [writeDir] } },
      );

      // mac/linux: [<shell>, "-c", <wrapped>]; Windows: [srt-win, "--srt-win", "exec",...], the dispatch argument ASRT prepends to every srt-win spawn.
      expect(argv.length).toBeGreaterThanOrEqual(3);
      if (process.platform === "win32") expect(argv.slice(1, 3)).toEqual(["--srt-win", "exec"]);
      else expect(argv[1]).toBe("-c");

      const res = await runArgv(argv, env, writeDir);
      cleanupAsrtSandboxAfterCommand();

      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout).toContain("asrt-ok");
      // vendor-resolved: no module/vendor resolution failure in the wrapper.
      const combined = `${res.stdout}\n${res.stderr}`;
      expect(combined).not.toMatch(
        /vendor.*not found|cannot find module|MODULE_NOT_FOUND|no such file.*vendor/i,
      );
    } finally {
      await cleanupTmpDir(writeDir);
    }
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "finds an admitted executable while allowing broad sibling reads",
    async (context) => {
      if (!(await asrtCanInitialize())) return context.skip();
      const root = realpathSync(mkdtempSync(join(tmpdir(), "asrt-executable-")));
      const cwd = join(root, "workspace");
      const bin = join(root, "runtime", "bin");
      const executable = join(bin, "fixture_cli");
      const sibling = join(bin, "private-data");
      mkdirSync(cwd); mkdirSync(bin, { recursive: true });
      writeFileSync(executable, "#!/bin/sh\nprintf 'executable-visible\\n'\n", { mode: 0o755 });
      writeFileSync(sibling, "sibling-must-stay-private");
      try {
        await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
        vi.stubEnv("HOME", root);
        vi.stubEnv("PATH", `${bin}:/usr/bin:/bin`);
        const command = `command -v fixture_cli && fixture_cli; /bin/cat ${shellQuote(sibling)}; printf changed > ${shellQuote(executable)}`;
        const prepared = prepareSandboxFixture(command, cwd);
        expect(preparedShellExecutableReadPaths(prepared)).toContain(executable);
        expect(preparedShellExecutableReadPaths(prepared)).not.toContain(bin);
        const result = await spawnWithSandbox(command, cwd, [cwd], 15, prepared);
        expect(result.output).toContain(executable);
        expect(result.output).toContain("executable-visible");
        expect(result.output).toContain("sibling-must-stay-private");
        expect(result.isError).toBe(true);
        expect(result.metadata.sandboxed).toBe(true);
        expect(readFileSync(executable, "utf8")).toBe("#!/bin/sh\nprintf 'executable-visible\\n'\n");
      } finally {
        vi.unstubAllEnvs();
        await cleanupTmpDir(root);
      }
    },
  );

  // A read the credential floor denies fails visibly: the command's own permission error reaches the output, the result is an error, and no store content leaks. There is no silent fallback or empty success.
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "surfaces the native permission error for a floored browser or keychain read",
    async (context) => {
      if (!(await asrtCanInitialize())) {
        if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
        return context.skip();
      }
      const root = realpathSync(mkdtempSync(join(tmpdir(), "asrt-credential-floor-")));
      const cwd = join(root, "workspace");
      mkdirSync(cwd);
      const stores = [
        join(root, ".mozilla", "firefox", "abc.default-release", "logins.json"),
        join(root, "Library", "Keychains", "login.keychain-db"),
        join(root, ".local", "share", "keyrings", "login.keyring"),
      ];
      for (const store of stores) {
        mkdirSync(dirname(store), { recursive: true });
        writeFileSync(store, "credential-store-secret");
      }
      writeFileSync(join(root, "notes.txt"), "ordinary-home-file");
      try {
        vi.stubEnv("HOME", root);
        await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
        for (const store of stores) {
          const command = `/bin/cat ${shellQuote(store)}`;
          const result = await spawnWithSandbox(command, cwd, [cwd], 15, prepareSandboxFixture(command, cwd));
          expect(result.metadata.sandboxed).toBe(true);
          expect(result.isError, result.output).toBe(true);
          expect(result.output).toMatch(/Operation not permitted|Permission denied|No such file or directory/);
          expect(result.output).not.toContain("credential-store-secret");
        }
        const control = `/bin/cat ${shellQuote(join(root, "notes.txt"))}`;
        const ordinary = await spawnWithSandbox(control, cwd, [cwd], 15, prepareSandboxFixture(control, cwd));
        expect(ordinary.isError, ordinary.output).toBe(false);
        expect(ordinary.output).toContain("ordinary-home-file");
      } finally {
        vi.unstubAllEnvs();
        await cleanupTmpDir(root);
      }
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "reads a pre-created git repository with a disposable HOME and isolated fixture config",
    async () => {
      if (!(await asrtCanInitialize())) return;

      // A linked checkout stores Git metadata outside its working directory. This fixture owns both parts inside the admitted root, so it tests the disposable home without depending on the enclosing checkout layout.
      const cwd = mkdtempSync(join(tmpdir(), "asrt-git-"));
      const gitEnv = gitFixtureEnv(cwd);
      const fixtureGitConfig = gitEnv.GIT_CONFIG_GLOBAL;
      if (typeof fixtureGitConfig !== "string") throw new Error("Git fixture config path is missing");
      try {
        execFileSync("git", ["init", "--quiet"], { cwd, env: gitEnv });
        execFileSync("git", [
          "-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.test",
          "-c", "commit.gpgsign=false", "commit", "--allow-empty", "--quiet", "-m", "fixture",
        ], { cwd, env: gitEnv });
        await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
        // Keep fixture identity and signing configuration independent of the sandbox HOME and the user's global configuration.
        const command = `printf '%s\\n' "$HOME"; GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=${shellQuote(fixtureGitConfig)} git -C ${shellQuote(cwd)} log --oneline -n 1`;
        const result = await spawnWithSandbox(
          command,
          cwd,
          [cwd],
          15,
          prepareSandboxFixture(command, cwd),
        );

        expect(result.isError, result.output).toBe(false);
        const [sandboxHome, logLine] = result.output.split("\n");
        expect(sandboxHome).toContain("ave-sandbox-home-");
        expect(sandboxHome).not.toBe(process.env.HOME);
        expect(logLine).toMatch(/^[0-9a-f]+\s+\S/);
        expect(existsSync(sandboxHome ?? "")).toBe(false);
      } finally {
        await cleanupTmpDir(cwd);
      }
    },
  );

  it.skipIf(process.platform !== "linux" || shouldSkipNativeSandboxTests())(
    "returns a quarantine restore notice after a normal Git commit creates a control",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "asrt-git-control-result-")));
      const env = gitFixtureEnv(root);
      const config = env.GIT_CONFIG_GLOBAL;
      if (typeof config !== "string") throw new Error("Git fixture config path is missing");
      const locale = getLocale();
      setLocale("en");
      try {
        execFileSync("git", ["init", "--quiet"], { cwd: root, env });
        await initializeRequiredSandbox({ allowedDomains: [] });
        const commondir = join(root, ".git", "commondir");
        expect(() => readFileSync(commondir)).toThrow(/ENOENT/);
        const command = `export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=${shellQuote(config)}; test ! -e .git/commondir && git status --porcelain && printf committed > tracked.txt && git add tracked.txt && git -c user.name=Fixture -c user.email=fixture@example.invalid -c commit.gpgsign=false commit --quiet -m sandbox-commit && git branch sandbox-branch && printf untrusted-target > .git/commondir`;
        const result = await spawnWithSandbox(command, root, [root], TOOL_TIMEOUT_POLICY.shellDefaultMs / 1000,
          prepareSandboxFixture(command, root));
        expect(result.isError, result.output).toBe(false);
        expect(result.metadata.sandboxed).toBe(true);
        expect(result.output).toContain("moved to quarantine (not deleted)");
        expect(result.output).toContain(JSON.stringify(commondir));
        expect(result.output).toContain("Restore each entry");
        expect(() => readFileSync(commondir)).toThrow(/ENOENT/);
        expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: root, env, encoding: "utf8" }).trim()).toBe("sandbox-commit");
      } finally {
        setLocale(locale);
        await cleanupTmpDir(root);
      }
    },
  );
});

// ASRT 0.0.66 can return the bare command on Linux only when there are NO restrictions at all. Ave's initialized config always carries `network.allowedDomains` (including [] = deny all), so this real contract locks that the same wrapper route used by the boot-time `true` probe reaches bwrap's secure user namespace/capability path rather than a no-op shell.
describe("asrt-sandbox — Linux configured-wrapper runtime contract", () => {
  it.runIf(process.platform === "linux")(
    "emits bwrap with user namespace and dropped capabilities for the fixed probe command",
    async () => {
      // Keep the existing helper's contract: only unsupported/missing-dep hosts skip. A host with binaries but userns blocked must fail initialization, which is exactly the runtime-probe regression this test protects.
      if (!(await asrtCanInitialize())) return;

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const { argv } = await wrapToolCommand("true", { commandId: TEST_COMMAND_ID });
      try {
        expect(argv[1]).toBe("-c");
        const renderedWrapper = argv[2] ?? "";
        expect(renderedWrapper).toContain("bwrap");
        expect(renderedWrapper).toContain("--unshare-user");
        expect(renderedWrapper).toContain("--cap-drop");
        expect(renderedWrapper).toContain("ALL");
      } finally {
        // wrapToolCommand increments ASRT's Linux bwrap cleanup accounting even though this contract test only inspects argv and does not spawn it.
        await cleanupAsrtSandboxAfterCommand();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "binds back only the seccomp helper file when a read deny hides the package",
    async () => {
      if (!(await asrtCanInitialize())) return;

      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const helper = getVendoredApplySeccompPath()!;
      const checkout = checkoutRootAbove(helper);
      const { argv } = await wrapToolCommand("true", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [checkout], allowRead: [] } });
      try {
        const words = execFileSync("/bin/bash", ["-c", `set -- ${argv[2].split("\n# Run the confined command\n").at(-1)!.split("\naveTmpStatus=")[0]}; printf '%s\\n' "$@"`], { encoding: "utf8" }).trimEnd().split("\n");
        expect(words.some((word, index) => word === "--tmpfs" && words[index + 1] === checkout)).toBe(true);
        const reboundUnderDeny = words.flatMap((word, index) => word === "--ro-bind" && words[index + 2]!.startsWith(`${checkout}/`)
          ? [[words[index + 1], words[index + 2]]] : []);
        // The helper is the one file this wrap re-allows; ASRT itself re-allows its JVM proxy agent jar. No directory of the package comes back.
        const jar = getVendoredJavaProxyAgentJarPath();
        expect(reboundUnderDeny.sort()).toEqual([[helper, helper], [jar, jar]].sort());
        expect(words).toContain(helper);
      } finally {
        await cleanupAsrtSandboxAfterCommand();
      }
    },
  );
});

// The directory holding `node_modules` above `path` — the checkout a HOME deny would hide.
function checkoutRootAbove(path: string): string {
  let dir = dirname(path);
  while (basename(dir) !== "node_modules") {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no node_modules above ${path}`);
    dir = parent;
  }
  return dirname(dir);
}

// ASRT runs `apply-seccomp` from inside the bwrap namespace. A shell denies all of `$HOME`, so an app or checkout there hid its own helper and every strict wrap exited 127. Each wrap re-allows exactly that one file, and the shared config pins it as the path ASRT execs.
describe("asrt-sandbox — Linux seccomp helper beneath a read deny", () => {
  const hostPlatform = process.platform;
  afterEach(() => setProcessPlatform(hostPlatform));

  it("resolves the helper ASRT itself would run, canonicalised", () => {
    setProcessPlatform("linux");
    const asrtPath = getApplySeccompBinaryPath();
    expect(asrtPath).not.toBeNull();
    expect(getVendoredApplySeccompPath()).toBe(realpathSync(asrtPath!));
  });

  it("re-allows exactly the helper file under a covering deny, nothing broader", () => {
    setProcessPlatform("linux");
    // Derived from ASRT's own resolver, independently of the host's.
    const helper = realpathSync(getApplySeccompBinaryPath()!);
    const checkout = checkoutRootAbove(helper);
    for (const filesystem of [{ denyRead: [checkout], allowRead: [] }, { denyRead: [checkout] }]) {
      const allowRead = buildPerCommandSandboxCustomConfig(filesystem)?.filesystem?.allowRead;
      expect(allowRead).toEqual([helper]);
    }
    const withWorkspace = buildPerCommandSandboxCustomConfig({ denyRead: [checkout], allowRead: [tmpdir()] });
    expect(withWorkspace?.filesystem?.allowRead).toEqual([tmpdir(), helper]);
  });

  it("leaves a wrap whose denies do not cover the helper unchanged", async () => {
    setProcessPlatform("linux");
    // A fresh directory is never an ancestor of the helper, wherever the checkout lives.
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), "asrt-seccomp-elsewhere-")));
    try {
      expect(buildPerCommandSandboxCustomConfig({ denyRead: [elsewhere], allowRead: [] })?.filesystem?.allowRead).toEqual([]);
      expect(buildPerCommandSandboxCustomConfig({ denyRead: [elsewhere] })?.filesystem?.allowRead).toBeUndefined();
    } finally {
      await cleanupTmpDir(elsewhere);
    }
  });

  it("pins seccomp.applyPath to the same file in the shared config", () => {
    setProcessPlatform("linux");
    expect(buildSandboxConfig({ allowedDomains: [] }).seccomp).toEqual({ applyPath: getVendoredApplySeccompPath() });
  });

  it("adds nothing off Linux", () => {
    setProcessPlatform("darwin");
    expect(getVendoredApplySeccompPath()).toBeUndefined();
    expect(buildPerCommandSandboxCustomConfig({ denyRead: [tmpdir()], allowRead: [] })?.filesystem?.allowRead).toEqual([]);
    expect(buildPerCommandSandboxCustomConfig({ denyRead: [tmpdir()] })?.filesystem?.allowRead).toBeUndefined();
    expect(buildSandboxConfig({ allowedDomains: [] }).seccomp).toBeUndefined();
  });
});

describe("asrt-sandbox — per-command trust boundary (security MINOR)", () => {
  it("a per-command filesystem wrap cannot carry a weakening flag (no such field)", async () => {
    if (!(await asrtCanInitialize())) return;

    await initializeAsrtSandbox({ allowedDomains: [] });
    // The WrapOptions surface only exposes `filesystem` + `abortSignal`. There is no `customConfig` / network / weakening channel — a call attempting to smuggle `allowAppleEvents` etc. is a compile error, so the runtime call simply succeeds with only the filesystem slice applied.
    const { argv } = await wrapToolCommand("echo trust-ok", { commandId: TEST_COMMAND_ID,
      filesystem: { allowWrite: [], allowRead: [] },
    });
    expect(argv.length).toBeGreaterThanOrEqual(3);
  });
});

describe("asrt-sandbox — self-enforcing gate (PR #1356 NIT)", () => {
  it("wrapToolCommand throws when the sandbox is not active", async () => {
    expect(isAsrtSandboxActive()).toBe(false);
    await expect(wrapToolCommand("echo nope", { commandId: TEST_COMMAND_ID })).rejects.toThrow(/not active/i);
  });

  it("wrapWorkerCommand throws when the sandbox is not active", async () => {
    expect(isAsrtSandboxActive()).toBe(false);
    await expect(wrapWorkerCommand("echo nope", { commandId: TEST_COMMAND_ID })).rejects.toThrow(/not active/i);
  });
});

describe.runIf(process.platform === "win32")("asrt-sandbox — read evidence identity", () => {
  let profile: string;
  let target: string;
  let home: MockInstance<typeof os.homedir>;
  let user: MockInstance<typeof os.userInfo>;
  let reader: MockInstance<typeof readDenyEvidenceModule.readWindowsReadDenyEvidence>;

  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), "ave-deny-identity-"));
    mkdirSync(join(profile, ".ssh"));
    target = join(profile, ".ssh", "key");
    home = vi.spyOn(os, "homedir").mockReturnValue(profile);
    user = vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: profile });
    reader = vi.spyOn(readDenyEvidenceModule, "readWindowsReadDenyEvidence");
  });

  afterEach(async () => {
    home.mockRestore();
    user.mockRestore();
    reader.mockRestore();
    await resetAsrtSandbox();
    await cleanupTmpDir(profile);
  });

  it("keeps a private target replaced by a world-readable file without a reader call", async () => {
    writeFileSync(target, "private");
    const identity = execFileSync(win32SystemBinary("whoami"), ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const sid = identity.match(/S-1-[0-9-]+/)?.[0];
    if (sid === undefined) throw new Error("Fixture owner SID unavailable");
    execFileSync(win32SystemBinary("icacls"), [target, "/inheritance:r", "/grant:r", `*${sid}:F`], { windowsHide: true });
    const snapshot = await readDenyEvidenceModule.readWindowsReadDenyEvidence([target]);
    expect(snapshot.get(windowsReadDenyKey(target))?.status).toBe("private");
    expect(bare(buildSandboxConfig({ denyRead: [target] }, snapshot).filesystem.denyRead)).not.toContain(target);
    const before = lstatSync(target, { bigint: true });
    renameSync(target, target + ".old");
    writeFileSync(target, "replacement");
    execFileSync(win32SystemBinary("icacls"), [target, "/grant", "*S-1-1-0:(R)"], { windowsHide: true });
    expect(lstatSync(target, { bigint: true }).ino).not.toBe(before.ino);
    reader.mockClear();
    expect(bare(buildSandboxConfig({ denyRead: [target] }, snapshot).filesystem.denyRead)).toContain(target);
    expect(bare(buildPerCommandSandboxCustomConfig({ denyRead: [target] }, undefined, undefined, snapshot)?.filesystem?.denyRead ?? [])).toContain(target);
    expect(reader).not.toHaveBeenCalled();
  });

  it("keeps a missing target created after the snapshot without a reader call", async () => {
    const snapshot = await readDenyEvidenceModule.readWindowsReadDenyEvidence([target]);
    expect(snapshot.get(windowsReadDenyKey(target))?.status).toBe("missing");
    expect(bare(buildSandboxConfig({ denyRead: [target] }, snapshot).filesystem.denyRead)).not.toContain(target);
    writeFileSync(target, "created");
    reader.mockClear();
    expect(bare(buildSandboxConfig({ denyRead: [target] }, snapshot).filesystem.denyRead)).toContain(target);
    expect(bare(buildPerCommandSandboxCustomConfig({ denyRead: [target] }, undefined, undefined, snapshot)?.filesystem?.denyRead ?? [])).toContain(target);
    expect(reader).not.toHaveBeenCalled();
  });

  it("clears read evidence when initialization fails to build its config", async () => {
    await expect(initializeAsrtSandbox({ allowWrite: [process.env.ProgramData!] })).rejects.toThrow(/machine root/);
    expect(reader).toHaveBeenCalledTimes(1);
    expect(_getWindowsReadDenySnapshotForTest()).toBeUndefined();
    expect(isAsrtSandboxActive()).toBe(false);
  });
});

describe.runIf(process.platform === "win32")("asrt-sandbox — session read evidence", () => {
  let reader: MockInstance<typeof readDenyEvidenceModule.readWindowsReadDenyEvidence>;
  let wrap: MockInstance<(typeof SandboxManagerType)["wrapWithSandboxArgv"]>;
  let runtime: MockInstance[] = [];

  // A fake runtime: the evidence path is Ave-side, so these cases run without the sandbox account and stamp nothing.
  beforeEach(async () => {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    let config: SandboxRuntimeConfig | undefined;
    wrap = vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockResolvedValue({ argv: ["echo"], env: {} });
    runtime = [
      wrap,
      vi.spyOn(SandboxManager, "initialize").mockImplementation(async next => { config = next; }),
      vi.spyOn(SandboxManager, "getConfig").mockImplementation(() => config),
      vi.spyOn(SandboxManager, "updateConfig").mockImplementation(next => { config = next; }),
      vi.spyOn(SandboxManager, "reset").mockImplementation(async () => { config = undefined; }),
    ];
    reader = vi.spyOn(readDenyEvidenceModule, "readWindowsReadDenyEvidence").mockImplementation(async paths =>
      new Map(paths.map(path => [windowsReadDenyKey(path), { status: "missing" as const }])));
    await initializeAsrtSandbox({ allowedDomains: [] });
    expect(reader).toHaveBeenCalledTimes(1);
    reader.mockClear();
  });

  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    reader.mockRestore();
    for (const spy of runtime) spy.mockRestore();
  });

  it("tool wraps reuse base read evidence without a native query", async () => {
    await wrapToolCommand("echo covered", { commandId: TEST_COMMAND_ID,
      filesystem: { denyRead: getDefaultSensitiveReadDenyPaths() } });
    expect(reader).not.toHaveBeenCalled();
  });

  it("builtin shell read floors reuse base read evidence without a native query", async () => {
    const { denyRead } = getBuiltinShellReadPolicy([], homedir());
    await wrapToolCommand("echo covered", { commandId: TEST_COMMAND_ID, filesystem: { denyRead } });
    expect(reader).not.toHaveBeenCalled();
  });

  it("equivalent path spellings reuse base read evidence without a native query", async () => {
    const target = join(homedir(), ".ssh").toUpperCase().replace(/\\/g, "/") + "/";
    await wrapToolCommand("echo covered", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [target] } });
    expect(reader).not.toHaveBeenCalled();
  });

  it("worker wraps reuse base read evidence without a native query", async () => {
    await wrapWorkerCommand("echo covered", { commandId: TEST_COMMAND_ID,
      filesystem: { denyRead: getDefaultSensitiveReadDenyPaths() } });
    expect(reader).not.toHaveBeenCalled();
  });

  it("terminal wraps reuse base read evidence without a native query", async () => {
    await wrapTerminalCommand("echo covered", { commandId: TEST_COMMAND_ID, ownTty: "/dev/ttys000",
      filesystem: { denyRead: getDefaultSensitiveReadDenyPaths() } });
    expect(reader).not.toHaveBeenCalled();
  });

  it("an uncovered profile deny queries only that path", async () => {
    const extra = join(homedir(), ".extra-profile-secret");
    await wrapToolCommand("echo extra", { commandId: TEST_COMMAND_ID,
      filesystem: { denyRead: [...getDefaultSensitiveReadDenyPaths(), extra] } });
    expect(reader.mock.calls).toEqual([[[extra]]]);
  });

  it("worker socket registration reuses base read evidence without a native query", async () => {
    const socketDir = join(homedir(), "worker-sockets");
    const holder = {};
    await registerWorkerUnixSocketDir(socketDir, holder);
    expect(reader).not.toHaveBeenCalled();
  });

  it("worker socket unregistration reuses base read evidence without a native query", async () => {
    const socketDir = join(homedir(), "worker-sockets");
    const holder = {};
    await registerWorkerUnixSocketDir(socketDir, holder);
    reader.mockClear();
    await unregisterWorkerUnixSocketDir(socketDir, holder);
    expect(reader).not.toHaveBeenCalled();
  });

  it("all command wraps keep a base target created after initialization without a native query", async () => {
    const target = join(homedir(), ".docker", "config.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "fixture");
    try {
      await wrapToolCommand("echo covered", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [target] } });
      await wrapWorkerCommand("echo covered", { commandId: TEST_COMMAND_ID, filesystem: { denyRead: [target] } });
      await wrapTerminalCommand("echo covered", { commandId: TEST_COMMAND_ID, ownTty: "/dev/ttys000",
        filesystem: { denyRead: [target] } });
      expect(wrap).toHaveBeenCalledTimes(3);
      expect(bare(wrap.mock.calls[0]?.[2]?.filesystem?.denyRead ?? [])).toContain(realpathSync.native(target));
      expect(bare(wrap.mock.calls[1]?.[2]?.filesystem?.denyRead ?? [])).toContain(realpathSync.native(target));
      expect(bare(wrap.mock.calls[2]?.[2]?.filesystem?.denyRead ?? [])).toContain(realpathSync.native(target));
      expect(reader).not.toHaveBeenCalled();
    } finally {
      rmSync(target);
    }
  });

  it("worker socket updates keep a base target created after initialization without a native query", async () => {
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const target = join(homedir(), ".docker", "config.json");
    expect(bare(SandboxManager.getConfig()!.filesystem.denyRead)).not.toContain(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "fixture");
    try {
      const holder = {};
      await registerWorkerUnixSocketDir(join(homedir(), "identity-worker-sockets"), holder);
      expect(bare(SandboxManager.getConfig()!.filesystem.denyRead)).toContain(target);
      await unregisterWorkerUnixSocketDir(join(homedir(), "identity-worker-sockets"), holder);
      expect(bare(SandboxManager.getConfig()!.filesystem.denyRead)).toContain(target);
      expect(reader).not.toHaveBeenCalled();
    } finally {
      rmSync(target);
    }
  });

  it("reset clears read evidence and reinitialization takes a fresh snapshot", async () => {
    const initial = _getWindowsReadDenySnapshotForTest();
    expect(initial?.size).toBeGreaterThan(0);
    await resetAsrtSandbox();
    expect(_getWindowsReadDenySnapshotForTest()).toBeUndefined();
    await initializeAsrtSandbox({ allowedDomains: [] });
    expect(reader).toHaveBeenCalledTimes(1);
    expect(_getWindowsReadDenySnapshotForTest()).not.toBe(initial);
  });
});

describe("asrt-sandbox — idempotency guard (PR #1356 NIT)", () => {
  it("initialize throws if already active (double-init is a loud failure)", async () => {
    if (!(await asrtCanInitialize())) return;
    await initializeAsrtSandbox({ allowedDomains: [] });
    expect(isAsrtSandboxActive()).toBe(true);
    await expect(initializeAsrtSandbox({ allowedDomains: [] })).rejects.toThrow(/already active/i);
  });
});

// Plugin trees a confined process may write are deleted recursively only before any such process can run (lib/confined-process-phase.ts); a wrap is where one begins, so it has to start that phase itself.
describe("asrt-sandbox — a wrap begins the confined-process phase", () => {
  afterEach(() => _resetConfinedProcessPhaseForTests());
  for (const kind of ["tool", "worker"] as const) {
    it(`${kind} wrap marks that confined processes may run`, async ({ skip }) => {
      if (!(await asrtCanInitialize())) skip("ASRT cannot initialize on this host");
      await initializeAsrtSandbox({ allowedDomains: [] });
      _resetConfinedProcessPhaseForTests();
      expect(confinedProcessesMayBeRunning()).toBe(false);
      const wrap = kind === "tool" ? wrapToolCommand : wrapWorkerCommand;
      await wrap("true", { commandId: TEST_COMMAND_ID, filesystem: { allowWrite: [], allowRead: [] } });
      expect(confinedProcessesMayBeRunning()).toBe(true);
    });
  }
});

describe("asrt-sandbox — worker wrap carries only the filesystem jail", () => {
  it("wrapWorkerCommand wraps with no per-command network override (network is the shared config)", async () => {
    if (!(await asrtCanInitialize())) return;
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    // WrapOptions exposes only `filesystem` + `abortSignal` — there is no `network` channel (it would be INERT per command; enforcement is the shared config). The wrap succeeds with the filesystem slice only.
    const { argv } = await wrapWorkerCommand("echo worker-ok", { commandId: TEST_COMMAND_ID,
      filesystem: { allowWrite: [], allowRead: [] },
    });
    expect(argv.length).toBeGreaterThanOrEqual(3);
    if (process.platform === "win32") expect(argv.slice(1, 3)).toEqual(["--srt-win", "exec"]);
    else expect(argv[1]).toBe("-c");
  });
});

describe("asrt-sandbox — REAL enforcement via the SHARED config (strict union allow-list)", () => {
  // Pin reserved localhost probe names to the local server so DNS differences cannot masquerade as policy denials. Keep real proxy allow/deny and address checks, force proxy use despite NO_PROXY, and send no traffic off-machine.
  const ALLOWED_HOST = "allowed.localhost";
  const OTHER_HOST = "other.localhost";
  let server: Server | undefined;
  let port = 0;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    const probeHosts = new Set([ALLOWED_HOST, OTHER_HOST]);
    setDestinationResolverForTesting(async (name) => {
      if (probeHosts.has(name)) return [{ address: "127.0.0.1", family: 4 }];
      return lookupAll(name, { all: true, verbatim: true });
    });
  });

  afterAll(async () => {
    setDestinationResolverForTesting(undefined);
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  });

  const curlProbe = async (host: string) => {
    const { argv, env } = await wrapWorkerCommand(
      `curl -sS -o /dev/null -w '%{http_code}' --max-time 20 --noproxy '' http://${host}:${port}/`,
      { commandId: TEST_COMMAND_ID, filesystem: { allowWrite: [], allowRead: [] } },
    );
    const res = await runArgv(argv, env);
    cleanupAsrtSandboxAfterCommand();
    return res;
  };
  const httpOk = (r: { code: number | null; stdout: string }) =>
    r.code === 0 && /^[23]\d\d$/.test(r.stdout.trim());
  // The proxy refused the name: curl got an HTTP status, and it is 403.
  const proxyDenied = (r: { code: number | null; stdout: string }) => r.stdout.trim() === "403";

  it("in-union host is permitted and out-of-union host is hard-denied with NO askCb", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    if (!(await asrtCanInitialize())) return;

    const askCalls: Array<{ host: string }> = [];
    const recordingAskCb = async (p: { host: string; port: number | undefined }) => {
      askCalls.push({ host: p.host });
      return true; // would ALLOW if ever consulted — strict must bypass it.
    };

    // Shared config: union includes ALLOWED_HOST, NOT OTHER_HOST. strictAllowlist hard-denies everything else.
    await initializeAsrtSandbox(
      { allowedDomains: [ALLOWED_HOST], strictAllowlist: true },
      recordingAskCb,
    );
    const allowed = await curlProbe(ALLOWED_HOST);
    const denied = await curlProbe(OTHER_HOST);
    await resetAsrtSandbox();

    expect(httpOk(allowed)).toBe(true);
    // Out-of-union host is HARD-DENIED at the egress proxy.
    expect(proxyDenied(denied)).toBe(true);
    // Strict means the askCb is NEVER consulted — prove no interactive fallthrough for the out-of-union host (the model is superseded).
    expect(askCalls).toHaveLength(0);
  }, 60_000);

  it("changing the union changes the result (the shared config genuinely enforces)", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    if (!(await asrtCanInitialize())) return;

    await initializeAsrtSandbox({ allowedDomains: [ALLOWED_HOST], strictAllowlist: true });
    // With OTHER_HOST out of the union it is denied.
    const beforeAdd = await curlProbe(OTHER_HOST);
    await resetAsrtSandbox();
    expect(proxyDenied(beforeAdd)).toBe(true);

    // Now ADD OTHER_HOST to the union → the SHARED config now PERMITS it (no longer a strict hard-deny on a config-rule miss). Same probe, same host — only the shared allow-list changed. This is the property the inert per-command override could never provide.
    await initializeAsrtSandbox({
      allowedDomains: [ALLOWED_HOST, OTHER_HOST],
      strictAllowlist: true,
    });
    const afterAdd = await curlProbe(OTHER_HOST);
    await resetAsrtSandbox();
    expect(httpOk(afterAdd)).toBe(true);
  }, 60_000);

  it("a host derived from a CONFIGURED endpoint (settings → computeDynamicEndpointHosts) is allowed, a host from no endpoint is not", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    if (!(await asrtCanInitialize())) return;

    // DYNAMIC-ENDPOINT PROVENANCE: the allow-list host comes from a SETTINGS baseUrl reduced via computeDynamicEndpointHosts — the exact boot path for a user-configured Azure/embedding endpoint — NOT a hardcoded literal.
    const dynamicHostsFor = (baseUrl: string) =>
      computeDynamicEndpointHosts({ llm: { vendors: { "azure-foundry": { baseUrl } } } });

    // Union built from the CONFIGURED endpoint, normalized for ASRT exactly as boot does.
    const initialUnion = normalizeUnionForAsrt(
      dynamicHostsFor(`http://${ALLOWED_HOST}:${port}/openai/v1`),
    );
    expect(initialUnion).toContain(ALLOWED_HOST);

    await initializeAsrtSandbox({ allowedDomains: initialUnion, strictAllowlist: true });
    const configuredAllowed = await curlProbe(ALLOWED_HOST);
    // A host NOT derived from any configured endpoint is HARD-DENIED.
    const nonConfiguredDenied = await curlProbe(OTHER_HOST);
    expect(httpOk(configuredAllowed)).toBe(true);
    expect(proxyDenied(nonConfiguredDenied)).toBe(true);

    // Recompute the configured endpoint and exercise the live runtime config swap without reinitializing the sandbox. Worker endpoint permissions are refreshed separately through their attributed egress callback.
    const refreshedUnion = normalizeUnionForAsrt(
      dynamicHostsFor(`http://${OTHER_HOST}:${port}/openai/v1`),
    );
    expect(refreshedUnion).toContain(OTHER_HOST);
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const current = SandboxManager.getConfig();
    expect(current).toBeDefined();
    SandboxManager.updateConfig({
      ...current!,
      network: { ...current!.network, allowedDomains: refreshedUnion },
    });

    // After the live refresh: the NEW configured host is allowed, the OLD one is now hard-denied — proving the swap took effect with no restart.
    const newHostAllowed = await curlProbe(OTHER_HOST);
    const oldHostDenied = await curlProbe(ALLOWED_HOST);
    await resetAsrtSandbox();
    expect(httpOk(newHostAllowed)).toBe(true);
    expect(proxyDenied(oldHostDenied)).toBe(true);
  }, 60_000);
});

describe("asrt-sandbox — parentProxy explicit (PR #1356 security MINOR)", () => {
  it("the composed child env never carries the host HTTP_PROXY (no covert egress chain)", async () => {
    if (!(await asrtCanInitialize())) return;
    // Set a bogus host proxy. Two layers must prevent it reaching the child: 1. network.parentProxy is set explicitly to {} so ASRT's egress proxy does NOT chain through the host proxy (resolveParentProxy would otherwise silently inherit process.env.HTTP_PROXY); 2. buildSandboxedChildEnv strips the host HTTP_PROXY from the child env because ASRT did not change it (it equals process.env).
    const { buildSandboxedChildEnv } = await import("../../tools/safe-env.js");
    const HOST_PROXY = "http://host-proxy.invalid:3128";
    const prev = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = HOST_PROXY;
    try {
      await initializeAsrtSandbox({ allowedDomains: ["example.com"], strictAllowlist: true });
      const { env } = await wrapWorkerCommand("echo proxy-check", { commandId: TEST_COMMAND_ID,
        filesystem: { allowWrite: [], allowRead: [] },
      });
      const childEnv = buildSandboxedChildEnv(env);
      // The host's external proxy must never reach the sandboxed child. Any HTTP_PROXY present must be ASRT's own localhost egress proxy.
      if (childEnv.HTTP_PROXY !== undefined) {
        expect(childEnv.HTTP_PROXY).not.toContain("host-proxy.invalid");
      }
      cleanupAsrtSandboxAfterCommand();
    } finally {
      if (prev === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prev;
    }
  });
});

describe("asrt-sandbox — computeDynamicEndpointHosts (user-configured endpoint union seam)", () => {
  // Some plugins' real egress host is NOT a static manifest domain but USER-CONFIGURED — notably local-indexer's embedding/caption calls hit the host's Azure OpenAI resource (`llm.vendors["azure-foundry"].baseUrl`, the same value resolveApiKey hands the worker). This extractor reduces every configured vendor baseUrl to its hostname so the union reflects what plugins actually reach. No-fallback: a malformed/empty endpoint yields NO host (never a wildcard / allow-all).
  it("extracts the hostname from an Azure OpenAI resource baseUrl", () => {
    expect(
      computeDynamicEndpointHosts({
        llm: {
          vendors: {
            "azure-foundry": {
              baseUrl: "https://my-resource.openai.azure.com/openai/deployments/x",
            },
          },
        },
      }),
    ).toEqual(["my-resource.openai.azure.com"]);
  });

  it("includes the active marketplace preset's host, which no vendor block holds", () => {
    // A preset's address lives in the preset registry, not in the openai-compatible block. Reading blocks alone would leave the endpoint chat is actually talking to out of the union — hard-denied under strict enforcement while the provider looks configured and healthy.
    expect(
      computeDynamicEndpointHosts({
        llm: {
          vendors: { "openai-compatible": { baseUrl: "http://localhost:8001/v1" } },
          marketplaceProviderPresetId: "future-router",
        },
        marketplace: {
          installedProviderPresets: [
            { providerId: "future-router", baseUrl: "https://future.example/v1" },
            // Installed but not selected: not a route anything reaches, so it must not widen an enforced allow-list.
            { providerId: "other-router", baseUrl: "https://other.example/v1" },
          ],
        },
      }),
    ).toEqual(["localhost", "future.example"]);
  });

  it("collects hostnames across multiple configured vendors, deduped + order-stable", () => {
    expect(
      computeDynamicEndpointHosts({
        llm: {
          vendors: {
            "azure-foundry": { baseUrl: "https://res.openai.azure.com/v1" },
            openai: { baseUrl: "https://proxy.internal.example:8443/v1" },
            // duplicate host (different path) collapses to one entry
            "vertex-ai": { baseUrl: "https://res.openai.azure.com/other" },
          },
        },
      }),
    ).toEqual(["res.openai.azure.com", "proxy.internal.example"]);
  });

  it("a malformed/empty/whitespace baseUrl contributes NOTHING (deny-by-default, NOT a wildcard)", () => {
    expect(
      computeDynamicEndpointHosts({
        llm: {
          vendors: {
            "azure-foundry": { baseUrl: "not a url" },
            openai: { baseUrl: "" },
            "vertex-ai": { baseUrl: "   " },
            gemini: { baseUrl: undefined },
            // a value present but not even a string
            claude: { baseUrl: 123 as unknown as string },
          },
        },
      }),
    ).toEqual([]);
    // No vendors / no llm section ⇒ empty (never an allow-all fallback).
    expect(computeDynamicEndpointHosts({})).toEqual([]);
    expect(computeDynamicEndpointHosts(undefined)).toEqual([]);
    expect(computeDynamicEndpointHosts({ llm: {} })).toEqual([]);
  });
});

describe("asrt-sandbox — parentProxy direct-connect floor (PR #1356 MAJOR, corrected)", () => {
  // Pins the ASRT contract the buildSandboxConfig default path depends on: resolveParentProxy (parent-proxy.js:46) is `cfg?.http ?? process.env.HTTP_PROXY ?? process.env.http_proxy`. An EMPTY object `{}` (the prior buggy value) has no `http` key, so the `??` chain STILL inherits the host HTTP_PROXY — identical to passing nothing. Only EXPLICIT EMPTY STRINGS short-circuit the chain (`'' ?? x` ⇒ `''`) and yield genuine direct-connect. The fix emits `{ http: '', https: '' }` on the default path, so resolveParentProxy returns undefined (no host-proxy chaining) even with a host HTTP_PROXY set.
  it("explicit empty strings → no host-proxy inheritance; {} would inherit (proves the floor)", () => {
    const prev = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://host-proxy.invalid:3128";
    try {
      // The value buildSandboxConfig emits on the DEFAULT path (no upstreamProxy).
      const direct = resolveParentProxy({ http: "", https: "" });
      expect(direct).toBeUndefined(); // direct-connect, no inheritance

      // The OLD buggy value — proves why `{}` is NOT a secure floor.
      const inherited = resolveParentProxy({});
      expect(inherited).toBeDefined();
      expect(inherited?.httpUrl?.href).toContain("host-proxy.invalid");

      // Sanity: undefined behaves identically to `{}` (both inherit).
      expect(resolveParentProxy(undefined)?.httpUrl?.href).toContain("host-proxy.invalid");
    } finally {
      if (prev === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prev;
    }
  });

  it("a trusted upstreamProxy value is honored (still no host-env inheritance path)", () => {
    const prev = process.env.HTTP_PROXY;
    process.env.HTTP_PROXY = "http://host-proxy.invalid:3128";
    try {
      // What buildSandboxConfig emits when upstreamProxy.http is set.
      const corp = resolveParentProxy({ http: "http://corp-proxy.example:8080", https: "" });
      expect(corp?.httpUrl?.href).toContain("corp-proxy.example");
      expect(corp?.httpUrl?.href).not.toContain("host-proxy.invalid");
    } finally {
      if (prev === undefined) delete process.env.HTTP_PROXY;
      else process.env.HTTP_PROXY = prev;
    }
  });

  it("passes the trusted resolvesNames opt-in for an upstream on this host, and only when set", () => {
    const off = buildSandboxConfig({ allowedDomains: [], upstreamProxy: { http: "http://127.0.0.1:3128" } });
    expect(off.network.parentProxy).toEqual({ http: "http://127.0.0.1:3128", https: "" });
    const on = buildSandboxConfig({ allowedDomains: [], upstreamProxy: { http: "http://127.0.0.1:3128", resolvesNames: true } });
    expect(on.network.parentProxy).toEqual({ http: "http://127.0.0.1:3128", https: "", resolvesNames: true });
    expect(buildSandboxConfig({ allowedDomains: [] }).network.parentProxy).toEqual({ http: "", https: "" });
  });
});

describe("asrt-sandbox — normalizeUnionForAsrt (domain-matching alignment, PR #1356 MINOR)", () => {
  // ASRT matchesDomainPattern (domain-pattern.js:23) matches a BARE domain EXACTLY; a strict subdomain needs `*.d`. Ave hostFetch treats a bare domain as a dot-boundary SUFFIX. normalizeUnionForAsrt emits both `d` and `*.d` so ASRT's matcher reproduces the suffix semantics. These assertions run the REAL vendored matcher against the normalized list.
  it("emits apex + wildcard for each bare domain (order-stable, deduped)", () => {
    expect(normalizeUnionForAsrt(["example.com"])).toEqual([
      "example.com",
      "*.example.com",
    ]);
    expect(
      normalizeUnionForAsrt(["a.example", "a.example", "b.example"]),
    ).toEqual(["a.example", "*.a.example", "b.example", "*.b.example"]);
  });

  it("passes wildcard entries through unchanged; drops `*` and empties", () => {
    expect(normalizeUnionForAsrt(["*.example.com"])).toEqual(["*.example.com"]);
    expect(normalizeUnionForAsrt(["*", "", "  "])).toEqual([]);
  });

  it("normalized bare domain matches the apex AND subdomains under the REAL ASRT matcher", () => {
    const normalized = normalizeUnionForAsrt(["example.com"]);
    const matches = (host: string) =>
      normalized.some((p) => matchesDomainPattern(host, p));
    // Apex + strict subdomains are ALLOWED (mirrors Ave suffix semantics).
    expect(matches("example.com")).toBe(true);
    expect(matches("sub.example.com")).toBe(true);
    expect(matches("a.b.example.com")).toBe(true);
    // A different registrable domain and a suffix-spoof are NOT allowed.
    expect(matches("notexample.com")).toBe(false);
    expect(matches("example.com.attacker.com")).toBe(false);
  });

  it("a RAW bare domain (un-normalized) would NOT match subdomains under ASRT — the divergence the fix closes", () => {
    // This is the bug: without normalization, ASRT's exact match rejects the subdomain that Ave hostFetch would have allowed.
    expect(matchesDomainPattern("sub.example.com", "example.com")).toBe(false);
    expect(matchesDomainPattern("example.com", "example.com")).toBe(true);
  });
});

describe("asrt-sandbox — proxyPortRange single SOT (install↔config consistency)", () => {
  const programData = process.env.ProgramData;
  beforeEach(() => {
    // Keep the machine fixture disjoint from grants covering the helper's temp parent.
    process.env.ProgramData = join(process.env.AVE_TEST_RUN_HOME!, "program-data");
  });
  afterEach(() => {
    if (programData === undefined) delete process.env.ProgramData;
    else process.env.ProgramData = programData;
  });

  // The WFP rule stamped at install time MUST cover exactly the port range the srt-win egress proxy binds at runtime. Both the install handler (ipc/domains/permissions.ts sandboxWindowsInstall) and buildSandboxConfig (asrt-sandbox.ts) source their range from the SAME local DEFAULT_WINDOWS_PROXY_PORT_RANGE constant — the local mirror of ASRT's value. This test pins the invariant: the local constant is identical to ASRT's real export, so the WFP-permitted range (stamped at install) equals the proxy bind range (at runtime) by construction, and any upstream drift in ASRT fails this test rather than silently desyncing the two paths.
  it("local DEFAULT_WINDOWS_PROXY_PORT_RANGE matches ASRT's real export", async () => {
    const asrt = await import("@anthropic-ai/sandbox-runtime");
    // Both references must be the identical value — the install path and the buildSandboxConfig runtime path converge on this one constant.
    expect(DEFAULT_WINDOWS_PROXY_PORT_RANGE).toEqual(asrt.DEFAULT_WINDOWS_PROXY_PORT_RANGE);
  });

  it("getVendoredSrtWinExePath matches ASRT's real VENDORED_SRT_WIN_EXE (srt-win path SoT pin)", async () => {
    // ASRT 0.0.67 REMOVED implicit vendored resolution — every Windows entry point must supply an EXPLICIT srt-win path. getVendoredSrtWinExePath is the local SoT that boot (checkAsrtDependencies), buildSandboxConfig, and the per-worker ACL grant all source from. Pin it to ASRT's own vendored-exe constant so upstream drift in the vendored layout fails CI rather than silently resolving a wrong/absent path. (Dev env has no `app.asar` segment, so the app.asar.unpacked rewrite is a no-op here.)
    const asrt = await import("@anthropic-ai/sandbox-runtime");
    expect(getVendoredSrtWinExePath()).toBe(asrt.VENDORED_SRT_WIN_EXE);
  });

  it("buildSandboxConfig emits the local SOT constant as windows.proxyPortRange (win32 path)", () => {
    // Force win32 so the windows section is emitted regardless of the actual platform running CI. The install handler sources the same local constant, so this assertion proves both paths use the same value.
    const prevPlatform = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const config = buildSandboxConfig({ allowedDomains: [] });
      // The windows section must be present and use the local SOT constant.
      expect(config.windows).toBeDefined();
      expect(config.windows!.proxyPortRange).toEqual(DEFAULT_WINDOWS_PROXY_PORT_RANGE);
      const executable = config.windows!.srtWin!.path;
      expect(executable).not.toBe(getVendoredSrtWinExePath());
      expect(readFileSync(executable)).toEqual(readFileSync(getVendoredSrtWinExePath()));
      expect(bare(config.filesystem.denyWrite)).toContain(dirname(executable));
      expect(() => buildSandboxConfig({ allowWrite: [dirname(dirname(executable))] }))
        .toThrow("Windows filesystem grant overlaps a private helper image");
      expect(() => buildSandboxConfig({ allowWrite: [dirname(dirname(dirname(executable)))] }))
        .toThrow("Windows filesystem grant overlaps a private helper image");
      expect(() => buildSandboxConfig({ allowWrite: [join(dirname(dirname(executable)), "sibling")] }))
        .toThrow("Windows filesystem grant overlaps a private helper image");
      expect(() => buildSandboxConfig({ allowRead: [dirname(executable)] }))
        .toThrow("Windows filesystem grant overlaps a private helper image");
    } finally {
      if (prevPlatform) {
        Object.defineProperty(process, "platform", prevPlatform);
      }
    }
  });

  it("refuses a helper-covering write grant even when the Git scan budget narrows it away", () => {
    // The temp root the helper copy lives in is shared with sibling test files;
    // once it holds more entries than the Git-control scan may visit, the write
    // policy withdraws the root. The refusal must not depend on that.
    const hostPlatform = process.platform;
    let filler: string | undefined;
    try {
      setProcessPlatform("win32");
      const executable = buildSandboxConfig({ allowedDomains: [] }).windows!.srtWin!.path;
      const root = dirname(dirname(dirname(executable)));
      filler = mkdtempSync(join(root, "scan-budget-"));
      for (let group = 0; group < 180; group += 1) {
        mkdirSync(join(filler, `g${group}`));
        for (let file = 0; file < 100; file += 1) writeFileSync(join(filler, `g${group}`, `f${file}`), "");
      }
      expect(buildMandatorySandboxWritePolicy([root]).narrowedWriteRoots)
        .toEqual([{ root: realpathSync(root), reason: "entry-budget" }]);
      expect(() => buildSandboxConfig({ allowWrite: [root] }))
        .toThrow("Windows filesystem grant overlaps a private helper image");
    } finally {
      setProcessPlatform(hostPlatform);
      if (filler !== undefined) rmSync(filler, { recursive: true, force: true });
    }
  });

  it("does not require a helper image when external confinement owns Windows execution", () => {
    const previous = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      const config = buildSandboxConfig({ windows: { externalConfinement: true } });
      expect(config.windows!.srtWin).toBeUndefined();
    } finally {
      if (previous) Object.defineProperty(process, "platform", previous);
    }
  });
});

describe("asrt-sandbox — sensitive read deny-list (host-secret hardening)", () => {
  // getDefaultSensitiveReadDenyPaths derives `~/.ave/*` from aveHome (which honors the AVE_HOME env override) and the standard credential stores from os.homedir. Pin AVE_HOME to a deterministic value so the ~/.ave assertions are stable across machines; restore it after each test.
  const FAKE_AVE_HOME = join(tmpdir(), "ave-readdeny-test-home", ".ave");
  let prevAveHome: string | undefined;

  beforeAll(() => {
    for (const name of ["secrets", "keys", "sessions"]) mkdirSync(join(FAKE_AVE_HOME, name), { recursive: true });
    writeFileSync(join(FAKE_AVE_HOME, "settings.json"), "fixture");
  });
  afterAll(() => rmSync(dirname(FAKE_AVE_HOME), { recursive: true, force: true }));

  beforeEach(() => {
    prevAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = FAKE_AVE_HOME;
  });
  afterEach(() => {
    if (prevAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = prevAveHome;
  });

  it("returns the expected absolute sensitive paths (Ave namespaces + standard credential stores)", () => {
    const paths = getDefaultSensitiveReadDenyPaths().map((path) => path.replace(/[\\/]$/, ""));
    const home = homedir();

    // Every entry is an absolute path with NO glob char (literal — works on both macOS seatbelt subpath and Linux bwrap deny-bind; ASRT only expands globs).
    for (const p of paths) {
      expect(p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p)).toBe(true);
      expect(/[*?[\]]/.test(p)).toBe(false);
    }

    // Ave host-domain sensitive namespaces, derived from the (overridden) aveHome.
    expect(paths).toContain(join(FAKE_AVE_HOME, "secrets"));
    expect(paths).toContain(join(FAKE_AVE_HOME, "sessions"));
    expect(getDefaultSensitiveWriteDenyPaths()).toContain(join(FAKE_AVE_HOME, "sessions") + (process.platform === "win32" ? sep : ""));
    expect(paths).toContain(join(FAKE_AVE_HOME, "routine"));
    expect(paths).toContain(join(FAKE_AVE_HOME, "audit.log"));
    expect(paths).toContain(join(FAKE_AVE_HOME, "audit"));
    expect(paths).toContain(join(FAKE_AVE_HOME, "settings.json"));

    // Standard credential / secret stores under the real home.
    expect(paths).toContain(join(home, ".ssh"));
    expect(paths).toContain(join(home, ".aws"));
    expect(paths).toContain(join(home, ".config", "gcloud"));
    expect(paths).toContain(join(home, ".config", "gh"));
    expect(paths).toContain(join(home, ".config", "git"));
    expect(paths).toContain(join(home, ".kube", "config"));
    expect(paths).toContain(join(home, ".gnupg"));
    expect(paths).toContain(join(home, ".npmrc"));
    expect(paths).toContain(join(home, ".netrc"));
    expect(paths).toContain(join(home, ".git-credentials"));
    expect(paths).toContain(join(home, ".docker", "config.json"));

    // Ave ~/.ave permission / auth-partition namespaces.
    expect(paths).toContain(join(FAKE_AVE_HOME, "permissions"));
    expect(paths).toContain(join(FAKE_AVE_HOME, "permissions.json"));
    expect(paths).toContain(join(FAKE_AVE_HOME, "policy.json"));
    expect(paths).toContain(join(FAKE_AVE_HOME, "plugins", "auth-partitions.json"));

    // Literal pins on the sandbox projection of SENSITIVE_PATH_ENTRIES.
    expect(paths).toContain(join(FAKE_AVE_HOME, "certs"));
    expect(paths).toContain(join(FAKE_AVE_HOME, "keys"));
    expect(paths).toContain(join(home, ".azure"));
    expect(paths).toContain(join(home, ".pgpass"));
    expect(paths).toContain(join(home, ".gitconfig"));
    expect(paths).toContain(join(home, ".bash_history"));
    expect(paths).toContain(join(home, ".zsh_history"));

    // Electron userData dir (deny whole dir — covers OAuth session cookies/tokens, Cookies SQLite, Local/Session Storage, ave-secrets.json, etc.). FIX 1: Linux base mirrors Electron's XDG_CONFIG_HOME resolution.
    const xdgBase = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
    const expectedUserData =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Ave")
        : process.platform === "win32"
          ? join(home, "AppData", "Roaming", "Ave")
          : join(xdgBase, "Ave");
    expect(paths).toContain(expectedUserData);

    // No duplicates (deduped, order-stable).
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("does NOT deny $HOME wholesale (over-deny safety — legit shell tools still read ~)", () => {
    const paths = getDefaultSensitiveReadDenyPaths();
    const home = homedir();
    // The bare home dir must never be on the deny-list — denying all of ~ would break tools reading ~/.cargo, ~/.config, etc. We deny SPECIFIC subpaths.
    expect(paths).not.toContain(home);
    // A clearly-legit subpath (not a credential store) must NOT be denied.
    expect(paths).not.toContain(join(home, ".cargo"));
    // ~/.config wholesale must never be denied — only specific subdirs.
    expect(paths).not.toContain(join(home, ".config"));
  });

  // Credential floor review: browser profiles, keychains, keyrings and password managers are on the OS read floor of every platform's builtin shell, beside `.ssh`. Spelled out here, not derived from the table, so a dropped row fails.
  describe.each([
    ["darwin", [
      ["Library", "Keychains"],
      ["Library", "Cookies"],
      ["Library", "Containers", "com.apple.Safari"],
      // The vendor parent covers every Chrome channel (Beta, Dev, Canary).
      ["Library", "Application Support", "Google"],
      ["Library", "Application Support", "Microsoft Edge"],
      ["Library", "Application Support", "Microsoft Edge Beta"],
      ["Library", "Application Support", "Microsoft Edge Dev"],
      ["Library", "Application Support", "Microsoft Edge Canary"],
      ["Library", "Application Support", "BraveSoftware"],
      ["Library", "Application Support", "Chromium"],
      ["Library", "Application Support", "Arc"],
      ["Library", "Application Support", "Vivaldi"],
      ["Library", "Application Support", "com.operasoftware.Opera"],
      ["Library", "Application Support", "com.operasoftware.OperaGX"],
      ["Library", "Application Support", "Firefox"],
      ["Library", "Thunderbird"],
      ["Library", "Group Containers", "2BUA8C4S2C.com.1password"],
      ["Library", "Group Containers", "2BUA8C4S2C.com.agilebits"],
      [".password-store"],
      [".config", "op"],
    ]],
    ["linux", [
      [".mozilla"],
      [".config", "google-chrome"],
      [".config", "chromium"],
      [".config", "BraveSoftware"],
      [".config", "microsoft-edge"],
      [".config", "vivaldi"],
      [".config", "opera"],
      [".config", "google-chrome-beta"],
      [".config", "google-chrome-unstable"],
      [".config", "microsoft-edge-beta"],
      [".config", "microsoft-edge-dev"],
      ["snap", "firefox"],
      ["snap", "chromium"],
      ["snap", "brave"],
      ["snap", "thunderbird"],
      [".var", "app", "org.mozilla.firefox"],
      [".var", "app", "org.chromium.Chromium"],
      [".var", "app", "com.google.Chrome"],
      [".var", "app", "com.brave.Browser"],
      [".var", "app", "com.microsoft.Edge"],
      [".var", "app", "org.mozilla.Thunderbird"],
      [".thunderbird"],
      [".local", "share", "keyrings"],
      [".local", "share", "kwalletd"],
      [".password-store"],
      [".config", "op"],
    ]],
    ["win32", [
      ["AppData", "Local", "Google", "Chrome", "User Data"],
      ["AppData", "Local", "Microsoft", "Edge", "User Data"],
      ["AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data"],
      ["AppData", "Local", "Chromium", "User Data"],
      ["AppData", "Local", "Vivaldi", "User Data"],
      ["AppData", "Roaming", "Opera Software"],
      ["AppData", "Local", "Google", "Chrome SxS", "User Data"],
      ["AppData", "Local", "Google", "Chrome Beta", "User Data"],
      ["AppData", "Local", "Google", "Chrome Dev", "User Data"],
      ["AppData", "Local", "Microsoft", "Edge Beta", "User Data"],
      ["AppData", "Local", "Microsoft", "Edge Dev", "User Data"],
      ["AppData", "Local", "Microsoft", "Edge SxS", "User Data"],
      ["AppData", "Roaming", "Thunderbird"],
      ["AppData", "Roaming", "Mozilla", "Firefox", "Profiles"],
      ["AppData", "Roaming", "Microsoft", "Credentials"],
      ["AppData", "Local", "Microsoft", "Credentials"],
      ["AppData", "Roaming", "Microsoft", "Protect"],
    ]],
  ] as const)("credential floor on %s", (platform, stores) => {
    const hostPlatform = process.platform;
    beforeEach(() => setProcessPlatform(platform));
    afterEach(() => setProcessPlatform(hostPlatform));

    it.each(stores.map((segments) => [segments.join("/"), segments] as const))("denies reads of ~/%s", (_name, segments) => {
      // A Windows directory row keeps its separator so ASRT denies a directory.
      const store = join(homedir(), ...segments) + (platform === "win32" ? sep : "");
      const cwd = join(tmpdir(), "ave-credential-floor-cwd");
      expect(getBuiltinShellReadPolicy([cwd], homedir()).denyRead).toContain(store);
      expect(getDefaultSensitiveReadDenyPaths()).toContain(store);
      expect(getDefaultSensitiveWriteDenyPaths()).toContain(store);
    });

    it("keeps ordinary home reads and the home itself off the floor", () => {
      const read = getBuiltinShellReadPolicy([join(homedir(), "projects", "x")], homedir());
      expect(read.denyRead).not.toContain(homedir());
      expect(read.allowRead).toContain(join(homedir(), "projects", "x"));
      for (const ordinary of [["projects"], [".config"], [".local", "share"], ["Library", "Application Support"], ["AppData", "Local"]]) {
        expect(read.denyRead).not.toContain(join(homedir(), ...ordinary));
      }
    });
  });

  it("projects subscription runtime state into both OS deny floors for a custom profile", () => {
    const profile = join(tmpdir(), "ave-subscription-custom-profile");
    mkdirSync(join(profile, "subscription-runtimes"), { recursive: true });
    vi.stubEnv("AVE_HOME", profile);
    try {
      const runtime = join(profile, "subscription-runtimes") + (process.platform === "win32" ? sep : "");
      expect(getDefaultSensitiveReadDenyPaths()).toContain(runtime);
      expect(getDefaultSensitiveWriteDenyPaths()).toContain(runtime);
      const config = buildSandboxConfig({ allowedDomains: [], denyRead: [], denyWrite: [] });
      expect(bare(config.filesystem.denyRead)).toContain(bare([runtime])[0]);
      expect(bare(config.filesystem.denyWrite)).toContain(bare([runtime])[0]);
      expect(config.filesystem.denyRead).not.toContain(profile);
      expect(config.filesystem.denyWrite).not.toContain(profile);
    } finally {
      vi.unstubAllEnvs();
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("FIX 1 — Linux XDG_CONFIG_HOME: when set, userData base uses $XDG_CONFIG_HOME not ~/.config", () => {
    // This test only exercises the XDG path on Linux (the env var is harmless on other platforms since darwin/win32 branches never read it).
    if (process.platform !== "linux") return;
    const home = homedir();
    const fakeXdg = join(tmpdir(), "fake-xdg-config-home");
    const prevXdg = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = fakeXdg;
      const paths = getDefaultSensitiveReadDenyPaths();
      // Must deny the XDG-resolved path.
      expect(paths).toContain(join(fakeXdg, "Ave"));
      // Must NOT deny the default ~/.config/Ave when XDG is overridden (belt-and-suspenders is the caller's choice; this SOT mirrors Electron).
      expect(paths).not.toContain(join(home, ".config", "Ave"));
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = prevXdg;
    }
  });

  it("FIX 2 — userDataDir param: exact path is denied when provided (handles --user-data-dir)", () => {
    const customUserData = join(tmpdir(), "custom-electron-userData-for-test");
    const expected = customUserData + (process.platform === "win32" ? sep : "");
    const paths = getDefaultSensitiveReadDenyPaths(customUserData);
    // The exact provided path must be denied.
    expect(paths).toContain(expected);
    // No duplicates.
    expect(new Set(paths).size).toBe(paths.length);
    // Over-deny safety: the derived fallback is NOT additionally added when the exact path is provided (the dedup set handles this if they collide, but the function uses the provided value exclusively for the userData slot). Verify the provided path is present exactly once.
    expect(paths.filter((p) => p === expected).length).toBe(1);
  });

  it("FIX 2 — userDataDir absent: falls back to per-platform derived path (no electron import)", () => {
    const home = homedir();
    const paths = getDefaultSensitiveReadDenyPaths(); // no arg → fallback
    const xdgBase = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
    const fallback =
      process.platform === "darwin"
        ? join(home, "Library", "Application Support", "Ave")
        : process.platform === "win32"
          ? join(home, "AppData", "Roaming", "Ave") + sep
          : join(xdgBase, "Ave");
    expect(paths).toContain(fallback);
  });

  it("FIX 2 — buildSandboxConfig threads userDataDir into deny-list", () => {
    const customUserData = join(tmpdir(), "threaded-userData-deny-test");
    mkdirSync(customUserData, { recursive: true });
    const config = buildSandboxConfig({
      allowedDomains: [],
      userDataDir: customUserData,
    });
    expect(bare(config.filesystem.denyRead)).toContain(customUserData);
    rmSync(customUserData, { recursive: true, force: true });
  });

  it("buildSandboxConfig unions the sensitive deny-list into filesystem.denyRead", () => {
    const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true });
    const sensitive = getDefaultSensitiveReadDenyPaths();
    const privateRoots = appOwnedSandboxPrivateRoots();
    for (const p of sensitive) {
      // On macOS the sandbox private roots reach ASRT as exact globs, which it re-emits after the allows minus a wrap's own directory under them.
      const spelled = process.platform === "darwin" && privateRoots.includes(p) ? `${p.slice(0, -1)}[${p.slice(-1)}]` : p;
      if (reachesAsrt(p)) expect(bare(config.filesystem.denyRead)).toContain(bare([spelled])[0]);
    }
    // Secrets is part of the floor (the prior single-entry deny is subsumed).
    expect(bare(config.filesystem.denyRead)).toContain(join(FAKE_AVE_HOME, "secrets"));
  });

  it("buildSandboxConfig keeps a caller-supplied denyRead AND adds the sensitive floor (union, deduped)", () => {
    const extra = join(tmpdir(), "caller-supplied-deny-xyz");
    writeFileSync(extra, "fixture");
    const config = buildSandboxConfig({ allowedDomains: [], denyRead: [extra] });
    // Caller entry survives.
    expect(bare(config.filesystem.denyRead)).toContain(extra);
    // Sensitive floor is still present.
    expect(bare(config.filesystem.denyRead)).toContain(join(FAKE_AVE_HOME, "secrets"));
    // Passing a path already on the floor does not duplicate it.
    const dupConfig = buildSandboxConfig({
      allowedDomains: [],
      denyRead: [join(FAKE_AVE_HOME, "secrets") + (process.platform === "win32" ? sep : "")],
    });
    const occurrences = bare(dupConfig.filesystem.denyRead).filter(
      (p) => p === join(FAKE_AVE_HOME, "secrets"),
    ).length;
    expect(occurrences).toBe(1);
    rmSync(extra);
  });

  it("buildSandboxConfig unions the sensitive write deny-list into filesystem.denyWrite", () => {
    const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true });
    const sensitive = getDefaultSensitiveWriteDenyPaths();
    for (const p of sensitive) {
      if (reachesAsrt(p)) expect(bare(config.filesystem.denyWrite)).toContain(bare([p])[0]);
    }
    if (reachesAsrt(join(homedir(), ".config"))) {
      expect(bare(config.filesystem.denyWrite)).toContain(join(homedir(), ".config"));
      expect(bare(config.filesystem.denyWrite)).toContain(join(homedir(), ".ssh"));
    }
  });

  it("buildSandboxConfig keeps caller-supplied denyWrite AND adds the sensitive write floor", () => {
    const extra = join(tmpdir(), "caller-supplied-write-deny-xyz");
    writeFileSync(extra, "fixture");
    const config = buildSandboxConfig({ allowedDomains: [], denyWrite: [extra] });
    expect(bare(config.filesystem.denyWrite)).toContain(extra);
    if (reachesAsrt(join(homedir(), ".config"))) {
      expect(bare(config.filesystem.denyWrite)).toContain(join(homedir(), ".config"));
    }

    const dup = join(homedir(), ".config");
    const dupConfig = buildSandboxConfig({ allowedDomains: [], denyWrite: [dup] });
    expect(bare(dupConfig.filesystem.denyWrite).filter((p) => p === dup)).toHaveLength(reachesAsrt(dup) ? 1 : 0);
    rmSync(extra);
  });

  it("Windows: directory denies reach srt-win as directories, and POSIX rows do not reach it", () => {
    const prevTestHome = process.env.AVE_ASRT_TEST_HOME;
    process.env.AVE_ASRT_TEST_HOME = join(tmpdir(), "ave-windeny-profile");
    setProcessPlatform("win32");
    try {
      const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true });
      const denyWrite = config.filesystem.denyWrite.map(entry => typeof entry === "string" ? entry : entry.path);
      // A missing target is created by `srt-win acl stamp`: a trailing separator makes it a directory instead of a 0-byte file. The floor appends the host separator (a backslash on a real Windows host).
      expect(denyWrite).toContain(`${join(FAKE_AVE_HOME, "keys")}${sep}`);
      expect(denyWrite).toContain(join(FAKE_AVE_HOME, "settings.json"));
      // `/etc/shadow` would become `<drive>:\etc\shadow`.
      expect(denyWrite).not.toContain("/etc/shadow");
      expect(bare(config.filesystem.denyRead)).not.toContain("/etc/shadow");
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (prevTestHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = prevTestHome;
    }
  });

  it.each(["linux", "darwin", "win32"] as const)("Windows: profile read denies retain exposed targets and evidence failures on a captured %s host", async host => {
    vi.resetModules();
    const resources = await import("../../main/host-resources.js");
    resources.configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    setProcessPlatform(host);
    const sandbox = await import("../asrt-sandbox.js");
    const previousHome = process.env.AVE_ASRT_TEST_HOME;
    const profile = join(tmpdir(), "ave-deny-evidence-profile");
    process.env.AVE_ASRT_TEST_HOME = profile;
    setProcessPlatform("win32");
    try {
      const exposed = join(profile, ".ssh", "id_ed25519");
      const privateFile = join(profile, "private-file");
      const missing = join(profile, "missing-file");
      const failed = join(profile, ".ssh", "failed-file");
      mkdirSync(join(profile, ".ssh"), { recursive: true });
      for (const target of [exposed, privateFile, failed]) writeFileSync(target, "fixture");
      const evidence = new Map<string, WindowsReadDenyEvidence>([
        [exposed.toLowerCase(), { status: "readable", principals: ["Everyone"] } as const],
        [privateFile.toLowerCase(), { status: "private" } as const],
        [missing.toLowerCase(), { status: "missing" } as const],
        [failed.toLowerCase(), { status: "error", reason: "Access denied" } as const],
      ]);
      const facts = await import("../../shared/windows-path-facts.js");
      const reader = await import("../../shared/windows-read-deny-evidence.js");
      // A captured POSIX host consumes checked evidence without calling the native helper.
      // Supply native-shaped pins locally so the identity-less snapshot is actually rejected first.
      const pin = vi.spyOn(facts, "pinWindowsPaths").mockImplementation(paths => paths.map(path => ({
        exists: true, canonical: path, volumeSerial: "0x0000000000000001", fileId: "0x00000000000000000000000000000001",
        volumeSerialNumber: "0x0000000000000001", fileIndex: "0x0000000000000001", changeTime: "0x0000000000000001",
        attributes: 0, reparseTag: 0, directory: false, reparseTarget: null, ancestors: [],
      })));
      let checked: ReturnType<typeof reader.recheckWindowsReadDenyEvidence>;
      try { checked = reader.recheckWindowsReadDenyEvidence([exposed, privateFile, missing, failed], evidence); }
      finally { pin.mockRestore(); }
      expect(checked.get(windowsReadDenyKey(privateFile))).toEqual({ status: "error", reason: "DACL snapshot target identity is unproven" });
      const config = sandbox.buildSandboxConfig({ denyRead: [exposed, privateFile, missing, failed] }, checked);
      const denies = bare(config.filesystem.denyRead);
      expect(denies).toContain(exposed);
      // A private snapshot without an object identity is still unproven.
      expect(denies).toContain(privateFile);
      expect(denies).not.toContain(missing);
      expect(denies).toContain(failed);
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (previousHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = previousHome;
      rmSync(profile, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it("Windows: profile read denies retain reparse targets in command overrides", () => {
    const previousHome = process.env.AVE_ASRT_TEST_HOME;
    const profile = join(tmpdir(), "ave-deny-evidence-profile");
    process.env.AVE_ASRT_TEST_HOME = profile;
    setProcessPlatform("win32");
    try {
      const target = join(profile, ".ssh", "linked-secret");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "fixture");
      const config = buildPerCommandSandboxCustomConfig({ denyRead: [target] }, undefined, undefined,
        new Map([[target.toLowerCase(), { status: "reparse" } as const]]));
      expect(bare(config?.filesystem?.denyRead ?? [])).toContain(target);
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (previousHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = previousHome;
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("Windows: profile read denies retain a failed DACL query", () => {
    const previousHome = process.env.AVE_ASRT_TEST_HOME;
    const profile = join(tmpdir(), "ave-deny-evidence-profile");
    process.env.AVE_ASRT_TEST_HOME = profile;
    setProcessPlatform("win32");
    try {
      const target = join(profile, ".ssh", "unreadable-secret");
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, "fixture");
      const config = buildSandboxConfig({ denyRead: [target] },
        new Map([[target.toLowerCase(), { status: "error", reason: "Access denied" } as const]]));
      expect(bare(config.filesystem.denyRead)).toContain(target);
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (previousHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = previousHome;
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("Windows: readable profile-root-parent denies are filtered", () => {
    const profile = mkdtempSync(join(tmpdir(), "ave-readable-profile-"));
    const home = vi.spyOn(os, "homedir").mockReturnValue(profile);
    const user = vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: profile });
    setProcessPlatform("win32");
    try {
      const target = join(profile, ".ssh");
      writeFileSync(target, "fixture");
      const stat = lstatSync(target, { bigint: true });
      const config = buildSandboxConfig({ denyRead: [target] },
        new Map([[windowsReadDenyKey(target), { status: "readable", principals: ["Everyone"],
          identity: { volumeSerialNumber: stat.dev.toString(), fileId: stat.ino.toString() } } as const]]));
      expect(bare(config.filesystem.denyRead)).not.toContain(target);
      expect(getWindowsProfileReadDenyWarnings()).toContainEqual({ path: target, principals: ["Everyone"] });
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      home.mockRestore();
      user.mockRestore();
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("Windows: unproven profile-root-parent denies are filtered", () => {
    const profile = join(tmpdir(), "ave-unverified-profile");
    const home = vi.spyOn(os, "homedir").mockReturnValue(profile);
    const user = vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: profile });
    setProcessPlatform("win32");
    try {
      const target = join(profile, ".ssh");
      const config = buildSandboxConfig({ denyRead: [target] },
        new Map([[windowsReadDenyKey(target), { status: "error", reason: "Query timed out" } as const]]));
      expect(bare(config.filesystem.denyRead)).not.toContain(target);
      expect(getWindowsProfileReadDenyWarnings()).toContainEqual({ path: target });
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      home.mockRestore();
      user.mockRestore();
    }
  });

  it("Windows: missing profile denies stay protected when overlapping a write grant", () => {
    const prevTestHome = process.env.AVE_ASRT_TEST_HOME;
    const profile = join(tmpdir(), "ave-windeny-profile");
    process.env.AVE_ASRT_TEST_HOME = profile;
    setProcessPlatform("win32");
    try {
      const work = join(profile, "work");
      const config = buildSandboxConfig({
        allowedDomains: [],
        strictAllowlist: true,
        allowWrite: [work],
        denyWrite: [join(work, "locked")],
      });
      const denies = [...config.filesystem.denyRead, ...config.filesystem.denyWrite].map(entry => typeof entry === "string" ? entry : entry.path);
      // Under the grant: kept, the sandbox user could otherwise reach it.
      expect(denies).toContain(join(work, "locked"));
      // Missing disjoint rows would create placeholders and stamp the profile itself as the parent.
      expect(denies.filter((p) => p.startsWith(profile) && !p.startsWith(work))).toEqual([]);
      // Outside the profile: kept.
      expect(denies).toContain(join(FAKE_AVE_HOME, "settings.json"));
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (prevTestHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = prevTestHome;
    }
  });

  it("Windows: a drive-root profile prunes no deny", () => {
    const prevTestHome = process.env.AVE_ASRT_TEST_HOME;
    // USERPROFILE=`C:\` is not a home: every deny on the drive would look like a profile row disjoint from the grants.
    const driveRoot = ORIGINAL_PLATFORM_FOR_DENY_TEST === "win32" ? parse(tmpdir()).root : "/";
    process.env.AVE_ASRT_TEST_HOME = driveRoot;
    setProcessPlatform("win32");
    try {
      const locked = join(tmpdir(), "ave-root-profile-deny", "locked");
      mkdirSync(dirname(locked), { recursive: true });
      writeFileSync(locked, "fixture");
      const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true, denyWrite: [locked] });
      expect(bare(config.filesystem.denyWrite)).toContain(locked);
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (prevTestHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = prevTestHome;
      rmSync(join(tmpdir(), "ave-root-profile-deny"), { recursive: true, force: true });
    }
  });

  // Native Windows spelling needs the host's canonical path resolver.
  it.runIf(ORIGINAL_PLATFORM_FOR_DENY_TEST === "win32").each([
    ["equal paths", "C:\\Users\\tester", "C:\\Users\\tester\\work\\", "C:\\Users\\tester\\work", true],
    ["ancestor denies", "C:\\Users\\tester", "C:\\Users\\tester\\.config\\project", "C:\\Users\\tester\\.config", true],
    ["extended-length grants", "C:\\Users\\tester", "\\\\?\\C:\\Users\\tester\\work", "C:\\Users\\tester\\work\\locked", true],
    ["extended-length denies", "C:\\Users\\tester", "C:\\Users\\tester\\work", "\\\\?\\C:\\Users\\tester\\work\\locked", true],
    ["case folding", "C:\\Users\\tester", "c:\\users\\TESTER\\WORK", "C:\\Users\\tester\\work\\locked", true],
    ["mixed separators", "C:\\Users\\tester", "C:/Users/tester/work/", "C:\\Users\\tester\\work\\locked", true],
    ["normalized descendants", "C:\\Users\\tester", "C:\\Users\\tester\\work", "C:\\Users\\tester\\work\\nested\\..\\locked", true],
    ["normalized escapes", "C:\\Users\\tester", "C:\\Users\\tester\\work", "C:\\Users\\tester\\work\\..\\locked", false],
    ["sibling boundaries", "C:\\Users\\tester", "C:\\Users\\tester\\work", "C:\\Users\\tester\\work-neighbor\\locked", false],
    ["drive roots", "Z:\\Users\\tester", "Z:\\", "Z:\\Users\\tester\\locked", true],
    ["profile roots", "C:\\Users\\tester", "C:\\Users\\tester\\", "C:\\Users\\tester\\locked", true],
    ["network paths", "\\\\server\\profiles\\tester", "//SERVER/profiles/tester/work/", "\\\\server\\profiles\\tester\\work\\locked", true],
    ["network share boundaries", "\\\\server\\profiles\\tester", "\\\\server\\profiles\\tester\\work", "\\\\server\\profiles\\tester\\work-neighbor\\locked", false],
  ])("Windows: profile deny coverage respects %s", (_name, profile, grant, target, kept) => {
    // This table tests lexical coverage, including spellings native admission deliberately refuses.
    const pin = vi.spyOn(windowsStampTargets, "pinWindowsFilesystemConfig").mockImplementation(filesystem => filesystem === undefined ? filesystem : ({
      ...filesystem,
      ...Object.fromEntries((["allowRead", "allowWrite"] as const).filter(field => filesystem[field] !== undefined)
        .map(field => [field, filesystem[field]!.map(entry => ({ path: normalizePathForSandbox(typeof entry === "string" ? entry : entry.path), literal: true as const }))])),
    }));
    const prevTestHome = process.env.AVE_ASRT_TEST_HOME;
    process.env.AVE_ASRT_TEST_HOME = profile;
    setProcessPlatform("win32");
    const nativeRealpath = realpathSync.native;
    // These synthetic roots exercise path coverage without an installed drive or network share.
    const realpath = vi.spyOn(realpathSync, "native").mockImplementation(((path) => {
      const candidate = resolve(String(path));
      if (/^Z:\\/i.test(candidate) || /^\\\\server\\profiles(?:\\|$)/i.test(candidate)) return candidate;
      return nativeRealpath(path);
    }) as typeof realpathSync.native);
    const nativeLstat = vi.mocked(lstatSync).getMockImplementation()!;
    vi.mocked(lstatSync).mockImplementation(((path, options) => {
      if (/^\\\\server\\profiles(?:\\|$)/i.test(resolve(String(path)))) {
        if (options?.throwIfNoEntry === false) return undefined;
        throw Object.assign(new Error("Synthetic network entry is absent"), { code: "ENOENT" });
      }
      return nativeLstat(path, options);
    }) as typeof lstatSync);
    const currentEvidence = readDenyEvidenceModule.windowsReadDenyEvidence;
    const evidence = vi.spyOn(readDenyEvidenceModule, "windowsReadDenyEvidence").mockImplementation((path, snapshot) =>
      /^\\\\server\\profiles\\tester(?:\\|$)/i.test(path) ? { status: "missing" } : currentEvidence(path, snapshot));
    try {
      const config = buildSandboxConfig({
        allowedDomains: [],
        // Synthetic network reads exercise coverage without filesystem write discovery.
        ...(/^[/\\]{2}server[/\\]/i.test(grant) ? { allowRead: [grant] } : { allowWrite: [grant] }),
        denyRead: [target],
        denyWrite: [target],
      }, new Map([[windowsReadDenyKey(target), { status: "missing" } as const]]));
      expect(bare(config.filesystem.denyRead).includes(target)).toBe(kept);
      expect(bare(config.filesystem.denyWrite).includes(target)).toBe(kept);
    } finally {
      pin.mockRestore();
      vi.mocked(lstatSync).mockImplementation(nativeLstat);
      realpath.mockRestore();
      evidence.mockRestore();
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (prevTestHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = prevTestHome;
    }
  });

  it.each([
    ["equal paths", "work", "work", true],
    ["ancestor denies", ".config/project", ".config", true],
    ["descendant denies", "work", "work/locked", true],
    ["normalized descendants", "work", "work/nested/../locked", true],
    ["normalized escapes", "work", "work/../locked", false],
    ["sibling boundaries", "work", "work-neighbor/locked", false],
    ["unresolved patterns", "work", "other/*", true],
    ["unresolved short names", "work", "OTHER~1/locked", false],
    ["unresolved grant patterns", "work/*", "other/locked", false],
  ] as const)("Windows: native profile deny coverage respects %s", (_name, grantSuffix, targetSuffix, kept) => {
    const prevTestHome = process.env.AVE_ASRT_TEST_HOME;
    const profile = join(tmpdir(), "ave-windeny-profile");
    process.env.AVE_ASRT_TEST_HOME = profile;
    setProcessPlatform("win32");
    try {
      const target = join(profile, ...targetSuffix.split("/"));
      if (!/[*~]/.test(targetSuffix)) mkdirSync(target, { recursive: true });
      const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });
      const snapshot = new Map<string, WindowsReadDenyEvidence>([[windowsReadDenyKey(target), stat === undefined
        ? { status: "missing" }
        : { status: "private", identity: { volumeSerialNumber: stat.dev.toString(), fileId: stat.ino.toString() } }]]);
      const config = buildSandboxConfig({
        allowedDomains: [],
        allowWrite: [join(profile, ...grantSuffix.split("/"))],
        denyRead: [target],
        denyWrite: [target],
      }, snapshot);
      expect(bare(config.filesystem.denyRead).includes(target)).toBe(kept);
      expect(bare(config.filesystem.denyWrite).includes(target)).toBe(kept);
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (prevTestHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = prevTestHome;
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it.each(["~/.config/project", "~\\.config\\project"])("Windows: expanded home grant %s keeps the parent deny", (grant) => {
    const prevTestHome = process.env.AVE_ASRT_TEST_HOME;
    const profile = join(tmpdir(), "ave-windeny-profile");
    process.env.AVE_ASRT_TEST_HOME = profile;
    vi.stubEnv("USERPROFILE", profile);
    vi.stubEnv("HOME", profile);
    setProcessPlatform("win32");
    try {
      const target = join(profile, ".config");
      mkdirSync(join(target, "project"), { recursive: true });
      for (const access of ["allowRead", "allowWrite"] as const) {
        const config = buildSandboxConfig({
          allowedDomains: [],
          [access]: [grant],
          denyRead: [target],
        });
        expect(bare(config.filesystem.denyRead), access).toContain(target);
        expect(bare(config.filesystem.denyWrite), access).toContain(target);
      }
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (prevTestHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = prevTestHome;
      vi.unstubAllEnvs();
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it.runIf(ORIGINAL_PLATFORM_FOR_DENY_TEST === "win32").each(["~/x", "%USERPROFILE%\\x"])("Windows: expanded write grant %s protects home controls", (grant) => {
    const profile = homedir();
    vi.stubEnv("USERPROFILE", profile);
    vi.stubEnv("HOME", profile);
    try {
      const root = join(profile, "x");
      mkdirSync(root, { recursive: true });
      const configs = [
        buildSandboxConfig({ windows: { externalConfinement: true }, allowWrite: [grant], allowRead: [grant] }).filesystem,
        buildPerCommandSandboxCustomConfig({ allowWrite: [grant], allowRead: [grant] })!.filesystem!,
      ];
      expect(bare(configs[0]!.allowWrite)).toEqual([root]);
      // Per-command Windows policies restate denies without issuing additional write grants.
      expect(bare(configs[1]!.allowWrite)).toEqual([]);
      for (const config of configs) {
        expect(bare(config.allowRead ?? []).map(path => resolve(path))).toEqual([root]);
        const denies = bare(config.denyWrite ?? []);
        expect(denies).toContain(join(root, ".bashrc"));
        expect(denies).not.toContain(join(grant, ".bashrc"));
        expect(denies).not.toContain(resolve(grant, ".bashrc"));
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.runIf(ORIGINAL_PLATFORM_FOR_DENY_TEST === "win32").each(["~", "%USERPROFILE%"])("Windows: a whole-home write grant %s is refused before narrowing", (grant) => {
    const profile = homedir();
    vi.stubEnv("USERPROFILE", profile);
    vi.stubEnv("HOME", profile);
    vi.stubEnv("ProgramData", join(profile, "machine-root"));
    try {
      expect(() => buildSandboxConfig({ windows: { externalConfinement: true }, allowWrite: [grant] }))
        .toThrow(/Windows write grant .* contains machine root/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.runIf(ORIGINAL_PLATFORM_FOR_DENY_TEST === "win32").each(["allowRead", "allowWrite"] as const)("Windows: expanded %s cannot overlap a private helper image", (access) => {
    buildSandboxConfig({});
    const directory = srtWinPrivateDirectories()[0]!;
    const profile = dirname(directory);
    const home = vi.spyOn(os, "homedir").mockReturnValue(profile);
    vi.stubEnv("USERPROFILE", profile);
    vi.stubEnv("HOME", profile);
    try {
      expect(() => buildSandboxConfig({ [access]: [`~/${basename(directory)}`] }))
        .toThrow("Windows filesystem grant overlaps a private helper image");
    } finally {
      home.mockRestore();
      vi.unstubAllEnvs();
      // Native setup may create these empty directories under the fixture profile.
      for (const path of [join(profile, "AppData", "Roaming"), join(profile, "AppData")]) {
        if (existsSync(path)) rmdirSync(path);
      }
    }
  });

  it("Windows: an unproven canonical identity keeps the deny", () => {
    const prevTestHome = process.env.AVE_ASRT_TEST_HOME;
    const profile = join(tmpdir(), "ave-windeny-profile");
    const target = join(profile, "locked");
    mkdirSync(target, { recursive: true });
    const canonicalize = sensitivePaths.canonicalizePathForMatch;
    const spy = vi.spyOn(sensitivePaths, "canonicalizePathForMatch").mockImplementation((path) => {
      if (path === target) throw new Error("Path identity unavailable");
      return canonicalize(path);
    });
    process.env.AVE_ASRT_TEST_HOME = profile;
    setProcessPlatform("win32");
    try {
      const config = buildSandboxConfig({ allowedDomains: [], denyRead: [target], denyWrite: [target] });
      expect(bare(config.filesystem.denyRead)).toContain(target);
      expect(bare(config.filesystem.denyWrite)).toContain(target);
    } finally {
      spy.mockRestore();
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (prevTestHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = prevTestHome;
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("Windows: a write grant below the profile write floor preserves the parent deny", () => {
    const prevTestHome = process.env.AVE_ASRT_TEST_HOME;
    const profile = join(tmpdir(), "ave-windeny-profile");
    process.env.AVE_ASRT_TEST_HOME = profile;
    setProcessPlatform("win32");
    try {
      const configRoot = join(profile, ".config");
      const project = join(configRoot, "project");
      mkdirSync(project, { recursive: true });
      const config = buildSandboxConfig({
        allowedDomains: [],
        allowWrite: [project],
      });
      expect(bare(config.filesystem.denyWrite).map(path => resolve(path))).toContain(resolve(configRoot));
      expect(bare(config.filesystem.denyWrite)).not.toContain(join(profile, ".ssh"));
      const ranked = rankWindowsFsAccess({
        allowRead: [],
        allowWrite: [project],
        denyRead: [],
        denyWrite: bare(config.filesystem.denyWrite),
        credentialDeny: [],
      });
      expect(ranked.grantWrite).not.toContain(project);
      expect(ranked.grantRead).toContain(project);
    } finally {
      setProcessPlatform(ORIGINAL_PLATFORM_FOR_DENY_TEST);
      if (prevTestHome === undefined) delete process.env.AVE_ASRT_TEST_HOME;
      else process.env.AVE_ASRT_TEST_HOME = prevTestHome;
      rmSync(profile, { recursive: true, force: true });
    }
  });

  it("default-OFF: computing the deny-list / config does NOT activate the sandbox gate", () => {
    // Pure functions — no side effect on the boot-time spawn gate.
    expect(isAsrtSandboxActive()).toBe(false);
    getDefaultSensitiveReadDenyPaths();
    buildSandboxConfig({ allowedDomains: [] });
    expect(isAsrtSandboxActive()).toBe(false);
  });

  it("does not put plugin worker data roots into the shared sandbox config", () => {
    const data = join(FAKE_AVE_HOME, "plugins", "local-indexer", "data");
    const cfg = buildSandboxConfig({
      allowedDomains: [],
      allowRead: [join(FAKE_AVE_HOME, "notes")],
      allowWrite: [join(FAKE_AVE_HOME, "tasks")],
    });

    expect(cfg.filesystem.allowRead ?? []).not.toContain(data);
    expect(cfg.filesystem.allowWrite ?? []).not.toContain(data);
  });
});

describe("asrt-sandbox — worker-UDS shared-config emission (worker-confinement PR D-1)", () => {
  it("buildSandboxConfig emits network.allowUnixSockets from allowUnixSocketDirs", () => {
    const cfg = buildSandboxConfig({
      allowedDomains: [],
      strictAllowlist: true,
      allowUnixSocketDirs: ["/run/a", "/run/b"],
    });
    expect(cfg.network.allowUnixSockets).toEqual(["/run/a", "/run/b"]);
  });

  it("buildSandboxConfig omits allowUnixSockets when no dirs are supplied (default shape unchanged)", () => {
    const cfg = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true });
    expect(cfg.network.allowUnixSockets).toBeUndefined();
  });
});

describe("asrt-sandbox — worker-UDS register/unregister (shared-config, not per-command)", () => {
  const predecessor = {};
  const candidate = {};

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "a failed first push cannot leak through another directory's concurrent push",
    async (context) => {
      if (!(await asrtCanInitialize())) return context.skip();
      const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const originalUpdate = SandboxManager.updateConfig.bind(SandboxManager);
      const update = vi.spyOn(SandboxManager, "updateConfig");
      let pushes = 0;
      update.mockImplementation((config) => {
        pushes += 1;
        if (pushes === 2) throw new Error("push refused");
        originalUpdate(config);
      });
      try {
        const outcomes = await Promise.allSettled([
          registerWorkerUnixSocketDir("/run/plugin-q/sockets", predecessor),
          registerWorkerUnixSocketDir("/run/plugin-r/sockets", candidate),
        ]);
        expect(pushes).toBe(2);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(["fulfilled", "rejected"]);
        expect(SandboxManager.getConfig()?.network.allowUnixSockets).toContain("/run/plugin-q/sockets");
        expect(SandboxManager.getConfig()?.network.allowUnixSockets).not.toContain("/run/plugin-r/sockets");
      } finally {
        update.mockRestore();
        await resetAsrtSandbox();
      }
    }, 60_000,
  );

  it("registerWorkerUnixSocketDir throws when the sandbox is not active (self-enforcing gate)", async () => {
    await expect(registerWorkerUnixSocketDir("/run/x", predecessor)).rejects.toThrow(/not active/);
  });

  it("unregisterWorkerUnixSocketDir is a no-op (does not throw) when the sandbox is not active", async () => {
    await expect(unregisterWorkerUnixSocketDir("/run/x", predecessor)).resolves.toBeUndefined();
  });

  it("register/unregister round-trip on a LIVE sandbox keeps the config consistent (idempotent)", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    if (!(await asrtCanInitialize())) return;

    await initializeAsrtSandbox({ allowedDomains: ["example.com"], strictAllowlist: true });
    // First register pushes the dir; a second holder of it only adds a holder.
    await registerWorkerUnixSocketDir("/run/worker-a", predecessor);
    await registerWorkerUnixSocketDir("/run/worker-a", candidate);
    // Unregister of an unknown dir is a no-op; each holder releases once.
    await unregisterWorkerUnixSocketDir("/run/unknown", predecessor);
    await unregisterWorkerUnixSocketDir("/run/worker-a", predecessor);
    await unregisterWorkerUnixSocketDir("/run/worker-a", candidate);
    // Reset clears the live worker set so the next init starts clean.
    await resetAsrtSandbox();
    // After teardown a register must throw again (no stale base settings).
    await expect(registerWorkerUnixSocketDir("/run/worker-a", predecessor)).rejects.toThrow(/not active/);
  }, 60_000);

  // A plugin's `sockets/` and `run/` are per plugin, so during an update or a restart the candidate child registers the directories its predecessor still holds, and the predecessor retires first. Its release must not take the allow away from the candidate: every child wrapped afterwards (the candidate's own workers, started from onPublished) is generated from the shared config at that moment.
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "keeps a directory allowed until its LAST holder releases it",
    async (context) => {
    if (!(await asrtCanInitialize())) return context.skip();
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const allowed = (): readonly string[] => SandboxManager.getConfig()?.network.allowUnixSockets ?? [];

    await initializeAsrtSandbox({ allowedDomains: ["example.com"], strictAllowlist: true });
    try {
      await registerWorkerUnixSocketDir("/run/plugin-x/sockets", predecessor); // predecessor
      await registerWorkerUnixSocketDir("/run/plugin-x/sockets", candidate); // candidate
      expect(allowed()).toContain("/run/plugin-x/sockets");

      await unregisterWorkerUnixSocketDir("/run/plugin-x/sockets", predecessor); // predecessor retires
      expect(allowed()).toContain("/run/plugin-x/sockets");

      await unregisterWorkerUnixSocketDir("/run/plugin-x/sockets", candidate); // candidate exits
      expect(allowed()).not.toContain("/run/plugin-x/sockets");
    } finally {
      await resetAsrtSandbox();
    }
  }, 60_000);

  // Two holders arriving together: the second must not resolve — and go on to wrap a child — before the first holder's push has landed.
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "resolves a concurrent second holder only after the first push has landed",
    async (context) => {
      if (!(await asrtCanInitialize())) return context.skip();
      const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
      const allowed = (): readonly string[] => SandboxManager.getConfig()?.network.allowUnixSockets ?? [];

      await initializeAsrtSandbox({ allowedDomains: ["example.com"], strictAllowlist: true });
      try {
        const first = registerWorkerUnixSocketDir("/run/plugin-y/sockets", predecessor);
        let allowedWhenSecondResolved: readonly string[] | undefined;
        const second = registerWorkerUnixSocketDir("/run/plugin-y/sockets", candidate)
          .then(() => { allowedWhenSecondResolved = allowed(); });
        await Promise.all([first, second]);
        expect(allowedWhenSecondResolved).toContain("/run/plugin-y/sockets");
      } finally {
        await resetAsrtSandbox();
      }
    },
    60_000,
  );

  // The first push failing: every concurrent holder fails with it and the count is rolled back whole, so the next holder pushes again rather than joining an entry whose dir was never pushed.
  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "fails every concurrent holder of a failed first push and rolls the count back whole",
    async (context) => {
      if (!(await asrtCanInitialize())) return context.skip();
      const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
      const allowed = (): readonly string[] => SandboxManager.getConfig()?.network.allowUnixSockets ?? [];

      await initializeAsrtSandbox({ allowedDomains: ["example.com"], strictAllowlist: true });
      const update = vi.spyOn(SandboxManager, "updateConfig");
      try {
        update.mockImplementationOnce(() => { throw new Error("push refused"); });
        const outcomes = await Promise.allSettled([
          registerWorkerUnixSocketDir("/run/plugin-z/sockets", predecessor),
          registerWorkerUnixSocketDir("/run/plugin-z/sockets", candidate),
        ]);
        expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
        expect(allowed()).not.toContain("/run/plugin-z/sockets");

        await registerWorkerUnixSocketDir("/run/plugin-z/sockets", predecessor);
        expect(allowed()).toContain("/run/plugin-z/sockets");
        await unregisterWorkerUnixSocketDir("/run/plugin-z/sockets", predecessor);
        expect(allowed()).not.toContain("/run/plugin-z/sockets");
      } finally {
        update.mockRestore();
        await resetAsrtSandbox();
      }
    },
    60_000,
  );
});

describe("runtime write defaults", () => {
  it("grants only device defaults before caller policy is applied", () => {
    expect(getDefaultWritePaths()).toEqual([
      "/dev/stdout", "/dev/stderr", "/dev/null", "/dev/tty", "/dev/dtracehelper", "/dev/autofs_nowait",
    ]);
    expect(buildSandboxConfig({ allowWrite: [] }).filesystem.allowWrite).toEqual([]);
  });

  it("does not add compensating denies for paths without an implicit grant", () => {
    const floor = getDefaultSensitiveWriteDenyPaths();
    for (const target of ["/tmp/claude", "/private/tmp/claude", join(homedir(), ".npm", "_logs"), join(homedir(), ".claude", "debug")]) {
      expect(floor).not.toContain(target);
    }
  });
});

describe.runIf(process.platform === "linux")("ordinary temporary write policy", () => {
  it("retains an explicitly granted temp directory for the host and later commands", async (context) => {
    if (!(await asrtCanInitialize())) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
      return context.skip();
    }
    const root = mkdtempSync("/tmp/ave-ordinary-temp-");
    try {
      await initializeAsrtSandbox({ allowedDomains: [], allowWrite: ["/tmp", root] });
      const target = join(root, "shared.txt");
      const first = await wrapToolCommand(`printf shared > ${shellQuote(target)}`, { commandId: TEST_COMMAND_ID });
      expect(first.argv[1]).toBe("-c");
      expect(/--tmpfs'?\s+'?\/tmp\/claude(?:'|\s|$)/u.test(first.argv[2] ?? "")).toBe(false);
      const written = await runArgv(first.argv, first.env, process.cwd());
      cleanupAsrtSandboxAfterCommand();
      expect(written.code, written.stderr).toBe(0);
      expect(readFileSync(target, "utf8")).toBe("shared");
      const next = await wrapToolCommand(`cat ${shellQuote(target)}`, { commandId: TEST_COMMAND_ID });
      const read = await runArgv(next.argv, next.env, process.cwd());
      cleanupAsrtSandboxAfterCommand();
      expect(read.code, read.stderr).toBe(0);
      expect(read.stdout).toBe("shared");
    } finally {
      await cleanupTmpDir(root);
    }
  });
});

describe("Windows inherited profile read grant", () => {
  it.each(["granted", "absent", undefined] as const)("checks %s before publishing confinement", async (state) => {
    await resetAsrtSandbox();
    const original = process.platform;
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const integrity = await import("../srt-win-integrity.js");
    const initialized = vi.spyOn(SandboxManager, "initialize").mockResolvedValue(undefined);
    const reset = vi.spyOn(SandboxManager, "reset").mockResolvedValue(undefined);
    const read = vi.spyOn(SandboxManager, "getWindowsProfileRead").mockReturnValue(state);
    vi.spyOn(integrity, "prepareSrtWinExecutable").mockImplementation(path => path);
    setProcessPlatform("win32");
    try {
      const result = initializeAsrtSandbox({ allowedDomains: [] });
      if (state === "absent") {
        await result;
        expect(isAsrtSandboxActive()).toBe(true);
      } else {
        await expect(result).rejects.toThrow(state === "granted" ? /srt-win profile forget/ : /did not report/);
        if (state === "granted") await expect(result).rejects.toMatchObject({ name: "WindowsProfileReadError", code: "srt-win-profile-read-granted" });
        expect(isAsrtSandboxActive()).toBe(false);
        expect(reset).toHaveBeenCalledOnce();
      }
      expect(initialized).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledOnce();
      expect(initialized.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]);
    } finally {
      await resetAsrtSandbox();
      setProcessPlatform(original);
      vi.restoreAllMocks();
    }
  });
});
