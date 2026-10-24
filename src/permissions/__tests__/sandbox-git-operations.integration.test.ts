import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { annotateWithSandboxViolations, cleanupAsrtSandboxAfterCommand, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { SANDBOX_GIT_SCAN_DEPTH } from "../sandbox-write-policy.js";
import { getLocale, setLocale } from "../../i18n/index.js";
import { isHostGitWorkspaceAvailable } from "../../shared/host-git.js";

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const GIT_IDENTITY = "-c user.name=Fixture -c user.email=fixture@example.invalid";
const PROTECTED_METADATA_FILES = [
  "hooks/pre-commit", "config", "config.worktree", "commondir", "gitdir",
  "modules/child/hooks/pre-commit", "modules/child/config", "modules/child/config.worktree",
  "modules/child/modules/grandchild/hooks/pre-commit", "modules/child/modules/grandchild/config",
  "modules/child/modules/grandchild/config.worktree", "worktrees/linked/config.worktree",
  "worktrees/linked/commondir", "worktrees/linked/gitdir",
  "objects/info/alternates", "objects/info/http-alternates", "remotes/origin", "branches/origin",
  ...(process.platform === "linux" ? ["info/attributes"] : []),
] as const;
const REPOSITORY_DEPTHS = process.platform === "darwin" ? [0, 1, 4] : [0, 1, SANDBOX_GIT_SCAN_DEPTH];
const DEEP_MARKER_LOCATIONS = ["nested", "node_modules", "build"] as const;

describe.skipIf(shouldSkipNativeSandboxTests())("native repository metadata operations", () => {
  let root: string;
  let previousLocale: ReturnType<typeof getLocale>;

  function hostGit(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", ["-C", cwd, ...args], { env: gitEnv, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  function repository(path: string): void {
    mkdirSync(path, { recursive: true });
    hostGit(path, "init", "--quiet");
    writeFileSync(join(path, "tracked.txt"), "seed\n");
    hostGit(path, "add", "tracked.txt");
    hostGit(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "seed");
  }

  async function execute(command: string, cwd = root, writeRoots = [root], onPrepared?: () => void): Promise<{ status: number | null; output: string }> {
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: cwd, approvalSurface: "unavailable" } });
    try {
      const wrapped = await wrapToolCommand(command, {
        commandId: invocation.token, denyUnixSockets: true,
        filesystem: { allowWrite: writeRoots, denyWrite: [] },
      });
      onPrepared?.();
      const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd, env: { ...gitEnv, ...wrapped.env }, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      if (result.error) throw result.error;
      expect(result.status, result.stderr).not.toBeNull();
      expect(result.status, result.stderr).not.toBe(71);
      invocation.release();
      const outcome = await wrapped.cleanupCompleted;
      expect(outcome?.failure, outcome?.failure).toBeUndefined();
      const output = await annotateWithSandboxViolations(invocation.token, `${result.stdout}\n${result.stderr}`, command,
        [...(wrapped.notices ?? []), ...(outcome?.notice ? [outcome.notice] : [])]);
      return { status: result.status, output };
    } finally {
      invocation.release();
      await cleanupAsrtSandboxAfterCommand();
    }
  }

  beforeEach(async () => {
    previousLocale = getLocale();
    setLocale("en");
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-git-operations-")));
    await initializeRequiredSandbox({ allowedDomains: [] });
  });
  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    rmSync(root, { recursive: true, force: true });
    setLocale(previousLocale);
  });

  it("allows commit, branch and stash writes in an existing repository", async () => {
    repository(root);
    const result = await execute(`printf '*.txt text\n' > .git/info/attributes && printf committed >> tracked.txt && git add tracked.txt && git ${GIT_IDENTITY} commit --quiet -m sandbox && git branch sandbox-branch && printf stashed >> tracked.txt && git ${GIT_IDENTITY} stash push --quiet -m sandbox-stash`);
    expect(result.status, result.output).toBe(0);
    expect(hostGit(root, "log", "-1", "--format=%s")).toBe("sandbox");
    expect(hostGit(root, "branch", "--list", "sandbox-branch")).toContain("sandbox-branch");
    expect(hostGit(root, "stash", "list")).toContain("sandbox-stash");
    expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("seed\ncommitted");
    if (process.platform === "linux") {
      expect(existsSync(join(root, ".git", "info", "attributes"))).toBe(false);
      expect(result.output).toContain(JSON.stringify(join(root, ".git", "info", "attributes")));
    } else expect(readFileSync(join(root, ".git", "info", "attributes"), "utf8")).toBe("*.txt text\n");
    expect(hostGit(root, "status", "--porcelain")).toBe("");
  });

  it("allows a merge commit and its transient metadata in an existing repository", async () => {
    repository(root);
    const initialBranch = hostGit(root, "symbolic-ref", "--short", "HEAD");
    const result = await execute(`git checkout --quiet -b sandbox-feature && printf feature > feature.txt && git add feature.txt && git ${GIT_IDENTITY} commit --quiet -m feature && git checkout --quiet ${shellQuote(initialBranch)} && printf main > main.txt && git add main.txt && git ${GIT_IDENTITY} commit --quiet -m main && git ${GIT_IDENTITY} merge --no-ff --quiet -m merged sandbox-feature`);
    expect(result.status, result.output).toBe(0);
    expect(hostGit(root, "log", "-1", "--format=%s")).toBe("merged");
    expect(hostGit(root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(readFileSync(join(root, "feature.txt"), "utf8")).toBe("feature");
    expect(readFileSync(join(root, "main.txt"), "utf8")).toBe("main");
    expect(hostGit(root, "status", "--porcelain")).toBe("");
    expect(existsSync(join(root, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("allows a linked-worktree commit when its checkout and shared metadata are already granted", async () => {
    const source = join(root, "source");
    const checkout = join(root, "checkout");
    repository(source);
    hostGit(source, "worktree", "add", "--quiet", "--detach", checkout, "HEAD");
    const sharedMetadata = join(source, ".git");
    const pointer = readFileSync(join(checkout, ".git"));
    const config = readFileSync(join(sharedMetadata, "config"));
    const result = await execute(`printf linked >> tracked.txt && git add tracked.txt && git ${GIT_IDENTITY} commit --quiet -m linked`, checkout, [checkout, sharedMetadata]);
    expect(result.status, result.output).toBe(0);
    expect(hostGit(checkout, "log", "-1", "--format=%s")).toBe("linked");
    expect(hostGit(source, "log", "-1", "--format=%s")).toBe("seed");
    expect(hostGit(checkout, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(checkout, ".git"))).toEqual(pointer);
    expect(readFileSync(join(sharedMetadata, "config"))).toEqual(config);
  });

  it.each(["init", "clone"])("applies platform metadata protection to git %s", async (operation) => {
    const source = join(root, "source");
    const target = join(root, "target");
    repository(source);
    mkdirSync(target);
    const linuxClone = process.platform === "linux" && operation === "clone";
    const command = operation === "init" ? "git init --quiet"
      : `git -c protocol.file.allow=always clone --quiet --local ${shellQuote(source)} ${linuxClone ? shellQuote(target) : "."}`;
    const result = await execute(command, linuxClone ? root : target, linuxClone ? [root] : [target]);
    if (process.platform === "linux") {
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("moved to quarantine (not deleted)");
      expect(result.output).toContain(JSON.stringify(join(target, ".git")));
    } else {
      expect(result.status, result.output).not.toBe(0);
      expect(result.output).toContain("`.git` metadata is protected; rerun outside the sandbox after approval");
    }
    expect(existsSync(join(target, ".git"))).toBe(false);
  });

  it.runIf(process.platform === "linux")("keeps absent commondir ENOENT while status, add, commit and branch run", async () => {
    repository(root);
    const commondir = join(root, ".git", "commondir");
    const absent = (): void => { expect(() => lstatSync(commondir)).toThrow(/ENOENT/); };
    absent();
    const result = await execute(`test ! -e .git/commondir && git status --porcelain && printf committed >> tracked.txt && git add tracked.txt && git ${GIT_IDENTITY} commit --quiet -m missing-control && git branch missing-control-branch && test ! -e .git/commondir`, root, [root], () => {
      absent();
      expect(isHostGitWorkspaceAvailable(root)).toBe(false);
    });
    expect(result.status, result.output).toBe(0);
    absent();
    expect(isHostGitWorkspaceAvailable(root)).toBe(true);
    expect(hostGit(root, "log", "-1", "--format=%s")).toBe("missing-control");
    expect(hostGit(root, "branch", "--list", "missing-control-branch")).toContain("missing-control-branch");
  });

  it.runIf(process.platform === "linux").each(["commondir", "gitdir", "config.worktree", "hooks/pre-commit", "info/attributes"])("quarantines new %s after command exit with restore notice", async entry => {
    repository(root);
    if (entry.startsWith("hooks/")) rmSync(join(root, ".git", "hooks"), { recursive: true, force: true });
    const path = join(root, ".git", entry);
    const original = entry.startsWith("hooks/") ? dirname(path) : path;
    const payload = "created during command";
    const result = await execute(`mkdir -p ${shellQuote(dirname(path))} && printf %s ${shellQuote(payload)} > ${shellQuote(path)}`);
    expect(result.status, result.output).toBe(0);
    expect(existsSync(original)).toBe(false);
    const prefix = `${JSON.stringify(original)} -> `;
    const move = result.output.split("\n").find(line => line.startsWith(prefix));
    expect(move, result.output).toBeDefined();
    const destination = JSON.parse(move!.slice(prefix.length)) as string;
    expect(readFileSync(entry.startsWith("hooks/") ? join(destination, "pre-commit") : destination, "utf8")).toBe(payload);
    expect(result.output).toContain("Restore each entry");
  });

  it.runIf(process.platform === "linux")("quarantines a new control symlink without following its target", async () => {
    repository(root);
    const untouched = join(root, "untouched");
    writeFileSync(untouched, "original");
    const control = join(root, ".git", "commondir");
    const result = await execute(`ln -s ${shellQuote(untouched)} ${shellQuote(control)}`);
    expect(result.status, result.output).toBe(0);
    const prefix = `${JSON.stringify(control)} -> `;
    const move = result.output.split("\n").find(line => line.startsWith(prefix));
    expect(move, result.output).toBeDefined();
    const destination = JSON.parse(move!.slice(prefix.length)) as string;
    expect(lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(readlinkSync(destination)).toBe(untouched);
    expect(readFileSync(untouched, "utf8")).toBe("original");
    expect(existsSync(control)).toBe(false);
  });

  it.each(REPOSITORY_DEPTHS)("denies each repository control at depth %i while ordinary metadata stays writable", async (depth) => {
    const project = join(root, ...Array.from({ length: depth }, (_, index) => `level-${index}`));
    repository(project);
    const metadata = join(project, ".git");
    const checkout = join(root, "fixture-worktrees", "linked");
    mkdirSync(dirname(checkout));
    hostGit(project, "worktree", "add", "--quiet", "--detach", checkout, "HEAD");
    expect(readFileSync(join(checkout, ".git"), "utf8").trim()).toBe(`gitdir: ${join(metadata, "worktrees", "linked")}`);
    for (const entry of PROTECTED_METADATA_FILES) {
      const path = join(metadata, entry);
      mkdirSync(dirname(path), { recursive: true });
      if (!existsSync(path)) writeFileSync(path, entry === "commondir" ? ".\n" : entry.endsWith("/commondir") ? "../..\n" : "original\n");
    }
    for (const directory of ["modules/child", "modules/child/modules/grandchild"]) {
      writeFileSync(join(metadata, directory, "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(metadata, directory, "objects"));
    }
    for (const entry of PROTECTED_METADATA_FILES) {
      const target = join(metadata, entry);
      const original = readFileSync(target);
      const ordinaryPaths = ["objects/ordinary-write", "modules/child/objects/ordinary-write",
        "modules/child/modules/grandchild/objects/ordinary-write", "worktrees/linked/index"].map(path => join(metadata, path));
      const ordinaryWrites = ordinaryPaths.map(path => `printf ordinary > ${shellQuote(path)}`).join(" && ");
      const result = await execute(`${ordinaryWrites} && printf changed >> ${shellQuote(target)}`);
      expect(result.status, `${entry}: ${result.output}`).not.toBe(0);
      for (const path of ordinaryPaths) {
        expect(existsSync(path), `${entry}: ordinary write missing at ${path}\n${result.output}`).toBe(true);
        expect(readFileSync(path, "utf8"), entry).toBe("ordinary");
      }
      expect(readFileSync(target), entry).toEqual(original);
    }
  });

  it.runIf(process.platform === "linux")("discovers a repository added between commands in the same sandbox session", async () => {
    const first = await execute("printf first > ordinary.txt");
    expect(first.status, first.output).toBe(0);
    const nested = join(root, "appeared");
    repository(nested);
    const config = join(nested, ".git", "config");
    const original = readFileSync(config);
    const second = await execute(`printf second >> ordinary.txt && printf injected >> ${shellQuote(config)}`);
    expect(second.status, second.output).not.toBe(0);
    expect(readFileSync(join(root, "ordinary.txt"), "utf8")).toBe("firstsecond");
    expect(readFileSync(config)).toEqual(original);
  });

  it.each(REPOSITORY_DEPTHS)("protects a linked-worktree pointer file at depth %i", async (depth) => {
    const source = join(root, "source");
    const writeRoot = join(root, "grant");
    const checkout = join(writeRoot, ...Array.from({ length: depth }, (_, index) => `level-${index}`));
    repository(source);
    mkdirSync(dirname(checkout), { recursive: true });
    hostGit(source, "worktree", "add", "--quiet", "--detach", checkout, "HEAD");
    const marker = join(checkout, ".git");
    const original = readFileSync(marker);
    const ordinary = join(checkout, "ordinary.txt");
    const result = await execute(`printf ordinary > ${shellQuote(ordinary)} && printf injected >> ${shellQuote(marker)}`, checkout, [writeRoot]);
    expect(result.status, result.output).not.toBe(0);
    expect(readFileSync(ordinary, "utf8")).toBe("ordinary");
    expect(readFileSync(marker)).toEqual(original);
  });

  it.runIf(process.platform === "darwin").each(DEEP_MARKER_LOCATIONS)("refuses a deep symbolic repository marker beneath %s before command execution", async (location) => {
    const source = join(root, "source");
    const grant = join(root, "grant");
    const admitted = join(root, "admitted");
    const metadata = join(admitted, "metadata");
    const project = join(grant, location, "level-1", "level-2", "level-3");
    repository(source);
    mkdirSync(admitted);
    renameSync(join(source, ".git"), metadata);
    mkdirSync(project, { recursive: true });
    symlinkSync(metadata, join(project, ".git"), "dir");
    writeFileSync(join(metadata, "hooks", "pre-commit"), "original\n");
    const config = readFileSync(join(metadata, "config"));
    const ordinary = join(grant, "command-started");
    await expect(execute(`printf started > ${shellQuote(ordinary)} && printf injected >> ${shellQuote(join(project, ".git", "config"))} && printf injected >> ${shellQuote(join(project, ".git", "hooks", "pre-commit"))}`, grant, [grant, admitted]))
      .rejects.toThrow("Linked sandbox Git markers are unsupported");
    expect(existsSync(ordinary)).toBe(false);
    expect(readFileSync(join(metadata, "config"))).toEqual(config);
    expect(readFileSync(join(metadata, "hooks", "pre-commit"), "utf8")).toBe("original\n");
  });

  it.runIf(process.platform === "darwin").each(DEEP_MARKER_LOCATIONS)("protects a deep regular repository pointer target beneath %s while objects stay writable", async (location) => {
    const source = join(root, "source");
    const grant = join(root, "grant");
    const admitted = join(root, "admitted");
    const metadata = join(admitted, "metadata");
    const project = join(grant, location, "level-1", "level-2", "level-3");
    repository(source);
    mkdirSync(admitted);
    renameSync(join(source, ".git"), metadata);
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, ".git"), `gitdir: ${metadata}\n`);
    writeFileSync(join(metadata, "hooks", "pre-commit"), "original\n");
    for (const entry of ["config", "hooks/pre-commit"]) {
      const target = join(metadata, entry);
      const original = readFileSync(target);
      const ordinary = join(metadata, "objects", "ordinary-write");
      const result = await execute(`printf ordinary > ${shellQuote(ordinary)} && printf injected >> ${shellQuote(target)}`, grant, [grant, admitted]);
      expect(result.status, `${entry}: ${result.output}`).not.toBe(0);
      expect(readFileSync(ordinary, "utf8")).toBe("ordinary");
      expect(readFileSync(target)).toEqual(original);
    }
  });

  it.runIf(process.platform === "darwin")("denies a new nested hook created after the wrapper is prepared", async () => {
    repository(root);
    const result = await execute("mkdir -p x/.git/hooks && printf payload > x/.git/hooks/pre-commit");
    expect(result.status, result.output).not.toBe(0);
    expect(existsSync(join(root, "x", ".git", "hooks", "pre-commit"))).toBe(false);
  });

  it.runIf(process.platform === "darwin")("denies a bare repository layout in a non-repository write root", async () => {
    for (const entry of ["HEAD", "objects", "refs", "config"] as const) {
      const target = join(root, entry);
      const result = await execute(entry === "objects" || entry === "refs"
        ? `mkdir ${shellQuote(target)}` : `printf payload > ${shellQuote(target)}`);
      expect(result.status, `${entry}: ${result.output}`).not.toBe(0);
      expect(existsSync(target), entry).toBe(false);
    }
  });

  it.runIf(process.platform === "darwin")("protects hooks beside an existing bare-layout HEAD", async () => {
    writeFileSync(join(root, "HEAD"), "ref: refs/heads/main\n");
    const result = await execute("mkdir -p hooks && printf payload > hooks/pre-commit");
    expect(result.status, result.output).not.toBe(0);
    expect(existsSync(join(root, "hooks", "pre-commit"))).toBe(false);
    expect(readFileSync(join(root, "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  });
});
