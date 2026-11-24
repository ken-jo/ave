import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitFixtureEnv } from "../../__tests__/support/git-fixture-env.mjs";
import { shellQuote } from "../../lib/shell-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../tool-timeout-policy.js";
import { buildHostGitArgs, holdSandboxGitWrites, isHostGitWorkspaceAvailable } from "../host-git.js";

describe("host Git configuration floor", () => {
  it("applies the mandatory floor after caller configuration without changing command arguments", () => {
    const args = buildHostGitArgs(["-C", "/project", "status"], {
      configArgs: ["-c", "core.fsmonitor=untrusted-monitor", "-c", "safe.bareRepository=all"],
      disabledHooksPath: "/host/empty",
    });
    expect(args.slice(0, 10)).toEqual([
      "-c", "core.fsmonitor=untrusted-monitor", "-c", "safe.bareRepository=all",
      "-c", "safe.bareRepository=explicit", "-c", "core.fsmonitor=false",
      "-c", "core.hooksPath=/host/empty",
    ]);
    expect(args.slice(-3)).toEqual(["-C", "/project", "status"]);
    // Then every hook event, switched off as a whole.
    const events = args.slice(10, -3);
    expect(events.filter((_, index) => index % 2 === 0).every(arg => arg === "-c")).toBe(true);
    const switched = events.filter((_, index) => index % 2 === 1);
    expect(switched.every(entry => /^hook\.[a-z0-9-]+\.enabled=false$/u.test(entry))).toBe(true);
    expect(switched).toEqual(expect.arrayContaining(["prepare-commit-msg", "post-commit", "reference-transaction", "post-checkout", "post-merge", "post-index-change"].map(event => `hook.${event}.enabled=false`)));
  });

  it("uses the null device when no owned empty directory is supplied", () => {
    expect(buildHostGitArgs(["--version"])).toContain(`core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`);
  });
});

describe("host Git workspace ordering", () => {
  let root: string;
  const releases: Array<() => void> = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-host-git-order-"));
  });
  afterEach(() => {
    for (const release of releases.splice(0)) release();
    rmSync(root, { recursive: true, force: true });
  });

  function hold(roots: readonly string[]): () => void {
    const release = holdSandboxGitWrites(roots);
    releases.push(release);
    return release;
  }

  it("blocks exact, ancestor and descendant workspaces while preserving independent siblings", () => {
    const project = join(root, "project");
    mkdirSync(project);
    const release = hold([project]);
    expect(isHostGitWorkspaceAvailable(project)).toBe(false);
    expect(isHostGitWorkspaceAvailable(root)).toBe(false);
    expect(isHostGitWorkspaceAvailable(join(project, "src"))).toBe(false);
    expect(isHostGitWorkspaceAvailable(join(root, "project-sibling"))).toBe(true);
    release();
    expect(isHostGitWorkspaceAvailable(project)).toBe(true);
  });

  it("retains overlapping failed-cleanup holds until their own idempotent release", () => {
    const firstRelease = hold([root]);
    const failedCleanupRelease = hold([join(root, "src")]);
    firstRelease();
    firstRelease();
    expect(isHostGitWorkspaceAvailable(root)).toBe(false);
    expect(isHostGitWorkspaceAvailable(join(root, "src", "nested"))).toBe(false);
    expect(isHostGitWorkspaceAvailable(join(root, "independent"))).toBe(true);
    failedCleanupRelease();
    failedCleanupRelease();
    expect(isHostGitWorkspaceAvailable(root)).toBe(true);
  });

  it("resolves physical aliases for holds and queries, including not-yet-created descendants", () => {
    const physical = join(root, "physical");
    const alias = join(root, "alias");
    mkdirSync(physical);
    symlinkSync(physical, alias, process.platform === "win32" ? "junction" : "dir");
    const release = hold([join(alias, "future")]);
    expect(isHostGitWorkspaceAvailable(physical)).toBe(false);
    expect(isHostGitWorkspaceAvailable(join(physical, "future", "nested"))).toBe(false);
    expect(isHostGitWorkspaceAvailable(join(alias, "future"))).toBe(false);
    expect(isHostGitWorkspaceAvailable(join(physical, "sibling"))).toBe(true);
    release();
    expect(isHostGitWorkspaceAvailable(join(alias, "future"))).toBe(true);
  });

  it("refuses unresolved query identities while another hold is unsettled", () => {
    hold([root]);
    const dangling = join(root, "dangling");
    symlinkSync(join(root, "missing"), dangling, process.platform === "win32" ? "junction" : "dir");
    expect(isHostGitWorkspaceAvailable(dangling)).toBe(false);
  });

  it("does not hold any workspace for an empty write-root list", () => {
    const release = hold([]);
    expect(isHostGitWorkspaceAvailable(root)).toBe(true);
    release();
    release();
    expect(isHostGitWorkspaceAvailable(root)).toBe(true);
  });
});

describe.runIf(process.platform === "darwin" || process.platform === "linux")("host Git with real repositories", () => {
  let root: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-host-git-"));
    env = { ...gitFixtureEnv(root), GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function git(cwd: string, args: string[], hardened = false) {
    const result = spawnSync("git", hardened ? buildHostGitArgs(args) : args, { cwd, env, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs });
    if (result.error) throw result.error;
    return result;
  }

  function requireGit(cwd: string, args: string[]): void {
    const result = git(cwd, args);
    expect(result.status, result.stderr).toBe(0);
  }

  function program(path: string, text: string): void {
    writeFileSync(path, `#!/bin/sh\n${text}\n`);
    chmodSync(path, 0o755);
  }

  it("proves a planted bare monitor executes before the floor and is blocked after it", () => {
    const planted = join(root, "non-repository-root");
    mkdirSync(planted);
    requireGit(planted, ["init", "--bare", "--quiet"]);
    // A discovered bare layout can claim an ordinary working tree in its config.
    requireGit(planted, ["config", "core.bare", "false"]);
    requireGit(planted, ["config", "core.worktree", planted]);
    writeFileSync(join(planted, "tracked.txt"), "fixture\n");
    requireGit(planted, ["add", "tracked.txt"]);
    const monitor = join(root, "monitor");
    const marker = join(root, "monitor-ran");
    program(monitor, `printf executed > ${shellQuote(marker)}; printf "token\\0"`);
    requireGit(planted, ["config", "core.fsmonitor", monitor]);

    const before = git(planted, ["status", "--porcelain"]);
    expect(before.status, before.stderr).toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("executed");
    rmSync(marker);

    const hardened = git(planted, ["status", "--porcelain"], true);
    expect(hardened.status).not.toBe(0);
    expect(hardened.stderr).toContain("safe.bareRepository");
    expect(existsSync(marker)).toBe(false);

    // An explicitly selected store is still usable, with its monitor disabled.
    const explicit = git(planted, [`--git-dir=${planted}`, `--work-tree=${planted}`, "status", "--porcelain"], true);
    expect(explicit.status, explicit.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("neutralizes a repository hook while preserving normal host commits", () => {
    requireGit(root, ["init", "--quiet"]);
    const marker = join(root, "hook-ran");
    program(join(root, ".git", "hooks", "pre-commit"), `printf executed > ${shellQuote(marker)}; exit 1`);
    const before = git(root, ["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
    expect(before.status).not.toBe(0);
    expect(readFileSync(marker, "utf8")).toBe("executed");
    rmSync(marker);
    const after = git(root, ["commit", "--quiet", "--allow-empty", "-m", "fixture"], true);
    expect(after.status, after.stderr).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("host git starts only where the hold is asked", () => {
  const src = fileURLToPath(new URL("../../", import.meta.url));
  /** The one start, and the one caller that asks the hold for a plan the shell tool runs later. */
  const ASKS_THE_HOLD = new Set(["shared/host-git.ts", "permissions/verified-shell-command.ts"]);
  const HOST_GIT_RESOLUTION = /\b(?:resolveHostGit|withHostGitLaunch|withHostGitRecovery|discoverHostGitAsync)\b|["'][^"'\n]*\/host-git-executable\.js["']/u;
  const DIRECT_PROCESS_START = /\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(/gu;
  const PROCESS_IMPORT = /^\s*import\s+(?!type\b)[^;]*from\s+["'](?:node:)?child_process["']|\b(?:require|import)\s*\(\s*["'](?:node:)?child_process["']/mu;
  const productSources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? entry.name === "__tests__" ? [] : productSources(join(dir, entry.name))
    : /\.tsx?$/u.test(entry.name) && !/\.d\.ts$/u.test(entry.name) ? [join(dir, entry.name)] : []);
  const tree = (): Map<string, string> => new Map(productSources(src).map(file => [relative(src, file).split(sep).join("/"), readFileSync(file, "utf8")]));

  function problems(sources: ReadonlyMap<string, string>): string[] {
    const found: string[] = [];
    for (const [file, text] of sources) {
      if (/\bisHostGitWorkspaceAvailable\b/u.test(text) && !ASKS_THE_HOLD.has(file)) found.push(`${file}: asks the hold apart from the start`);
    }
    for (const [file, text] of sources) {
      if (!HOST_GIT_RESOLUTION.test(text) || file === "shared/host-git-executable.ts") continue;
      // The verified plan only probes the executable version from the installation directory.
      const other = file === "permissions/verified-shell-command.ts"
        ? text.replace(/import \{ execFileSync \} from "node:child_process";/u, "")
          .replace(/execFileSync\(executable, \["--version"\], \{\s*encoding: "utf8", cwd: dirname\(executable\),/u, "")
        : text;
      if ([...other.matchAll(DIRECT_PROCESS_START)].length !== 0) found.push(`${file}: starts a process itself`);
      if (PROCESS_IMPORT.test(other)) found.push(`${file}: imports a process start`);
    }
    if ((sources.get("shared/host-git.ts") ?? "").match(/\bspawn\(/gu)?.length !== 1) found.push("shared/host-git.ts: starts git other than in the one start");
    const shellTools = sources.get("tools/shell-tools.ts") ?? "";
    const hostBash = shellTools.slice(shellTools.indexOf("async function spawnWithTimeout("), shellTools.indexOf("function reportedHostCwd("));
    if (!/const launch = \(\)[\s\S]*?assertPreparedShellAvailable\(prepared\);\s*child = spawn\(shell\.cmd,/u.test(hostBash)) {
      found.push("tools/shell-tools.ts: starts verified Bash without checking the hold at launch");
    }
    return found;
  }

  it("in the tree", () => {
    expect(problems(tree())).toEqual([]);
  });

  it("refuses process starts by newly added consumers of the host Git resolver", () => {
    const sources = tree();
    sources.set("workspace/new-consumer.ts", `
      import { spawn as start } from "node:child_process";
      import { withHostGitRecovery } from "../shared/host-git-executable.js";
      withHostGitRecovery(null, async ({ git }) => start(git.path, args, { cwd }));
    `);
    expect(problems(sources)).toContain("workspace/new-consumer.ts: imports a process start");
  });

  it("refuses a verified Bash launch with the availability check removed", () => {
    const sources = tree();
    const file = "tools/shell-tools.ts";
    sources.set(file, (sources.get(file) ?? "").replace("assertPreparedShellAvailable(prepared);", ""));
    expect(problems(sources)).toContain(`${file}: starts verified Bash without checking the hold at launch`);
  });

  it("refuses a planted start of the resolved git and a planted hold check", () => {
    const sources = tree();
    const planted = new Map(sources);
    planted.set("memory/project-agents-md.ts", `${sources.get("memory/project-agents-md.ts")}\nexecFile(git.path, args);\n`);
    planted.set("work-board/workflow/host-git.ts", `import { spawn } from "node:child_process";\n${sources.get("work-board/workflow/host-git.ts")}\nspawn(git.path, args, {});\n`);
    planted.set("marketplace/git/run-git.ts", `${sources.get("marketplace/git/run-git.ts")}\nisHostGitWorkspaceAvailable(root);\n`);
    expect(problems(planted).sort()).toEqual([
      "marketplace/git/run-git.ts: asks the hold apart from the start",
      "memory/project-agents-md.ts: starts a process itself",
      "work-board/workflow/host-git.ts: imports a process start",
      "work-board/workflow/host-git.ts: starts a process itself",
    ]);
  });
});
