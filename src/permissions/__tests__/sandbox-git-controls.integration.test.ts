import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { getLocale, setLocale } from "../../i18n/index.js";
import { annotateWithSandboxViolations, cleanupAsrtSandboxAfterCommand, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
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
  let previousLocale: ReturnType<typeof getLocale>;

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

  async function blockedWrite(target: string, value: string, writeRoots: string[], onWrapped?: () => void, prepareCommand?: string, expectation?: {
    linuxQuarantinePath: string;
    quarantinedSymlinkTarget?: string;
    linuxTargetWriteAllowed?: true;
  }): Promise<void> {
    const original = existsSync(target) ? readFileSync(target) : undefined;
    const ordinary = join(writeRoots[0]!, `allowed-${writes++}.txt`);
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: writeRoots[0], approvalSurface: "unavailable" } });
    try {
      const linuxQuarantine = process.platform === "linux" ? expectation : undefined;
      const command = `printf allowed > "$NORMAL_TARGET" && ${prepareCommand ? `${prepareCommand} && ` : ""}mkdir -p "$(dirname "$CONTROL_TARGET")" && printf "%s" "$ATTACK_TEXT" > "$CONTROL_TARGET"`;
      const wrapped = await wrapToolCommand(command, {
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
      invocation.release();
      if (process.platform === "linux") expect(wrapped.cleanupCompleted).toBeDefined();
      const outcome = await wrapped.cleanupCompleted;
      expect(outcome?.failure, outcome?.failure).toBeUndefined();
      const output = await annotateWithSandboxViolations(invocation.token, `${result.stdout}\n${result.stderr}`, command,
        [...(wrapped.notices ?? []), ...(outcome?.notice ? [outcome.notice] : [])]);
      if (linuxQuarantine) {
        expect(result.status, output).toBe(0);
        expect(existsSync(linuxQuarantine.linuxQuarantinePath)).toBe(false);
        expect(output).toContain("moved to quarantine (not deleted)");
        expect(output).toContain("Restore each entry");
        const prefix = `${JSON.stringify(linuxQuarantine.linuxQuarantinePath)} -> `;
        const move = output.split("\n").find(line => line.startsWith(prefix));
        expect(move, output).toBeDefined();
        const destination = JSON.parse(move!.slice(prefix.length)) as string;
        if (linuxQuarantine.quarantinedSymlinkTarget) {
          expect(lstatSync(destination).isSymbolicLink()).toBe(true);
          expect(readlinkSync(destination)).toBe(linuxQuarantine.quarantinedSymlinkTarget);
        } else {
          expect(readFileSync(join(destination, relative(linuxQuarantine.linuxQuarantinePath, target)), "utf8")).toBe(value);
        }
      } else expect(result.status, output).not.toBe(0);
    } finally {
      invocation.release();
      await cleanupAsrtSandboxAfterCommand();
    }
    // Quarantine preserves allowed writes through a new route without following it.
    if (original === undefined) expect(existsSync(target)).toBe(false);
    else if (process.platform === "linux" && expectation?.linuxTargetWriteAllowed) expect(readFileSync(target, "utf8")).toBe(value);
    else expect(readFileSync(target)).toEqual(original);
  }

  beforeEach(async () => {
    previousLocale = getLocale();
    setLocale("en");
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
    setLocale(previousLocale);
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
    // Newly discovered module directories receive controls on the next wrap.
    mkdirSync(join(project, ".git", "modules", "future"));
    writeFileSync(join(project, ".git", "modules", "future", "HEAD"), "ref: refs/heads/main\n");
    await blockedWrite(join(project, ".git", "modules", "future", "config"), attack, [project], undefined, undefined,
      { linuxQuarantinePath: join(project, ".git", "modules", "future", "config") });
    await blockedWrite(join(project, ".git", "modules", "future", "hooks", "pre-commit"), "payload", [project], undefined, undefined,
      { linuxQuarantinePath: join(project, ".git", "modules", "future", "hooks") });
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
    const storage = join(root, "storage");
    const physical = join(storage, "physical");
    const common = join(physical, `planted-common${suffix}`);
    mkdirSync(join(physical, "deep"), { recursive: true });
    const route = join(storage, "route");
    symlinkSync(join(physical, "deep"), route, "dir");
    repository(source, true);
    git(source, "worktree", "add", "--quiet", "--detach", checkout, "HEAD");
    git(source, "clone", "--bare", "--quiet", source, common);
    git(source, "config", "--file", join(common, "config"), "core.bare", "false");
    const gitDir = resolve(checkout, readFileSync(join(checkout, ".git"), "utf8").trim().slice("gitdir: ".length));
    const commonPointer = join(gitDir, "commondir");
    writeFileSync(commonPointer, `${route}/../planted-common${suffix}\r\n`);
    const config = join(common, "config");
    const attack = proveConfigAttack(checkout, config);
    await blockedWrite(config, attack, [checkout, common, gitDir]);
    await blockedWrite(commonPointer, `${source}\n`, [checkout, common, gitDir]);
    mkdirSync(join(common, "modules", "future"), { recursive: true });
    writeFileSync(join(common, "modules", "future", "HEAD"), "ref: refs/heads/main\n");
    await blockedWrite(join(common, "modules", "future", "config"), attack, [checkout, common, gitDir], undefined, undefined,
      { linuxQuarantinePath: join(common, "modules", "future", "config") });
    git(checkout, "status", "--porcelain");
    expect(existsSync(trace)).toBe(false);
  });

  it("resolves gitdir parent components after following directory links", async () => {
    const project = join(root, "project");
    const storage = join(root, "storage");
    const physical = join(storage, "physical");
    const metadata = join(physical, "metadata");
    repository(project, true);
    mkdirSync(join(physical, "deep"), { recursive: true });
    const route = join(storage, "route");
    symlinkSync(join(physical, "deep"), route, "dir");
    renameSync(join(project, ".git"), metadata);
    writeFileSync(join(project, ".git"), `gitdir: ${route}/../metadata\n`);
    const config = join(metadata, "config");
    const attack = proveConfigAttack(project, config);
    await blockedWrite(config, attack, [project, storage]);
    const otherParent = join(storage, "other");
    const otherMetadata = join(otherParent, "metadata");
    mkdirSync(join(otherParent, "deep"), { recursive: true });
    cpSync(metadata, otherMetadata, { recursive: true });
    rmSync(route);
    symlinkSync(join(otherParent, "deep"), route, "dir");
    const alternateAttack = proveConfigAttack(project, join(otherMetadata, "config"));
    rmSync(route);
    symlinkSync(join(physical, "deep"), route, "dir");
    const ordinaryLink = join(project, "ordinary-link");
    const linkControl = join(project, "ordinary-link-worked");
    const prepare = `ln -s ${shellQuote(otherParent)} ${shellQuote(ordinaryLink)} && rm ${shellQuote(ordinaryLink)} && printf allowed > ${shellQuote(linkControl)} && rm ${shellQuote(route)} && ln -s ${shellQuote(join(otherParent, "deep"))} ${shellQuote(route)}`;
    await blockedWrite(join(otherMetadata, "config"), alternateAttack, [project, storage], undefined, prepare);
    expect(readFileSync(linkControl, "utf8"), "ordinary checkout symlink creation and removal must remain allowed").toBe("allowed");
    expect(realpathSync(route), "the metadata routing link must retain its original target").toBe(join(physical, "deep"));
    git(project, "status", "--porcelain");
    expect(existsSync(trace)).toBe(false);
  });

  it("keeps literal backslashes in the admitted workspace identity", async () => {
    const project = join(root, "project\\component");
    const sibling = join(root, "project", "component");
    mkdirSync(project);
    mkdirSync(sibling, { recursive: true });
    await blockedWrite(join(sibling, "escaped.txt"), "payload", [project]);
  });

  it.runIf(process.platform === "linux")("keeps distinct Unicode workspace spellings separate", async () => {
    const project = join(root, "project-e\u0301");
    const sibling = join(root, "project-\u00e9");
    mkdirSync(project);
    mkdirSync(sibling);
    expect(lstatSync(project).ino, "the fixture directories must be distinct physical objects").not.toBe(lstatSync(sibling).ino);
    await blockedWrite(join(sibling, "escaped.txt"), "payload", [project]);
  });

  it.each(["gitdir", "commondir"])("blocks or quarantines a new ancestor link for a future %s target", async (kind) => {
    const project = join(root, "project");
    const storage = join(root, "storage");
    const actualParent = join(storage, "actual");
    const metadata = join(actualParent, "metadata");
    const route = join(storage, "future");
    const allowedLink = join(storage, "ordinary-link");
    repository(project, true);
    mkdirSync(actualParent, { recursive: true });
    if (kind === "gitdir") {
      renameSync(join(project, ".git"), metadata);
      writeFileSync(join(project, ".git"), `gitdir: ${route}/metadata\n`);
    } else {
      git(project, "clone", "--bare", "--quiet", project, metadata);
      git(project, "config", "--file", join(metadata, "config"), "core.bare", "false");
      writeFileSync(join(project, ".git", "commondir"), `${route}/metadata\n`);
    }
    symlinkSync(actualParent, route, "dir");
    const config = join(metadata, "config");
    const attack = proveConfigAttack(project, config);
    rmSync(route);
    const originalConfig = readFileSync(config);
    const configIdentity = lstatSync(config);
    const prepare = `ln -s ${shellQuote(actualParent)} ${shellQuote(allowedLink)} && ln -s ${shellQuote(actualParent)} ${shellQuote(route)}`;
    await blockedWrite(config, attack, [project, storage], undefined, prepare, {
      linuxQuarantinePath: route,
      quarantinedSymlinkTarget: actualParent,
      linuxTargetWriteAllowed: true,
    });
    expect(lstatSync(config).ino, "quarantine must move the route link, not its physical target").toBe(configIdentity.ino);
    if (process.platform === "linux") writeFileSync(config, originalConfig);
    expect(lstatSync(allowedLink).isSymbolicLink(), "ordinary symlink creation must remain allowed").toBe(true);
    expect(existsSync(route), "the missing metadata route must be blocked or quarantined after exit").toBe(false);
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

  it("protects an absent root marker without leaving mount placeholders", async () => {
    const project = join(root, "project");
    mkdirSync(project);
    await blockedWrite(join(project, ".git"), "gitdir: planted\n", [project], undefined, undefined,
      { linuxQuarantinePath: join(project, ".git") });
    await blockedWrite(join(project, ".git", "modules", "future", "config"), "payload", [project], undefined, undefined,
      { linuxQuarantinePath: join(project, ".git") });
  });

  it("protects absent literal gitdir and common-directory targets containing pattern characters", async () => {
    const project = join(root, "project");
    const storage = join(root, "storage");
    const gitDir = join(storage, "metadata-[*?]-absent");
    mkdirSync(project);
    mkdirSync(storage);
    writeFileSync(join(project, ".git"), `gitdir: ${gitDir}\n`);
    await blockedWrite(join(gitDir, "config"), "[core]\nfsmonitor = payload\n", [project, storage], undefined, undefined,
      { linuxQuarantinePath: gitDir });
    rmSync(join(project, ".git"));
    mkdirSync(join(project, ".git"));
    writeFileSync(join(project, ".git", "commondir"), `${gitDir}\n`);
    await blockedWrite(join(gitDir, "config"), "[core]\nfsmonitor = payload\n", [project, storage], undefined, undefined,
      { linuxQuarantinePath: gitDir });
  });
});
