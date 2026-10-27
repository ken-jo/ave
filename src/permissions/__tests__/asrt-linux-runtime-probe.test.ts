// Publish an active adapter only after its initialized wrapper runs a fixed no-I/O probe; wrap, timeout or cleanup failures reset it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import * as globMatcher from "../../lib/glob-matcher.js";
import { globMatch } from "../../lib/glob-matcher.js";
import { expandLeadingTilde } from "../../shared/home-tilde.js";
import { canonicalizePathForMatch } from "../sensitive-paths.js";
import * as sandboxWritePolicy from "../sandbox-write-policy.js";
import * as bareRepositoryCleanup from "../sandbox-bare-repository-cleanup.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { getLocale, setLocale } from "../../i18n/index.js";
import { isHostGitWorkspaceAvailable } from "../../shared/host-git.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import * as policyHome from "../../shared/policy-home.js";
import { configureHostResources, getHostResources } from "../../main/host-resources.js";

useVerifiedAveHomePrivacy();

// Simulated win32 on a POSIX host: drive-path math, an empty simulated drive, ASRT resolved on it, and spelling-only stamp pins.
vi.mock("node:path", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDrivePath(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDriveFs(await original()));
vi.mock("node:module", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDriveModule(await original()));
vi.mock("../windows-stamp-targets.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedStampTargets(await original()));

const h = vi.hoisted(() => ({
  initialize: vi.fn(),
  openInvocationListener: vi.fn(),
  closeInvocationListener: vi.fn(),
  wrapWithSandboxArgv: vi.fn(),
  cleanupAfterCommand: vi.fn(),
  reset: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("@anthropic-ai/sandbox-runtime", () => ({
  SandboxManager: {
    setParentProxyRouter: () => undefined,
    initialize: h.initialize,
    openInvocationListener: h.openInvocationListener,
    closeInvocationListener: h.closeInvocationListener,
    wrapWithSandboxArgv: h.wrapWithSandboxArgv,
    cleanupAfterCommand: h.cleanupAfterCommand,
    reset: h.reset,
  },
}));

vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: h.spawn,
}));

vi.mock("../srt-win-integrity.js", () => ({
  getSrtWinArchitecture: () => "x64",
  prepareSrtWinExecutable: (source: string) => source,
  srtWinPrivateDirectories: () => [],
}));

import {
  ASRT_LINUX_RUNTIME_PROBE_ERROR_CODE,
  ASRT_MAC_RUNTIME_PROBE_ERROR_CODE,
  appOwnedSandboxPrivateRoots,
  buildPerCommandSandboxCustomConfig,
  getBuiltinShellReadPolicy,
  getBuiltinShellSessionReadPolicy,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  isAsrtMacRuntimeProbeError,
  initializeAsrtSandbox,
  isAsrtLinuxRuntimeProbeError,
  isAsrtSandboxActive,
  resetAsrtSandbox,
  wrapToolCommand,
  wrapWorkerCommand,
} from "../asrt-sandbox.js";

const ORIGINAL_PLATFORM = process.platform;
const originalLocale = getLocale();
const temporaryRoots: string[] = [];
const CONFIGURED_LINUX_BWRAP_COMMAND =
  "/configured/asrt/bwrap --new-session --die-with-parent --unshare-pid --unshare-user --cap-drop ALL --ro-bind / / --proc /proc -- /bin/bash -c true";

interface ProbeChild extends EventEmitter {
  kill: ReturnType<typeof vi.fn>;
}

function childThatCloses(
  code: number | null,
  signal: NodeJS.Signals | null = null,
): ProbeChild {
  const child = new EventEmitter() as ProbeChild;
  child.kill = vi.fn(() => true);
  // Queue after spawn returns so the adapter has registered close/error listeners. Real ChildProcess events are asynchronous too.
  queueMicrotask(() => child.emit("close", code, signal));
  return child;
}

function childThatNeverCloses(): ProbeChild {
  const child = new EventEmitter() as ProbeChild;
  child.kill = vi.fn(() => true);
  return child;
}

function childThatErrors(code: string): ProbeChild {
  const child = new EventEmitter() as ProbeChild;
  child.kill = vi.fn(() => true);
  queueMicrotask(() => {
    child.emit("error", Object.assign(new Error("configured wrapper denied"), { code }));
  });
  return child;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  setLocale("en");
  setProcessPlatform("linux");
  h.initialize.mockResolvedValue(undefined);
  h.openInvocationListener.mockResolvedValue({ port: 12345 });
  h.wrapWithSandboxArgv.mockResolvedValue({
    // This is the exact shape ASRT uses on Linux: its outer shell runs a rendered bwrap command. The adapter hardens its mounts before spawning.
    argv: ["/bin/bash", "-c", CONFIGURED_LINUX_BWRAP_COMMAND],
    env: { ASRT_PROBE_ENV: "configured" },
  });
  h.cleanupAfterCommand.mockImplementation(() => undefined);
  h.reset.mockResolvedValue(undefined);
  h.spawn.mockImplementation(() => childThatCloses(0));
});

afterEach(async () => {
  setLocale(originalLocale);
  vi.useRealTimers();
  if (isAsrtSandboxActive()) {
    await resetAsrtSandbox();
  }
  setProcessPlatform(ORIGINAL_PLATFORM);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  for (const root of temporaryRoots.splice(0)) await cleanupTmpDir(root);
});

describe("Linux wrap filesystem discovery snapshot", () => {
  it("sweeps trusted writable stores reached through a write-denied pointer file", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "asrt-pointer-store-")));
    temporaryRoots.push(base);
    const project = join(base, "project");
    const storage = join(base, "storage");
    const metadata = join(storage, "metadata");
    mkdirSync(project);
    mkdirSync(metadata, { recursive: true });
    const marker = join(project, ".git");
    writeFileSync(marker, `gitdir: ${metadata}\n`);
    writeFileSync(join(metadata, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(metadata, "config"), "[core]\n");
    await initializeAsrtSandbox({ allowedDomains: [] });
    let snapshot: sandboxWritePolicy.SandboxGitControlSnapshot | undefined;
    buildPerCommandSandboxCustomConfig({ allowWrite: [project, storage] }, undefined, value => { snapshot = value; });
    expect(snapshot!.isPathExcluded?.(marker)).toBe(true);
    expect(snapshot!.markerStores.get(marker)).toContain(metadata);
    setProcessPlatform(ORIGINAL_PLATFORM);
    const cleanup = await bareRepositoryCleanup.prepareSandboxBareRepositoryCleanup([project, storage], "pointer-store", snapshot);
    const control = join(metadata, "config.worktree");
    writeFileSync(control, "created during command\n");
    expect(cleanup()).toContain(JSON.stringify(control));
    expect(existsSync(control)).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  // The Linux runtime consumes POSIX glob paths.
  it.skipIf(process.platform === "win32")("compiles exclusion patterns once, so the sweep's cost does not grow per scanned entry", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "asrt-sweep-cost-")));
    temporaryRoots.push(base);
    const project = join(base, "project");
    // 20 x 20 directories within the scan depth: 420 entries the before and after sweeps both visit and test against every exclusion pattern.
    for (let outer = 0; outer < 20; outer += 1) {
      for (let inner = 0; inner < 20; inner += 1) mkdirSync(join(project, `d${outer}`, `e${inner}`), { recursive: true });
    }
    const repository = join(project, "d7", "e3");
    await initializeAsrtSandbox({ allowedDomains: [] });
    let snapshot: sandboxWritePolicy.SandboxGitControlSnapshot | undefined;
    const compile = vi.spyOn(globMatcher, "compileGlobMatcher");
    buildPerCommandSandboxCustomConfig({ allowWrite: [project], denyWrite: [join(base, "elsewhere", "**", "private-*")] }, undefined,
      value => { snapshot = value; });
    expect(snapshot).toBeDefined();
    const compiledAtBuild = compile.mock.calls.length;
    expect(compiledAtBuild).toBeGreaterThan(0);
    setProcessPlatform(ORIGINAL_PLATFORM);
    const match = vi.spyOn(globMatcher, "globMatch");
    const cleanup = await bareRepositoryCleanup.prepareSandboxBareRepositoryCleanup([project], "sweep-cost", snapshot);
    mkdirSync(join(repository, ".git", "hooks"), { recursive: true });
    writeFileSync(join(repository, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(repository, ".git", "hooks", "pre-commit"), "created during command\n");
    const notice = cleanup();
    // The new control is still found and quarantined.
    expect(notice).toContain(JSON.stringify(join(repository, ".git")));
    expect(existsSync(join(repository, ".git", "hooks", "pre-commit"))).toBe(false);
    // Neither sweep compiled a pattern again: the per-entry checks reuse the patterns compiled with the policy, however many entries were scanned.
    expect(compile.mock.calls.length).toBe(compiledAtBuild);
    expect(match).not.toHaveBeenCalled();
  });

  it.each(["with\\backslash", "e\u0301"])("keeps physical spelling when excluding nested metadata: %s", async spelling => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "asrt-physical-exclusion-")));
    temporaryRoots.push(base);
    const root = join(base, spelling);
    const hidden = join(root, "private");
    mkdirSync(hidden, { recursive: true });
    await initializeAsrtSandbox({ allowedDomains: [] });
    let snapshot: sandboxWritePolicy.SandboxGitControlSnapshot | undefined;
    buildPerCommandSandboxCustomConfig({ allowWrite: [root], denyWrite: [hidden] }, undefined,
      value => { snapshot = value; });
    setProcessPlatform(ORIGINAL_PLATFORM);
    const cleanup = await bareRepositoryCleanup.prepareSandboxBareRepositoryCleanup([root], "physical-excluded", snapshot);
    mkdirSync(join(hidden, ".git"));
    writeFileSync(join(hidden, ".git", "config"), "host file\n");
    writeFileSync(join(root, "config"), "sandbox bare layout\n");
    expect(cleanup()).toContain(JSON.stringify(join(root, "config")));
    expect(existsSync(join(hidden, ".git", "config"))).toBe(true);
  });

  // The Linux runtime consumes POSIX glob paths.
  it.skipIf(process.platform === "win32")("keeps a directory wildcard exclusion disjoint from sibling Git controls", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "asrt-glob-exclusion-")));
    temporaryRoots.push(root);
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    await initializeAsrtSandbox({ allowedDomains: [] });
    let snapshot: sandboxWritePolicy.SandboxGitControlSnapshot | undefined;
    buildPerCommandSandboxCustomConfig({ allowWrite: [root], denyWrite: [join(root, "private", "**")] }, undefined,
      value => { snapshot = value; });
    setProcessPlatform(ORIGINAL_PLATFORM);
    const cleanup = await bareRepositoryCleanup.prepareSandboxBareRepositoryCleanup([root], "glob-excluded", snapshot);
    const control = join(root, ".git", "config.worktree");
    writeFileSync(control, "created during command\n");
    expect(cleanup()).toContain(JSON.stringify(control));
    expect(existsSync(control)).toBe(false);
  });

  it("refuses unrepresentable deny patterns before a command can run", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "asrt-unsupported-exclusion-")));
    temporaryRoots.push(root);
    await initializeAsrtSandbox({ allowedDomains: [] });
    expect(() => buildPerCommandSandboxCustomConfig({ allowWrite: [root], denyWrite: [join(root, "private-[ab]", "**")] }))
      .toThrow("Linux Git quarantine cannot represent a filesystem deny pattern");
  });

  it.each(["read", "write"] as const)("preserves host-created controls inside a nested %s-denied subtree", async kind => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "asrt-excluded-controls-")));
    temporaryRoots.push(root);
    const hidden = join(root, "private-store");
    mkdirSync(hidden);
    await initializeAsrtSandbox({ allowedDomains: [], ...(kind === "read" ? { denyRead: [hidden] } : {}) });
    let snapshot: sandboxWritePolicy.SandboxGitControlSnapshot | undefined;
    const config = buildPerCommandSandboxCustomConfig({
      allowWrite: [root], ...(kind === "write" ? { denyWrite: [hidden] } : {}),
    }, undefined, value => { snapshot = value; });
    expect(config?.filesystem?.allowWrite).toEqual([root]);
    setProcessPlatform(ORIGINAL_PLATFORM);
    const cleanup = await bareRepositoryCleanup.prepareSandboxBareRepositoryCleanup([root], "nested-excluded", snapshot);
    const marker = join(hidden, ".git");
    mkdirSync(marker);
    writeFileSync(join(marker, "config"), "concurrent host file\n");
    writeFileSync(join(root, "config"), "sandbox bare layout\n");
    expect(cleanup()).toContain(JSON.stringify(join(root, "config")));
    expect(existsSync(join(marker, "config"))).toBe(true);
    expect(existsSync(join(root, "config"))).toBe(false);
  });

  it("limits cleanup identities to roots actually granted after the read floor", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "asrt-effective-snapshot-")));
    temporaryRoots.push(root);
    const retained = join(root, "retained");
    const withheld = join(root, "withheld");
    mkdirSync(retained);
    mkdirSync(withheld);
    await initializeAsrtSandbox({ allowedDomains: [], denyRead: [withheld] });
    let snapshot: sandboxWritePolicy.SandboxGitControlSnapshot | undefined;
    const config = buildPerCommandSandboxCustomConfig({ allowWrite: [retained, withheld] }, undefined, value => { snapshot = value; });
    expect(config?.filesystem?.allowWrite).toEqual([retained]);
    expect([...snapshot!.roots.keys()]).toEqual([retained]);
    expect(snapshot!.bareRoots.has(withheld)).toBe(false);
    setProcessPlatform(ORIGINAL_PLATFORM);
    const cleanup = await bareRepositoryCleanup.prepareSandboxBareRepositoryCleanup([retained], "effective-only", snapshot);
    writeFileSync(join(withheld, "config"), "concurrent host file\n");
    expect(cleanup()).toBeUndefined();
    expect(existsSync(join(withheld, "config"))).toBe(true);
  });

  it.each(["tool", "worker"] as const)("settles cleanup when a %s wrap completes after invocation release", async kind => {
    await initializeAsrtSandbox({ allowedDomains: [] });
    const cleanup = vi.fn(() => "quarantine restore location");
    vi.spyOn(bareRepositoryCleanup, "prepareSandboxBareRepositoryCleanup").mockResolvedValue(cleanup);
    let finishWrap!: (wrapped: { argv: string[]; env: NodeJS.ProcessEnv }) => void;
    let enteredWrap!: () => void;
    const entered = new Promise<void>(resolve => { enteredWrap = resolve; });
    h.wrapWithSandboxArgv.mockImplementationOnce(() => new Promise(resolve => { finishWrap = resolve; enteredWrap(); }));
    const invocation = openEgressInvocation({ kind: "terminal", tabId: "cancelled-terminal" });
    const pending = (kind === "tool" ? wrapToolCommand : wrapWorkerCommand)("true", { commandId: invocation.token });
    await entered;
    expect(finishWrap).toBeTypeOf("function");
    invocation.release();
    finishWrap({ argv: ["/bin/bash", "-c", CONFIGURED_LINUX_BWRAP_COMMAND], env: {} });
    const wrapped = await pending;
    await expect(wrapped.cleanupCompleted).resolves.toEqual({ notice: "quarantine restore location" });
    expect(cleanup).toHaveBeenCalledOnce();
    invocation.release();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports cleanup failures to the command result owner after release", async () => {
    await initializeAsrtSandbox({ allowedDomains: [] });
    vi.spyOn(bareRepositoryCleanup, "prepareSandboxBareRepositoryCleanup").mockResolvedValue(() => {
      throw new Error("cleanup permission refused");
    });
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: undefined, approvalSurface: "unavailable" } });
    const wrapped = await wrapToolCommand("true", { commandId: invocation.token });
    invocation.release();
    // Later ended terminals cannot evict an unconsumed shell outcome.
    for (let index = 0; index < 129; index++) {
      const terminal = openEgressInvocation({ kind: "terminal", tabId: `terminal-${index}` });
      await wrapWorkerCommand("true", { commandId: terminal.token });
      terminal.release();
    }
    const output = await wrapped.cleanupCompleted;
    expect(output?.failure).toContain("cleanup permission refused");
    expect(output?.failure).toContain("inspect them before running independent Git");
  });

  it("exposes a scan budget reason and the actual retained write roots", () => {
    vi.spyOn(sandboxWritePolicy, "buildMandatorySandboxWritePolicy").mockReturnValue({
      allowWrite: ["/project/child"], denyWrite: [],
      narrowedWriteRoots: [{ root: "/project", reason: "entry-budget" }],
    });
    const notices: string[] = [];
    const config = buildPerCommandSandboxCustomConfig({ allowWrite: ["/project", "/project/child"] }, notice => notices.push(notice));
    expect(config?.filesystem?.allowWrite).toEqual(["/project/child"]);
    expect(notices).toEqual([expect.stringContaining('Project too large to scan for nested repositories within the directory-entry budget; write access narrowed to "/project/child"')]);
    expect(notices[0]).toContain('withheld roots: "/project"');
  });

  it("defers bare-layout quarantine to the owning invocation release", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "asrt-bare-release-")));
    temporaryRoots.push(root);
    await initializeAsrtSandbox({ allowedDomains: [] });
    const cleanup = vi.fn(() => "quarantine restore location");
    vi.spyOn(bareRepositoryCleanup, "prepareSandboxBareRepositoryCleanup").mockResolvedValue(cleanup);
    h.wrapWithSandboxArgv.mockClear();
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: root, approvalSurface: "unavailable" } });
    try {
      const wrapped = await wrapToolCommand("true", { commandId: invocation.token, filesystem: { allowWrite: [root], denyWrite: [] } });
      const applied = h.wrapWithSandboxArgv.mock.calls[0]![2].filesystem;
      for (const name of sandboxWritePolicy.SANDBOX_BARE_REPOSITORY_ENTRIES) {
        expect(applied.denyWrite).not.toContain(join(root, name));
        expect(existsSync(join(root, name))).toBe(false);
      }
      writeFileSync(join(root, "HEAD"), "ref: refs/heads/main\n");
      writeFileSync(join(root, "config"), "planted");
      mkdirSync(join(root, "objects"));
      mkdirSync(join(root, "refs"));
      expect(existsSync(join(root, "HEAD"))).toBe(true);
      expect(cleanup).not.toHaveBeenCalled();
      expect(isHostGitWorkspaceAvailable(root)).toBe(false);
      invocation.release();
      await expect(wrapped.cleanupCompleted).resolves.toEqual({ notice: "quarantine restore location" });
      expect(isHostGitWorkspaceAvailable(root)).toBe(true);
    } finally { invocation.release(); }
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("rescans shared write roots for each tool command without an override", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "asrt-rescan-")));
    temporaryRoots.push(root);
    await initializeAsrtSandbox({ allowedDomains: [], allowWrite: [root] });
    h.wrapWithSandboxArgv.mockClear();
    await wrapToolCommand("true", { commandId: TEST_COMMAND_ID });
    const before = h.wrapWithSandboxArgv.mock.calls[0]![2].filesystem;
    expect(before.denyWrite).not.toContain(join(root, ".git"));
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(root, ".git", "config"), "original\n");
    await wrapToolCommand("true", { commandId: TEST_COMMAND_ID });
    const after = h.wrapWithSandboxArgv.mock.calls[1]![2].filesystem;
    expect(after.denyWrite).not.toContain(join(root, ".git"));
    expect(after.denyWrite).toContain(join(root, ".git", "config"));
    expect(after.allowWrite).toEqual([root]);
  });

  it("withholds workspace host Git after a failed quarantine", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "asrt-failed-git-hold-")));
    temporaryRoots.push(root);
    await initializeAsrtSandbox({ allowedDomains: [] });
    vi.spyOn(bareRepositoryCleanup, "prepareSandboxBareRepositoryCleanup").mockResolvedValue(() => {
      throw new Error("retained control could not be quarantined");
    });
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: root, approvalSurface: "unavailable" } });
    const wrapped = await wrapToolCommand("true", { commandId: invocation.token, filesystem: { allowWrite: [root], denyWrite: [] } });
    expect(isHostGitWorkspaceAvailable(root)).toBe(false);
    invocation.release();
    expect((await wrapped.cleanupCompleted)?.failure).toContain("retained control");
    expect(isHostGitWorkspaceAvailable(root)).toBe(false);
  });

  async function assertImmutableScan(wrap: typeof wrapToolCommand): Promise<void> {
    await initializeAsrtSandbox({ allowedDomains: [] });
    h.wrapWithSandboxArgv.mockClear();
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "asrt-snapshot-")));
    temporaryRoots.push(fixture);
    const root = join(fixture, "workspace[held]");
    const denied = join(root, ".gitconfig");
    const ordinary = join(root, "ordinary");
    mkdirSync(denied, { recursive: true });
    mkdirSync(ordinary);
    const discover = vi.spyOn(sandboxWritePolicy, "buildMandatorySandboxWritePolicy");
    const filesystem = { allowRead: [root], allowWrite: [root], denyWrite: [] as string[] };
    const quote = (word: string) => `'${word.replace(/'/g, `'"'"'`)}'`;
    const mount = (option: string, path: string) => [option, path, path].map(quote).join(" ");
    h.wrapWithSandboxArgv.mockImplementationOnce(async (_command, _shell, config: Partial<SandboxRuntimeConfig>) => {
      const applied = config.filesystem!;
      expect(Object.isFrozen(applied)).toBe(true);
      for (const entries of Object.values(applied)) expect(Object.isFrozen(entries)).toBe(true);
      expect(applied.allowRead).not.toBe(filesystem.allowRead);
      expect(applied.allowWrite).not.toBe(filesystem.allowWrite);
      expect(applied.allowWrite).toEqual([root]);
      const literal = applied.denyWrite.find(entry => typeof entry !== "string" && entry.path === denied);
      expect(literal).toEqual({ path: denied, literal: true });
      expect(Object.isFrozen(literal)).toBe(true);
      expect(Reflect.set(applied, "denyWrite", [])).toBe(false);
      expect(Reflect.set(applied.denyWrite, "0", ordinary)).toBe(false);
      // A caller changing its lists while the runtime awaits cannot replace the snapshot the Linux replay was handed alongside this wrap.
      filesystem.denyWrite.push(ordinary);
      return {
        argv: ["/bin/bash", "-c", [
          "/configured/asrt/bwrap --new-session --die-with-parent --unshare-pid --ro-bind / /",
          `--tmpfs ${quote(root)}`,
          mount("--bind", denied), mount("--bind", ordinary),
          mount("--ro-bind", denied), mount("--ro-bind", root),
          "-- /bin/bash -c true",
        ].join(" ")],
        env: {},
      };
    });
    const wrapped = await wrap("true", { commandId: TEST_COMMAND_ID, filesystem });
    expect(discover).toHaveBeenCalledOnce();
    expect(discover).toHaveBeenCalledWith([root], undefined, getDefaultSensitiveWriteDenyPaths());
    expect(h.wrapWithSandboxArgv).toHaveBeenCalledOnce();
    const replay = wrapped.argv[2]!.split(mount("--ro-bind", root))[1]!;
    expect(replay).toContain(mount("--bind", ordinary));
    expect(replay).toContain(mount("--ro-bind", denied));
    expect(replay).not.toContain(mount("--bind", denied));
  }

  // The Linux mount replay uses POSIX path containment.
  it.skipIf(process.platform === "win32")("uses one immutable scan for the tool runtime and literal-deny replay", async () => {
    await assertImmutableScan(wrapToolCommand);
  });

  // The Linux mount replay uses POSIX path containment.
  it.skipIf(process.platform === "win32")("uses one immutable scan for the worker runtime and literal-deny replay", async () => {
    await assertImmutableScan(wrapWorkerCommand);
  });

  it("rejects a marked allowRead entry before handing an ambiguous grant to the runtime", async () => {
    await initializeAsrtSandbox({ allowedDomains: [] });
    h.wrapWithSandboxArgv.mockClear();
    await expect(wrapToolCommand("true", {
      commandId: TEST_COMMAND_ID,
      filesystem: { allowRead: [{ path: process.cwd(), literal: true }] as never },
    })).rejects.toThrow(TypeError);
    expect(h.wrapWithSandboxArgv).not.toHaveBeenCalled();
  });
});

describe("initializeAsrtSandbox — Linux configured-wrapper runtime probe", () => {
  it("runs the fixed no-I/O command through ASRT's exact configured argv before activation", async () => {
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

    expect(h.wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
    const wrapCall = h.wrapWithSandboxArgv.mock.calls[0];
    expect(wrapCall?.[0]).toBe("true");
    expect(wrapCall?.[1]).toBeUndefined();
    expect(wrapCall?.[2]).toBeUndefined();
    expect(wrapCall?.[3]).toBeInstanceOf(AbortSignal);
    expect(wrapCall?.[4]).toBe(process.cwd());
    expect(wrapCall?.[5]).toMatchObject({ commandId: expect.stringMatching(/^[a-f0-9]{32}$/u), denyUnixSockets: true });
    expect(h.openInvocationListener).toHaveBeenCalledWith((wrapCall?.[5] as { commandId: string }).commandId);
    expect(h.closeInvocationListener).toHaveBeenCalledWith((wrapCall?.[5] as { commandId: string }).commandId);
    expect(h.spawn).toHaveBeenCalledWith(
      "/bin/bash",
      ["-c", CONFIGURED_LINUX_BWRAP_COMMAND],
      {
        cwd: process.cwd(),
        env: { ASRT_PROBE_ENV: "configured" },
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const spawnedBwrapCommand = h.spawn.mock.calls[0]?.[1]?.[1];
    expect(spawnedBwrapCommand).toContain("bwrap");
    expect(spawnedBwrapCommand).toContain("--unshare-user");
    expect(spawnedBwrapCommand).toContain("--cap-drop");
    expect(spawnedBwrapCommand).toContain("ALL");
    // The wrapper descriptor, not `true` directly, is the only spawn target.
    expect(h.spawn).not.toHaveBeenCalledWith("true", expect.anything(), expect.anything());
    expect(h.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(isAsrtSandboxActive()).toBe(true);
  });

  it("refuses activation when the invocation listener cannot open", async () => {
    h.openInvocationListener.mockRejectedValueOnce(new Error("Listener admission refused"));
    await expect(initializeAsrtSandbox({ allowedDomains: [] })).rejects.toSatisfy(isAsrtLinuxRuntimeProbeError);
    expect(h.spawn).not.toHaveBeenCalled();
    expect(h.reset).toHaveBeenCalledOnce();
    expect(isAsrtSandboxActive()).toBe(false);
  });

  it("refuses Linux capability when Unix socket filtering has no supported helper", async () => {
    const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
    Object.defineProperty(process, "arch", { ...originalArch, value: "ia32" });
    try {
      await expect(initializeAsrtSandbox({ allowedDomains: [] })).rejects.toThrow("Unix socket filtering helper is unavailable");
      expect(h.spawn).not.toHaveBeenCalled();
      expect(h.reset).toHaveBeenCalledOnce();
      expect(isAsrtSandboxActive()).toBe(false);
    } finally {
      Object.defineProperty(process, "arch", originalArch);
    }
  });

  it("does not invoke the Linux probe on win32", async () => {
    setProcessPlatform("win32");
    const root = mkdtempSync(join(tmpdir(), "asrt-win-probe-"));
    temporaryRoots.push(root);
    const originalResources = getHostResources();
    const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
    const resourcePath = join(root, "resources");
    const scripts = join(resourcePath, "skill-scripts");
    mkdirSync(scripts, { recursive: true });
    const runtime = join(root, "host-runtime.exe");
    writeFileSync(runtime, "runtime image fixture");
    const profile = ORIGINAL_PLATFORM === "win32" ? join(root, "alice") : "C:\\Users\\alice";
    if (ORIGINAL_PLATFORM === "win32") mkdirSync(profile);
    vi.stubEnv("HOME", profile);
    vi.stubEnv("USERPROFILE", profile);
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([profile]);

    Object.defineProperty(process, "execPath", { ...originalExecPath, value: runtime });
    configureHostResources({ resourcePath, isPackaged: true });
    try {
      expect(getDefaultSensitiveWriteDenyPaths()).toEqual(expect.arrayContaining([scripts, runtime]));
      await initializeAsrtSandbox({ allowedDomains: [] });

      expect(isAsrtSandboxActive()).toBe(true);
      expect(h.wrapWithSandboxArgv).not.toHaveBeenCalled();
      expect(h.spawn).not.toHaveBeenCalled();
    } finally {
      try { if (isAsrtSandboxActive()) await resetAsrtSandbox(); }
      finally {
        try { configureHostResources(originalResources); }
        finally { Object.defineProperty(process, "execPath", originalExecPath); }
      }
    }
  });
  it("resets the initialized manager and leaves the adapter inactive when the configured wrapper exits non-zero", async () => {
    h.spawn.mockImplementation(() => childThatCloses(1));

    const failure = initializeAsrtSandbox({ allowedDomains: [] });
    await expect(failure).rejects.toSatisfy((error: unknown) => {
      return (
        isAsrtLinuxRuntimeProbeError(error) &&
        error.code === ASRT_LINUX_RUNTIME_PROBE_ERROR_CODE
      );
    });

    expect(isAsrtSandboxActive()).toBe(false);
    expect(h.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });

  it("turns an EPERM configured-wrapper error into degradation, never verified capability", async () => {
    // A hardened Linux host can deny the bwrap/user-namespace setup with EPERM. We intentionally do not scrape wrapper stderr; the typed probe result is enough for boot to degrade and keep the capability source of truth inactive.
    h.spawn.mockImplementation(() => childThatErrors("EPERM"));

    const failure = initializeAsrtSandbox({ allowedDomains: [] });
    await expect(failure).rejects.toSatisfy((error: unknown) => {
      return (
        isAsrtLinuxRuntimeProbeError(error) &&
        error.code === ASRT_LINUX_RUNTIME_PROBE_ERROR_CODE
      );
    });

    expect(isAsrtSandboxActive()).toBe(false);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });

  it("treats a cleanup failure as a typed degradation and resets before capability publication", async () => {
    h.cleanupAfterCommand.mockImplementation(() => {
      throw new Error("cleanup failed");
    });

    const failure = initializeAsrtSandbox({ allowedDomains: [] });
    await expect(failure).rejects.toSatisfy((error: unknown) => {
      return isAsrtLinuxRuntimeProbeError(error);
    });

    expect(isAsrtSandboxActive()).toBe(false);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });

  it("times out without a plain fallback, waits a bounded close grace, and resets the manager", async () => {
    vi.useFakeTimers();
    let child: ProbeChild | undefined;
    h.spawn.mockImplementation(() => {
      child = childThatNeverCloses();
      return child;
    });

    const failure = initializeAsrtSandbox({ allowedDomains: [] });
    // Attach the rejection observer before advancing fake time so Vitest does not see the expected timeout as an unhandled rejection.
    const expectedFailure = expect(failure).rejects.toSatisfy((error: unknown) => {
      return isAsrtLinuxRuntimeProbeError(error);
    });
    // Fake timers also own queueMicrotask in this runner. Flush zero-time work before advancing to the fixed five-second timeout.
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(h.spawn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(child?.kill).toHaveBeenCalledWith("SIGKILL");
    expect(h.cleanupAfterCommand).not.toHaveBeenCalled();
    expect(h.reset).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(h.cleanupAfterCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expectedFailure;

    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(isAsrtSandboxActive()).toBe(false);
    expect(h.reset).toHaveBeenCalledTimes(1);
  });

  it("waits for a SIGKILL close before ASRT cleanup and reset", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let child: ProbeChild | undefined;
    h.spawn.mockImplementation(() => {
      child = childThatNeverCloses();
      child.kill.mockImplementation(() => {
        order.push("kill");
        return true;
      });
      return child;
    });
    h.cleanupAfterCommand.mockImplementation(() => {
      order.push("cleanup");
    });
    h.reset.mockImplementation(async () => {
      order.push("reset");
    });

    const failure = initializeAsrtSandbox({ allowedDomains: [] });
    const expectedFailure = expect(failure).rejects.toSatisfy((error: unknown) => {
      return isAsrtLinuxRuntimeProbeError(error);
    });
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(order).toEqual(["kill"]);
    expect(h.cleanupAfterCommand).not.toHaveBeenCalled();
    child?.emit("close", null, "SIGKILL");
    await expectedFailure;

    expect(order).toEqual(["kill", "cleanup", "reset"]);
    expect(isAsrtSandboxActive()).toBe(false);
  });
});

describe("configured profile launch on macOS", () => {
  it("publishes activity only after the configured profile executes", async () => {
    setProcessPlatform("darwin");
    const argv = ["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/bin/sh", "-c", "true"];
    h.wrapWithSandboxArgv.mockResolvedValue({ argv, env: { ASRT_PROBE_ENV: "configured" } });
    await initializeAsrtSandbox({ allowedDomains: [] });
    expect(h.spawn).toHaveBeenCalledWith(argv[0], argv.slice(1), expect.objectContaining({ shell: false }));
    expect(isAsrtSandboxActive()).toBe(true);
  });
  it("resets and reports a typed failure when the OS rejects the profile", async () => {
    setProcessPlatform("darwin");
    h.spawn.mockImplementation(() => childThatCloses(71));
    const failure = await initializeAsrtSandbox({ allowedDomains: [] }).catch((error: unknown) => error);
    expect(isAsrtMacRuntimeProbeError(failure)).toBe(true);
    expect(failure).toMatchObject({ code: ASRT_MAC_RUNTIME_PROBE_ERROR_CODE });
    expect(h.reset).toHaveBeenCalledOnce();
    expect(isAsrtSandboxActive()).toBe(false);
  });
});

describe.each(["darwin", "linux"] as const)("private HOME reads after session refusal on %s", (platform) => {
  it("retains only the invocation HOME grant when session reads are refused", async () => {
    setProcessPlatform(platform);
    const sessionRoot = getBuiltinShellSessionReadPolicy().allowRead[0];
    expect(sessionRoot).toBeDefined();
    await initializeAsrtSandbox({ allowedDomains: [], denyRead: [sessionRoot!] });
    const privateRoots = appOwnedSandboxPrivateRoots();
    const homeRoot = privateRoots.find((root) => basename(root) === "home")!;
    const ownHome = join(homeRoot, "invocation-home");
    const otherHome = join(homeRoot, "other-home");
    const policy = getBuiltinShellReadPolicy([ownHome, join(ownHome, "document-observation"), otherHome], homedir(), ownHome);
    expect(policy.allowRead).toEqual([ownHome, join(ownHome, "document-observation")]);
    expect(policy.denyRead).toEqual(expect.arrayContaining(getDefaultSensitiveReadDenyPaths()));
    expect(policy.floorPierces).toEqual([]);
  });

  it("preserves a trusted deny of the private HOME root", async () => {
    setProcessPlatform(platform);
    const sessionRoot = getBuiltinShellSessionReadPolicy().allowRead[0];
    expect(sessionRoot).toBeDefined();
    const homeRoot = appOwnedSandboxPrivateRoots().find((root) => basename(root) === "home")!;
    await initializeAsrtSandbox({ allowedDomains: [], denyRead: [sessionRoot!, homeRoot] });
    const ownHome = join(homeRoot, "invocation-home");
    const policy = getBuiltinShellReadPolicy([ownHome, join(ownHome, "document-observation")], homedir(), ownHome);
    expect(policy.allowRead).toEqual([]);
    expect(policy.denyRead).toContain(homeRoot);
  });
});

// The read policy checks every grant against every floor entry. It compiles each entry once; this oracle is the per-path, per-ancestor check it replaced.
describe.each([
  ["darwin", "a trusted subtree deny", ["~/secret/**"]],
  ["linux", "a trusted subtree deny", ["~/secret/**"]],
  ["darwin", "a trusted bracket deny", ["~/s[ab]"]],
  ["linux", "a trusted bracket deny", ["~/s[ab]"]],
] as const)("builtin shell read policy on %s with %s", (platform, _label, denyRead) => {
  beforeEach(async () => {
    setProcessPlatform(platform);
    await initializeAsrtSandbox({ allowedDomains: [], denyRead: [...denyRead] });
  });

  const referenceCovers = (pattern: string, canonicalPath: string): boolean => {
    if (/[\[\]]/.test(pattern)) return true;
    for (let candidate = canonicalPath; ; candidate = dirname(candidate)) {
      if (globMatch(candidate, pattern) || globMatch(`${candidate}/`, pattern)) return true;
      if (dirname(candidate) === candidate) return false;
    }
  };
  const corpus = (): string[] => {
    const empty = getBuiltinShellReadPolicy([], homedir());
    const paths = new Set<string>();
    for (const entry of [...empty.denyRead, ...empty.floorPierces]) {
      const wildcard = entry.search(/[*?[]/u);
      const literal = expandLeadingTilde(wildcard < 0 ? entry : entry.slice(0, wildcard));
      const base = literal.replace(/[\\/]+$/u, "") || "/";
      paths.add(base);
      paths.add(join(base, "child", "file"));
      paths.add(dirname(base));
      // Case-folded on darwin, so an upper-cased spelling is the same deny.
      paths.add(join(dirname(base), basename(base).toUpperCase()));
      paths.add(`${base}-sibling`);
    }
    for (const pierce of empty.floorPierces) paths.add(join(pierce, "nested", ".ssh", "id_ed25519"));
    // The trusted denies: the subtree root and a path in it, a near miss, and names the bracket would match and would not.
    for (const name of ["secret", join("secret", "x"), "secretive", "sa", "sb", "sc"]) paths.add(join(homedir(), name));
    for (const ordinary of [["projects", "x"], ["projects", "x", ".git", "hooks"], [".config"], [".claude", "hooks"], [".husky"]]) {
      paths.add(join(homedir(), ...ordinary));
    }
    paths.add(join(tmpdir(), "ave-read-policy-cwd"));
    return [...paths];
  };

  it("allows and withholds exactly what the per-path check does", () => {
    const reads = corpus();
    const ownHome = join(appOwnedSandboxPrivateRoots()[0] ?? tmpdir(), "own-home");
    const sessions = getBuiltinShellSessionReadPolicy();
    expect(sessions.denyRead).toEqual(expect.arrayContaining([...denyRead]));
    const privateRoots = appOwnedSandboxPrivateRoots();
    const own = canonicalizePathForMatch(ownHome);
    // The fixture is immutable during matching; canonicalize each deny once while retaining the per-path, per-ancestor oracle.
    const patterns = new Map([...sessions.denyRead, ...privateRoots].map(denied => [denied,
      /[\[\]]/.test(denied) ? denied : canonicalizePathForMatch(expandLeadingTilde(denied))]));
    const expected = [...reads, ...sessions.allowRead].filter((path) => {
      const resolved = canonicalizePathForMatch(path);
      if (sessions.denyRead.some((denied) => referenceCovers(patterns.get(denied)!, resolved))) return false;
      const insideOwnHome = resolved === own || resolved.startsWith(`${own}/`);
      return insideOwnHome || !privateRoots.some((root) => referenceCovers(patterns.get(root)!, resolved));
    });
    const policy = getBuiltinShellReadPolicy(reads, homedir(), ownHome);
    expect(policy.allowRead).toEqual(expected);
    expect(policy.denyRead).toEqual([...sessions.denyRead, ...privateRoots]);
    if (denyRead[0] === "~/secret/**") {
      // The subtree root itself is denied only through its trailing-slash spelling: `/**` does not match the bare directory.
      expect(policy.allowRead).not.toContain(join(homedir(), "secret"));
      expect(policy.allowRead).not.toContain(join(homedir(), "secret", "x"));
      expect(policy.allowRead).toContain(join(homedir(), "secretive"));
      expect(policy.allowRead).toContain(join(homedir(), "projects", "x"));
    } else {
      // A bracket pattern is not represented, so it fails closed for every grant.
      expect(policy.allowRead).toEqual([]);
    }
  });

  it("compiles each deny once however many paths it checks", () => {
    const ordinary = [join(homedir(), "projects", "x"), join(tmpdir(), "ave-read-policy-cwd")];
    const compile = vi.spyOn(globMatcher, "compileGlobMatcher");
    const match = vi.spyOn(globMatcher, "globMatch");
    const work = (): number => compile.mock.calls.length + match.mock.calls.length;
    getBuiltinShellReadPolicy(ordinary.slice(0, 1), homedir());
    const forOne = work();
    compile.mockClear();
    match.mockClear();
    getBuiltinShellReadPolicy([...ordinary, ...Array.from({ length: 40 }, (_, index) => join(homedir(), "projects", `p${index}`))], homedir());
    // Before, every path re-canonicalized and recompiled every deny for each of its ancestors: 40 more paths cost thousands more compiles.
    expect(work()).toBe(forOne);
  });
});
