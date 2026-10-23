import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { cleanupAsrtSandboxAfterCommand, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { SANDBOX_GIT_SCAN_DEPTH } from "../sandbox-write-policy.js";

const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const METADATA_PATH_SUFFIXES = [
  { label: "a trailing space", suffix: " " },
  { label: "a trailing tab", suffix: "\t" },
  { label: "a trailing nonbreaking space", suffix: "\u00a0" },
] as const;

describe.skipIf(shouldSkipNativeSandboxTests())("native repository control writes", () => {
  let root: string;
  let monitor: string;
  let trace: string;
  let writes: number;

  function git(cwd: string, ...args: string[]): string {
    const result = spawnSync("git", ["-C", cwd, ...args], { env: gitEnv, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  function repository(path: string, committed = false): void {
    mkdirSync(path, { recursive: true });
    git(path, "init", "--quiet");
    if (committed) git(path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "--quiet", "-m", "seed");
  }

  function proveConfigAttack(checkout: string, config: string): string {
    const original = readFileSync(config, "utf8");
    const attack = `${original}\n[core]\n\tfsmonitor = ${monitor}\n`;
    writeFileSync(config, attack);
    git(checkout, "status", "--porcelain");
    expect(readFileSync(trace, "utf8")).toContain("executed");
    writeFileSync(config, original);
    rmSync(trace);
    return attack;
  }

  async function blockedWrite(target: string, value: string, writeRoots: string[], onWrapped?: () => void): Promise<void> {
    const original = existsSync(target) ? readFileSync(target) : undefined;
    const ordinary = join(writeRoots[0]!, `allowed-${writes++}.txt`);
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: writeRoots[0], approvalSurface: "unavailable" } });
    try {
      const wrapped = await wrapToolCommand('printf allowed > "$NORMAL_TARGET" && mkdir -p "$(dirname "$CONTROL_TARGET")" && printf "%s" "$ATTACK_TEXT" > "$CONTROL_TARGET"', {
        commandId: invocation.token, denyUnixSockets: true,
        filesystem: { allowWrite: writeRoots, denyWrite: [] },
      });
      onWrapped?.();
      const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: writeRoots[0], env: { ...process.env, ...wrapped.env, NORMAL_TARGET: ordinary, CONTROL_TARGET: target, ATTACK_TEXT: value },
        encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      if (result.error) throw result.error;
      expect(result.status, result.stderr).not.toBeNull();
      expect(result.status, result.stderr).not.toBe(71);
      expect(readFileSync(ordinary, "utf8")).toBe("allowed");
      expect(result.status, result.stderr).not.toBe(0);
    } finally {
      invocation.release();
      await cleanupAsrtSandboxAfterCommand();
    }
    // Missing-path mount placeholders must disappear without replacing host data.
    if (original === undefined) expect(existsSync(target)).toBe(false);
    else expect(readFileSync(target)).toEqual(original);
  }

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-git-controls-")));
    monitor = join(root, "monitor.sh");
    trace = join(root, "monitor-executed");
    writes = 0;
    writeFileSync(monitor, `#!/bin/sh\nprintf executed >> ${shellQuote(trace)}\nprintf '\\0'\n`);
    chmodSync(monitor, 0o700);
    await initializeRequiredSandbox({ allowedDomains: [] });
  });
  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("protects a submodule's active configuration and future module controls", async () => {
    const project = join(root, "project");
    const source = join(root, "source");
    repository(project);
    repository(source, true);
    git(project, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", source, "child");
    const config = join(project, ".git", "modules", "child", "config");
    const attack = proveConfigAttack(join(project, "child"), config);
    await blockedWrite(config, attack, [project]);
    await blockedWrite(join(project, ".git", "modules", "future", "config"), attack, [project]);
    await blockedWrite(join(project, ".git", "modules", "future", "hooks", "pre-commit"), "payload", [project]);
    git(join(project, "child"), "status", "--porcelain");
    expect(existsSync(trace)).toBe(false);
  });

  it("keeps an actual linked-worktree pointer from selecting a planted bare configuration", async () => {
    const source = join(root, "source");
    const checkout = join(root, "checkout");
    repository(source, true);
    git(source, "worktree", "add", "--quiet", "--detach", checkout, "HEAD");
    const planted = join(checkout, "planted");
    git(checkout, "init", "--bare", "--quiet", planted);
    git(checkout, "config", "--file", join(planted, "config"), "core.bare", "false");
    git(checkout, "config", "--file", join(planted, "config"), "core.worktree", checkout);
    const marker = join(checkout, ".git");
    const original = readFileSync(marker, "utf8");
    const pointer = `gitdir: ${planted}\n`;
    writeFileSync(marker, pointer);
    proveConfigAttack(checkout, join(planted, "config"));
    writeFileSync(marker, original);
    await blockedWrite(marker, pointer, [checkout]);
    git(checkout, "status", "--porcelain");
    expect(existsSync(trace)).toBe(false);
  });

  it.each(METADATA_PATH_SUFFIXES)("protects a gitdir target with $label under a separate write grant", async ({ suffix }) => {
    const project = join(root, "project");
    const storage = join(root, "storage");
    const metadata = join(storage, `metadata${suffix}`);
    repository(project, true);
    mkdirSync(storage);
    renameSync(join(project, ".git"), metadata);
    writeFileSync(join(project, ".git"), `gitdir: ${metadata}\r\n`);
    const config = join(metadata, "config");
    const attack = proveConfigAttack(project, config);
    await blockedWrite(config, attack, [project, storage]);
    await blockedWrite(join(metadata, "hooks", "pre-commit"), "payload", [project, storage]);
    git(project, "status", "--porcelain");
    expect(existsSync(trace)).toBe(false);
  });

  it.each(METADATA_PATH_SUFFIXES)("protects redirected common metadata with $label and its pointer under separate write grants", async ({ suffix }) => {
    const source = join(root, "source");
    const checkout = join(root, "checkout");
    const common = join(root, `planted-common${suffix}`);
    repository(source, true);
    git(source, "worktree", "add", "--quiet", "--detach", checkout, "HEAD");
    git(source, "clone", "--bare", "--quiet", source, common);
    git(source, "config", "--file", join(common, "config"), "core.bare", "false");
    const gitDir = resolve(checkout, readFileSync(join(checkout, ".git"), "utf8").trim().slice("gitdir: ".length));
    const commonPointer = join(gitDir, "commondir");
    writeFileSync(commonPointer, `${common}\r\n`);
    const config = join(common, "config");
    const attack = proveConfigAttack(checkout, config);
    await blockedWrite(config, attack, [checkout, common, gitDir]);
    await blockedWrite(commonPointer, `${source}\n`, [checkout, common, gitDir]);
    await blockedWrite(join(common, "modules", "future", "config"), attack, [checkout, common, gitDir]);
    git(checkout, "status", "--porcelain");
    expect(existsSync(trace)).toBe(false);
  });

  it("protects nested repositories at the inclusive discovery depth and allows ordinary writes", async () => {
    const project = join(root, "project");
    const nested = join(project, ...Array.from({ length: SANDBOX_GIT_SCAN_DEPTH }, (_, i) => `level-${i}`));
    repository(nested);
    const config = join(nested, ".git", "config");
    const attack = proveConfigAttack(nested, config);
    await blockedWrite(config, attack, [project]);
    await blockedWrite(join(nested, ".git", "hooks", "pre-commit"), "payload", [project]);
    git(nested, "status", "--porcelain");
    expect(existsSync(trace)).toBe(false);
    if (process.platform === "darwin") {
      const future = join(nested, "below", "future", ".GIT", "config");
      await blockedWrite(future, attack, [project], () => mkdirSync(join(nested, "below", "future"), { recursive: true }));
    }
  });

  it("blocks creation of an absent root marker without leaving mount placeholders", async () => {
    const project = join(root, "project");
    mkdirSync(project);
    await blockedWrite(join(project, ".git"), "gitdir: planted\n", [project]);
    await blockedWrite(join(project, ".git", "modules", "future", "config"), "payload", [project]);
  });

  it("protects absent literal gitdir and common-directory targets containing pattern characters", async () => {
    const project = join(root, "project");
    const storage = join(root, "storage");
    const gitDir = join(storage, "metadata-[*?]-absent");
    mkdirSync(project);
    mkdirSync(storage);
    writeFileSync(join(project, ".git"), `gitdir: ${gitDir}\n`);
    await blockedWrite(join(gitDir, "config"), "[core]\nfsmonitor = payload\n", [project, storage]);
    rmSync(join(project, ".git"));
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".git", "commondir"), `${gitDir}\n`);
    await blockedWrite(join(gitDir, "config"), "[core]\nfsmonitor = payload\n", [project, storage]);
  });
});
