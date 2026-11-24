import { stabilizeFixtureAncestorStats } from "../../__tests__/support/fixture-ancestor-stats.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { configureHostResources } from "../../main/host-resources.js";
import { resolveWindowsPathKindHelper } from "../../main/windows-path-kind-launcher.js";
import { GIT_VERSION_FLOOR, isSupportedGitVersion, readOnlyGitArguments, gitReadOnlyEnvironment } from "../rules/git-readonly-argv.js";
import { inspectGitRepository } from "../rules/git-repository-inputs.js";

vi.mock("node:fs", { spy: true });

interface NativeGitEngine {
  readonly version: string;
  readonly admissible: boolean;
}

/**
 * Classify the engine by its numeric version. Git for Windows reports
 * "X.Y.Z.windows.N", which the product's strict upstream-format probe refuses
 * outright, so branching on that probe would turn every Windows control into a
 * refusal assertion even on an engine at or above the floor.
 */
function classifyNativeGit(output: string): NativeGitEngine {
  const match = /^git version (\d+)\.(\d+)\.(\d+)(?:\.windows\.\d+)?\r?\n?$/.exec(output);
  if (match === null) throw new Error(`Unrecognized native Git version output: ${JSON.stringify(output)}`);
  const [major, minor, patch] = match.slice(1).map(Number) as [number, number, number];
  return {
    version: `${major}.${minor}.${patch}`,
    admissible: major === GIT_VERSION_FLOOR.major && minor >= GIT_VERSION_FLOOR.minor,
  };
}

/** Below the floor the product refuses the engine before any guarded execution. */
function assertEngineRefused(engine: NativeGitEngine): void {
  expect(engine.admissible).toBe(false);
  expect(isSupportedGitVersion(`git version ${engine.version}\n`)).toBe(false);
}

const NATIVE_GIT = classifyNativeGit(spawnSync("git", ["--version"], { encoding: "utf8" }).stdout);
const branches = { positive: 0, belowFloor: 0 };

/** Controls prove the owned recipe on an admissible engine; an older engine must prove its refusal instead. */
function control<Arguments extends unknown[]>(body: (...args: Arguments) => void | Promise<void>): (...args: Arguments) => void | Promise<void> {
  return (...args) => {
    if (!NATIVE_GIT.admissible) {
      branches.belowFloor += 1;
      assertEngineRefused(NATIVE_GIT);
      return;
    }
    branches.positive += 1;
    return body(...args);
  };
}

const FIXTURE_MAINTENANCE_OFF = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "maintenance.auto", GIT_CONFIG_VALUE_0: "false" } as const;

let root: string;
let cwd: string;
let environment: Record<string, string>;

beforeAll(() => {
  // Windows evidence pins every inspected path through the shipped native helper;
  // a missing helper must fail here, not as an inspector refusal in every case.
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  if (process.platform === "win32") resolveWindowsPathKindHelper();
});

beforeEach(() => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  root = realpathSync(mkdtempSync(join(tmpdir(), "git-read-controls-")));
  stabilizeFixtureAncestorStats(root);
  const home = join(root, "home");
  cwd = join(root, "workspace");
  mkdirSync(home);
  mkdirSync(cwd);
  environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined
    && !/^GIT_|^(?:HOME|XDG_CONFIG_HOME|EMAIL)$/i.test(entry[0])));
  Object.assign(environment, {
    HOME: home, XDG_CONFIG_HOME: home, LANG: "C", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Boundary Author", GIT_AUTHOR_EMAIL: "author@example.invalid",
    GIT_COMMITTER_NAME: "Boundary Author", GIT_COMMITTER_EMAIL: "author@example.invalid",
    // Fixture commits would otherwise start a detached auto-maintenance child
    // whose lock file churn in .git/objects races the checked inspection.
    ...FIXTURE_MAINTENANCE_OFF,
  });
  succeed(native(["init", "--initial-branch=main"]));
  writeFileSync(join(cwd, "alpha.txt"), "base\n");
  writeFileSync(join(cwd, "zeta.txt"), "base\n");
  succeed(native(["add", "."]));
  succeed(native(["-c", "commit.gpgSign=false", "commit", "-m", "first subject"]));
  writeFileSync(join(cwd, "alpha.txt"), "changed\n");
  writeFileSync(join(cwd, "zeta.txt"), "changed\n");
  succeed(native(["add", "."]));
  succeed(native(["-c", "commit.gpgSign=false", "commit", "-m", "second subject"]));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(root);
});

function native(args: readonly string[], extra: Record<string, string> = {}, input?: string) {
  return spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8", env: { ...environment, ...extra }, input, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
}

function succeed(result: ReturnType<typeof native>): string {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function configure(key: string, value: string): void {
  succeed(native(["config", "--local", key, value]));
}

function shellPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function script(name: string, body = 'printf "executed\\n" > "$CONTROL_MARKER"'): { helper: string; marker: string } {
  const helper = join(root, name);
  const marker = join(root, name + ".marker");
  writeFileSync(helper, `#!/bin/sh\n${body}\n`);
  chmodSync(helper, 0o755);
  // Git runs configured helpers through sh, which drops unquoted Windows backslashes.
  return { helper: shellPath(helper), marker };
}

function checked(args: readonly string[]) {
  const repository = inspectGitRepository(cwd);
  expect(repository).toEqual(expect.objectContaining({ gitDirectory: join(cwd, ".git"), workTree: cwd, referenceBackend: "files" }));
  const ownedArgs = readOnlyGitArguments(["git", ...args]);
  expect(ownedArgs).not.toBeNull();
  return { repository: repository!, ownedArgs: ownedArgs! };
}

function guarded(plan: ReturnType<typeof checked>, extra: Record<string, string> = {}) {
  const invocation = guardedInvocation(plan, extra);
  const before = metadataState();
  const result = spawnSync("git", invocation.args, {
    cwd, encoding: "utf8", env: invocation.env, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  expect(metadataState()).toEqual(before);
  expect(existsSync(invocation.env.GIT_INDEX_FILE!)).toBe(false);
  return result;
}

function metadataState(directory = join(cwd, ".git")): Record<string, string> {
  const directoryStat = lstatSync(directory, { bigint: true });
  return {
    [directory]: `directory:${directoryStat.mtimeNs}:${directoryStat.ctimeNs}`,
    ...Object.fromEntries(readdirSync(directory, { withFileTypes: true }).flatMap((entry): [string, string][] => {
      const path = join(directory, entry.name);
      const stat = lstatSync(path, { bigint: true });
      return entry.isDirectory() ? Object.entries(metadataState(path)) : [[path,
        `${stat.mtimeNs}:${stat.ctimeNs}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`]];
    })),
  };
}

function guardedInvocation(plan: ReturnType<typeof checked>, extra: Record<string, string> = {}) {
  return {
    args: [`--git-dir=${plan.repository.gitDirectory}`, `--work-tree=${plan.repository.workTree}`, ...plan.ownedArgs],
    // Installation trust is tested separately; this file tests native engine controls.
    env: gitReadOnlyEnvironment({ ...environment, ...extra }, plan.repository, join(root, "absent-index")),
  };
}

async function terminal(args: string[], env: Record<string, string>): Promise<{ exitCode: number; output: string }> {
  const { spawn } = await import("node-pty");
  return await new Promise((resolve, reject) => {
    // node-pty searches Path for the literal name without applying PATHEXT.
    const child = spawn(process.platform === "win32" ? "git.exe" : "git", args, { cwd, env, name: "xterm", cols: 80, rows: 30 });
    let output = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Native terminal did not exit")); }, 10_000);
    child.onData((data) => { output += data; });
    child.onExit(({ exitCode }) => { clearTimeout(timer); resolve({ exitCode, output }); });
  });
}

function removed(marker: string): void {
  expect(readFileSync(marker, "utf8")).toBe("executed\n");
  rmSync(marker);
}

describe("native repository read controls", () => {
  it("refuses filesystem comparison after checked repository metadata disappears", control(async () => {
    const plan = checked(["diff", "left", "right", "--name-only"]);
    const invocation = guardedInvocation(plan);
    writeFileSync(join(cwd, "left"), "outside-left-content\n");
    writeFileSync(join(cwd, "right"), "outside-right-content\n");
    // Git for Windows stores objects read-only; asynchronous removal clears them.
    await cleanupTmpDir(join(cwd, ".git"));
    expect(existsSync(join(cwd, ".git"))).toBe(false);
    const control = spawnSync("git", [
      `--git-dir=${plan.repository.gitDirectory}`, `--work-tree=${plan.repository.workTree}`,
      "diff", "left", "right", "--name-only", "--",
    ], { cwd, encoding: "utf8", env: invocation.env, timeout: 10_000 });
    expect(control.error).toBeUndefined();
    expect(control.status).toBe(1);
    expect(control.stdout).toBe("right\n");
    const result = spawnSync("git", invocation.args, {
      cwd, encoding: "utf8", env: invocation.env, timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(128);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/not a git repository/i);
  }));

  it.each(["--name-only", "--name-status", "--raw"])("preserves recursive two-revision %s output through plumbing", control((output) => {
    mkdirSync(join(cwd, "nested"));
    writeFileSync(join(cwd, "nested", "content.txt"), "initial\n");
    writeFileSync(join(cwd, "executable.sh"), "#!/bin/sh\nexit 0\n");
    succeed(native(["add", "."]));
    succeed(native(["-c", "commit.gpgSign=false", "commit", "-m", "nested paths"]));
    writeFileSync(join(cwd, "nested", "content.txt"), "modified\n");
    chmodSync(join(cwd, "executable.sh"), 0o755);
    succeed(native(["add", "."]));
    succeed(native(["-c", "commit.gpgSign=false", "commit", "-m", "nested content and mode"]));
    const control = succeed(native(["diff", "HEAD~1", "HEAD", output]));
    expect(control).toContain("nested/content.txt");
    expect(succeed(guarded(checked(["diff", "HEAD~1", "HEAD", output])))).toBe(control);
  }));

  it.each(["clean", "process"] as const)("never converts worktree content through a %s filter added after admission", control((kind) => {
    const plans = [
      ["log", "-n", "1"], ["show", "--no-patch", "HEAD"],
      ["diff", "HEAD~1", "HEAD", "--name-only"], ["diff", "HEAD~1", "HEAD", "--name-status"],
      ["diff", "HEAD~1", "HEAD", "--raw"], ["rev-parse", "--verify", "HEAD"], ["branch", "--list"],
    ].map(checked);
    const helper = script(`worktree-${kind}-filter`, kind === "clean"
      ? 'printf "executed\\n" > "$CONTROL_MARKER"\ncat'
      : 'printf "executed\\n" > "$CONTROL_MARKER"\nexit 1');
    configure(`filter.aftercheck.${kind}`, helper.helper);
    configure("filter.aftercheck.required", "true");
    writeFileSync(join(cwd, ".gitattributes"), "alpha.txt filter=aftercheck\n");
    // Same-size content makes conversion necessary beyond the size comparison.
    writeFileSync(join(cwd, "alpha.txt"), "altered\n");
    const old = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(join(cwd, "alpha.txt"), old, old);
    for (const args of [
      ["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"],
      ["--no-optional-locks", "diff", "--name-only"],
    ]) {
      const control = native(args, { CONTROL_MARKER: helper.marker });
      expect(control.error).toBeUndefined();
      expect(control.status).toBe(kind === "clean" ? 0 : 128);
      removed(helper.marker);
      for (const plan of plans) {
        succeed(guarded(plan, { CONTROL_MARKER: helper.marker }));
        expect(existsSync(helper.marker)).toBe(false);
      }
    }
    expect(readOnlyGitArguments(["git", "status", "--porcelain"])).toBeNull();
    expect(readOnlyGitArguments(["git", "diff", "--name-only"])).toBeNull();
  }));

  it("uses a native engine supporting the required controls independently of installation trust", control(() => {
    expect(NATIVE_GIT.admissible).toBe(true);
    expect(isSupportedGitVersion(`git version ${NATIVE_GIT.version}\n`)).toBe(true);
    expect(succeed(guarded(checked(["log", "-n", "1"])))).toContain("second subject");
  }));

  it("blocks external diff and text conversion after repository admission", control(() => {
    const external = script("external-diff");
    const converter = script("text-converter", 'printf "executed\\n" > "$CONTROL_MARKER"\ncat "$1"');
    const plan = checked(["diff", "HEAD~1", "HEAD", "--raw"]);
    configure("diff.external", external.helper);
    succeed(native(["diff", "HEAD~1", "HEAD"], { CONTROL_MARKER: external.marker }));
    removed(external.marker);
    succeed(guarded(plan, { CONTROL_MARKER: external.marker }));
    expect(existsSync(external.marker)).toBe(false);
    succeed(native(["config", "--local", "--unset", "diff.external"]));
    writeFileSync(join(cwd, ".gitattributes"), "*.txt diff=private\n");
    configure("diff.private.textconv", converter.helper);
    succeed(native(["diff", "--textconv", "HEAD~1", "HEAD"], { CONTROL_MARKER: converter.marker }));
    removed(converter.marker);
    succeed(guarded(plan, { CONTROL_MARKER: converter.marker }));
    expect(existsSync(converter.marker)).toBe(false);
  }));

  it("disables filesystem monitors and index hooks even after mutable configuration changes", control(() => {
    const monitor = script("filesystem-monitor", 'printf "executed\\n" > "$CONTROL_MARKER"\nprintf "token\\0"');
    const hook = script("index-hook");
    const plan = checked(["diff", "HEAD~1", "HEAD", "--name-only"]);
    configure("core.fsmonitor", monitor.helper);
    succeed(native(["status", "--porcelain"], { CONTROL_MARKER: monitor.marker }));
    removed(monitor.marker);
    succeed(guarded(plan, { CONTROL_MARKER: monitor.marker }));
    expect(existsSync(monitor.marker)).toBe(false);
    configure("core.fsmonitor", "false");
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-index-change"), readFileSync(hook.helper));
    chmodSync(join(hooks, "post-index-change"), 0o755);
    configure("core.hooksPath", hooks);
    writeFileSync(join(cwd, "alpha.txt"), "third version\n");
    succeed(native(["add", "alpha.txt"], { CONTROL_MARKER: hook.marker }));
    removed(hook.marker);
    succeed(guarded(plan, { CONTROL_MARKER: hook.marker }));
    expect(existsSync(hook.marker)).toBe(false);
  }));

  it("prevents signature verifier execution from log defaults", control(() => {
    const verifier = script("signature-verifier", 'printf "executed\\n" > "$CONTROL_MARKER"\nexit 1');
    const plan = checked(["log", "-n", "1"]);
    const tree = succeed(native(["rev-parse", "HEAD^{tree}"])).trim();
    const commit = `tree ${tree}\nauthor Boundary Author <author@example.invalid> 1700000000 +0000\ncommitter Boundary Author <author@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n synthetic signature\n -----END PGP SIGNATURE-----\n\nsigned synthetic subject\n`;
    const object = succeed(native(["hash-object", "-t", "commit", "-w", "--stdin"], {}, commit)).trim();
    succeed(native(["update-ref", "refs/heads/main", object]));
    configure("gpg.program", verifier.helper);
    configure("log.showSignature", "true");
    native(["log", "-n", "1"], { CONTROL_MARKER: verifier.marker });
    removed(verifier.marker);
    expect(succeed(guarded(plan, { CONTROL_MARKER: verifier.marker }))).toContain("signed synthetic subject");
    expect(existsSync(verifier.marker)).toBe(false);
  }));

  it("owns pretty format, decoration, branch order and diff order after checks", control(() => {
    const history = checked(["log", "-n", "1"]);
    const branches = checked(["branch", "--list"]);
    const diff = checked(["diff", "HEAD~1", "HEAD", "--name-only"]);
    configure("format.pretty", "format:PRIVATE_PRETTY_OUTPUT");
    expect(succeed(native(["log", "-n", "1"]))).toBe("PRIVATE_PRETTY_OUTPUT");
    expect(succeed(guarded(history))).toContain("second subject");
    expect(succeed(guarded(history))).not.toContain("PRIVATE_PRETTY_OUTPUT");
    succeed(native(["branch", "alpha"]));
    succeed(native(["branch", "zeta"]));
    configure("branch.sort", "-refname");
    expect(succeed(native(["branch", "--list", "--format=%(refname:short)"])).trim().split("\n")).toEqual(["zeta", "main", "alpha"]);
    expect(succeed(guarded(branches)).split("\n").filter(Boolean).map((line) => line.slice(2))).toEqual(["alpha", "main", "zeta"]);
    const order = join(root, "outside-order");
    writeFileSync(order, "zeta.txt\nalpha.txt\n");
    configure("diff.orderFile", order);
    expect(succeed(native(["diff", "HEAD~1", "HEAD", "--name-only"])).trim().split("\n")).toEqual(["zeta.txt", "alpha.txt"]);
    expect(succeed(guarded(diff)).trim().split("\n")).toEqual(["alpha.txt", "zeta.txt"]);
    succeed(native(["tag", "private-decoration"]));
    configure("log.decorate", "full");
    expect(succeed(native(["log", "--format=medium", "-n", "1"]))).toContain("private-decoration");
    expect(succeed(guarded(history))).not.toContain("private-decoration");
  }));

  it("disables both configured and default worktree mailmaps after admission", control(() => {
    const plan = checked(["log", "-n", "1"]);
    const mailmap = "Private Synthetic Contact <private@example.invalid> Boundary Author <author@example.invalid>\n";
    writeFileSync(join(cwd, ".mailmap"), mailmap);
    configure("log.mailmap", "true");
    expect(succeed(native(["log", "-n", "1"]))).toContain("Private Synthetic Contact");
    expect(succeed(guarded(plan))).toContain("Boundary Author <author@example.invalid>");
    expect(succeed(guarded(plan))).not.toContain("Private Synthetic Contact");
    const outside = join(root, "outside-mailmap");
    writeFileSync(outside, mailmap.replace("Private Synthetic Contact", "Outside Contact"));
    configure("mailmap.file", outside);
    expect(succeed(native(["log", "-n", "1"]))).toContain("Outside Contact");
    expect(succeed(guarded(plan))).not.toContain("Outside Contact");
  }));

  it.each(["event", "perf", "normal"])("prevents trace2 %s writes from global configuration selected after admission", control((kind) => {
    const plan = checked(["log", "-n", "1"]);
    const target = join(root, `trace-${kind}`);
    const globalConfig = join(root, "global-config");
    succeed(native(["config", "--file", globalConfig, `trace2.${kind}Target`, target]));
    succeed(native(["log", "-n", "1"], { GIT_CONFIG_GLOBAL: globalConfig }));
    expect(readFileSync(target, "utf8").length).toBeGreaterThan(0);
    rmSync(target);
    succeed(guarded(plan, { GIT_CONFIG_GLOBAL: globalConfig }));
    expect(existsSync(target)).toBe(false);
  }));

  it("clears inherited trace output and arbitrary executable aliases", control(() => {
    const plan = checked(["log", "-n", "1"]);
    const alias = script("alias-helper");
    configure("alias.control", "!" + alias.helper);
    succeed(native(["control"], { CONTROL_MARKER: alias.marker }));
    removed(alias.marker);
    const trace = join(root, "inherited-trace");
    succeed(native(["log", "-n", "1"], { GIT_TRACE: trace }));
    expect(readFileSync(trace, "utf8")).toContain("built-in");
    rmSync(trace);
    succeed(guarded(plan, { GIT_TRACE: trace, CONTROL_MARKER: alias.marker }));
    expect(existsSync(trace)).toBe(false);
    expect(existsSync(alias.marker)).toBe(false);
    expect(readOnlyGitArguments(["git", "control"])).toBeNull();
  }));

  it("disables paging in a real terminal after repository paging defaults change", control(async () => {
    const helper = script("pager-helper", 'printf "executed\\n" > "$CONTROL_MARKER"\ncat');
    const plan = checked(["log", "-n", "1"]);
    configure("core.pager", helper.helper);
    configure("pager.log", "true");
    const control = await terminal(["-C", cwd, "--paginate", "log", "-n", "1"], {
      ...environment, GIT_PAGER: helper.helper, CONTROL_MARKER: helper.marker,
    });
    expect(control.exitCode, control.output).toBe(0);
    removed(helper.marker);
    const invocation = guardedInvocation(plan, { GIT_PAGER: helper.helper, PAGER: helper.helper, CONTROL_MARKER: helper.marker });
    const before = metadataState();
    const result = await terminal(invocation.args, invocation.env);
    expect(result.exitCode, result.output).toBe(0);
    expect(result.output).toContain("second subject");
    expect(existsSync(helper.marker)).toBe(false);
    expect(metadataState()).toEqual(before);
  }));

  it("disables replacement-object indirection after repository admission", control(() => {
    const plan = checked(["show", "--no-patch", "HEAD"]);
    const original = succeed(native(["rev-parse", "HEAD"])).trim();
    const replacement = succeed(native(["rev-parse", "HEAD~1"])).trim();
    succeed(native(["replace", original, replacement]));
    expect(succeed(native(["show", "--no-patch", "HEAD"]))).toContain("first subject");
    expect(succeed(guarded(plan))).toContain("second subject");
    expect(succeed(guarded(plan))).not.toContain("first subject");
  }));

  it("blocks lazy-fetch transport helpers after promisor metadata changes", control(() => {
    const helper = script("transport-helper", 'printf "executed\\n" > "$CONTROL_MARKER"\nexit 1');
    const plan = checked(["show", "--no-patch", "HEAD"]);
    const object = succeed(native(["rev-parse", "HEAD"])).trim();
    configure("core.repositoryformatversion", "1");
    configure("extensions.partialClone", "origin");
    configure("remote.origin.url", `ext::${helper.helper}`);
    configure("remote.origin.promisor", "true");
    configure("protocol.ext.allow", "always");
    // Git for Windows stores loose objects read-only; unlink clears that attribute.
    unlinkSync(join(cwd, ".git", "objects", object.slice(0, 2), object.slice(2)));
    native(["show", "--no-patch", "HEAD"], { CONTROL_MARKER: helper.marker });
    removed(helper.marker);
    const result = guarded(plan, { CONTROL_MARKER: helper.marker, GIT_NO_LAZY_FETCH: "0", GIT_ALLOW_PROTOCOL: "ext" });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(existsSync(helper.marker)).toBe(false);
  }));

  it("does not run a configured credential helper for admitted local reads", control(() => {
    const helper = script("credential-helper", 'printf "executed\\n" > "$CONTROL_MARKER"\nprintf "username=synthetic\\npassword=synthetic\\n"');
    const plan = checked(["log", "-n", "1"]);
    configure("credential.helper", "!" + helper.helper);
    expect(succeed(native(["credential", "fill"], { CONTROL_MARKER: helper.marker }, "protocol=https\nhost=example.invalid\n\n"))).toContain("username=synthetic");
    removed(helper.marker);
    succeed(guarded(plan, { CONTROL_MARKER: helper.marker, GIT_ASKPASS: helper.helper, SSH_ASKPASS: helper.helper }));
    expect(existsSync(helper.marker)).toBe(false);
    expect(readOnlyGitArguments(["git", "credential", "fill"])).toBeNull();
  }));

  it("prevents a real loopback HTTP request after lazy-fetch metadata changes", control(async () => {
    const marker = join(root, "http-request.marker");
    const server = spawn("node", ["-e", `
      const fs = require("node:fs");
      const http = require("node:http");
      const server = http.createServer((_request, response) => {
        fs.writeFileSync(process.argv[1], "request\\n");
        response.writeHead(404); response.end("synthetic missing repository");
      });
      server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\\n"));
    `, marker], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Native HTTP control did not start")), 5_000);
        server.once("error", (error) => { clearTimeout(timer); reject(error); });
        server.stdout!.once("data", (data: Buffer) => { clearTimeout(timer); resolve(Number(data.toString().trim())); });
      });
      expect(port).toBeGreaterThan(0);
      const plan = checked(["show", "--no-patch", "HEAD"]);
      const object = succeed(native(["rev-parse", "HEAD"])).trim();
      configure("core.repositoryformatversion", "1");
      configure("extensions.partialClone", "origin");
      configure("remote.origin.url", `http://127.0.0.1:${port}/synthetic`);
      configure("remote.origin.promisor", "true");
      // Git for Windows stores loose objects read-only; unlink clears that attribute.
      unlinkSync(join(cwd, ".git", "objects", object.slice(0, 2), object.slice(2)));
      native(["show", "--no-patch", "HEAD"], { NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" });
      expect(readFileSync(marker, "utf8")).toBe("request\n");
      rmSync(marker);
      const result = guarded(plan, {
        GIT_NO_LAZY_FETCH: "0", GIT_ALLOW_PROTOCOL: "http", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1",
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (server.pid !== undefined && server.exitCode === null && server.signalCode === null) {
        await new Promise<void>((resolve) => { server.once("exit", () => resolve()); server.kill(); });
      }
    }
  }));

  it("pins the files backend when mutable config selects an outside reference-store URI", control(() => {
    const plan = checked(["show", "--no-patch", "HEAD"]);
    const outside = join(root, "outside-ref-store");
    mkdirSync(join(outside, "refs", "heads"), { recursive: true });
    const earlier = succeed(native(["rev-parse", "HEAD~1"])).trim();
    writeFileSync(join(outside, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(outside, "refs", "heads", "main"), earlier + "\n");
    configure("core.repositoryformatversion", "1");
    configure("extensions.refStorage", `files://${outside}`);
    expect(succeed(native(["show", "--no-patch", "HEAD"]))).toContain("first subject");
    expect(succeed(guarded(plan))).toContain("second subject");
    expect(succeed(guarded(plan))).not.toContain("first subject");
    expect(gitReadOnlyEnvironment({ ...environment, GIT_REFERENCE_BACKEND: `files://${outside}` }, plan.repository, join(root, "absent-index")).GIT_REFERENCE_BACKEND).toBe("files");
  }));

  it("neutralizes executable defaults in a config include added after admission", control(() => {
    const history = checked(["log", "-n", "1"]);
    const diff = checked(["diff", "HEAD~1", "HEAD", "--raw"]);
    const helper = script("included-helper");
    const hooks = join(root, "included-hooks");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-index-change"), readFileSync(helper.helper));
    chmodSync(join(hooks, "post-index-change"), 0o755);
    const include = join(root, "outside-included-config");
    const pathValue = (value: string) => JSON.stringify(value);
    writeFileSync(include, `[core]\nfsmonitor = ${pathValue(helper.helper)}\nhooksPath = ${pathValue(hooks)}\npager = ${pathValue(helper.helper)}\n[diff]\nexternal = ${pathValue(helper.helper)}\n[log]\nshowSignature = true\n[format]\npretty = format:INCLUDED_PRETTY\n[gpg]\nprogram = ${pathValue(helper.helper)}\n[pager]\nlog = true\n`);
    configure("include.path", include);
    succeed(native(["diff", "HEAD~1", "HEAD"], { CONTROL_MARKER: helper.marker }));
    removed(helper.marker);
    expect(succeed(guarded(history, { CONTROL_MARKER: helper.marker }))).toContain("second subject");
    expect(succeed(guarded(history, { CONTROL_MARKER: helper.marker }))).not.toContain("INCLUDED_PRETTY");
    succeed(guarded(diff, { CONTROL_MARKER: helper.marker }));
    expect(existsSync(helper.marker)).toBe(false);
  }));

  it("strips command-scope configuration injected through inherited environment", control(() => {
    const plan = checked(["diff", "HEAD~1", "HEAD", "--name-only"]);
    const helper = script("environment-config-helper");
    const malicious = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "diff.external", GIT_CONFIG_VALUE_0: helper.helper, CONTROL_MARKER: helper.marker };
    succeed(native(["diff", "HEAD~1", "HEAD"], malicious));
    removed(helper.marker);
    const owned = gitReadOnlyEnvironment({ ...environment, ...malicious }, plan.repository, join(root, "absent-index"));
    expect(owned.GIT_CONFIG_COUNT).toBeUndefined();
    expect(owned.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(owned.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(succeed(guarded(plan, malicious))).toBe("alpha.txt\nzeta.txt\n");
    expect(existsSync(helper.marker)).toBe(false);
  }));

  it("rejects cached split-index writes and preserves timestamps for every admitted command family", control(() => {
    expect(readOnlyGitArguments(["git", "diff", "--cached", "--name-only"])).toBeNull();
    expect(readOnlyGitArguments(["git", "diff", "--staged", "--raw", "HEAD"])).toBeNull();
    const cases = [
      ["log", "-n", "1"], ["log", "--oneline", "--max-count=1"], ["show", "--no-patch", "HEAD"],
      ["diff", "HEAD~1", "HEAD", "--name-only"], ["diff", "HEAD~1", "HEAD", "--name-status"], ["diff", "HEAD~1", "HEAD", "--raw"],
      ["rev-parse", "--show-toplevel"], ["rev-parse", "--show-prefix"], ["rev-parse", "--git-dir"], ["rev-parse", "--absolute-git-dir"],
      ["rev-parse", "--is-inside-work-tree"], ["rev-parse", "--is-bare-repository"], ["rev-parse", "--verify", "HEAD"],
      ["branch", "--list"], ["branch", "--list", "--all"], ["branch", "--list", "--remotes"],
    ];
    const plans = cases.map(checked);
    succeed(native(["update-index", "--split-index"]));
    const sharedName = readdirSync(join(cwd, ".git")).find((name) => name.startsWith("sharedindex."));
    expect(sharedName).toBeDefined();
    const shared = join(cwd, ".git", sharedName!);
    const stale = new Date("2000-01-01T00:00:00.000Z");
    utimesSync(shared, stale, stale);
    const before = lstatSync(shared, { bigint: true }).mtimeNs;
    succeed(native(["--no-optional-locks", "diff", "--cached", "--name-only"]));
    expect(lstatSync(shared, { bigint: true }).mtimeNs).not.toBe(before);
    utimesSync(shared, stale, stale);
    for (const plan of plans) {
      succeed(guarded(plan));
      expect(lstatSync(shared, { bigint: true }).mtimeNs).toBe(before);
    }
  }));

  it("ignores submodule metadata changes for revision-only name output", control(() => {
    const first = succeed(native(["rev-parse", "HEAD~1"])).trim();
    const second = succeed(native(["rev-parse", "HEAD"])).trim();
    succeed(native(["update-index", "--add", "--cacheinfo", `160000,${first},synthetic`]));
    succeed(native(["-c", "commit.gpgSign=false", "commit", "-m", "first submodule pointer"]));
    succeed(native(["update-index", "--cacheinfo", `160000,${second},synthetic`]));
    succeed(native(["-c", "commit.gpgSign=false", "commit", "-m", "second submodule pointer"]));
    const plan = checked(["diff", "HEAD~1", "HEAD", "--name-only"]);
    const helper = script("submodule-helper");
    configure("submodule.recurse", "true");
    configure("diff.submodule", "log");
    configure("submodule.synthetic.update", "!" + helper.helper);
    writeFileSync(join(cwd, ".gitmodules"), '[submodule "synthetic"]\n\tpath = synthetic\n\turl = ext::' + helper.helper + "\n");
    expect(succeed(native(["diff", "HEAD~1", "HEAD", "--name-only"]))).toBe("synthetic\n");
    expect(succeed(guarded(plan, { CONTROL_MARKER: helper.marker }))).toBe("");
    expect(existsSync(helper.marker)).toBe(false);
  }));
});

describe("native engine and fixture preconditions", () => {
  it("refuses a forced below-floor engine in either version spelling", () => {
    const below = `${GIT_VERSION_FLOOR.major}.${GIT_VERSION_FLOOR.minor - 1}.9`;
    for (const output of [`git version ${below}\n`, `git version ${below}.windows.1\n`]) {
      const engine = classifyNativeGit(output);
      expect(engine.version).toBe(below);
      assertEngineRefused(engine);
    }
    const floor = classifyNativeGit(`git version ${GIT_VERSION_FLOOR.major}.${GIT_VERSION_FLOOR.minor}.0.windows.1\n`);
    expect(floor.admissible).toBe(true);
    // The product probe accepts only the upstream spelling; the numeric version is what the floor governs.
    expect(isSupportedGitVersion(`git version ${GIT_VERSION_FLOOR.major}.${GIT_VERSION_FLOOR.minor}.0.windows.1\n`)).toBe(false);
    expect(isSupportedGitVersion(`git version ${floor.version}\n`)).toBe(true);
    expect(() => classifyNativeGit("git version 2.54.0 (custom)\n")).toThrow(/Unrecognized native Git version/);
  });

  it("starts no detached auto-maintenance from fixture commits", () => {
    const enabledTrace = join(root, "maintenance-enabled.trace");
    writeFileSync(join(cwd, "alpha.txt"), "maintenance control\n");
    succeed(native(["add", "."]));
    succeed(native(["-c", "commit.gpgSign=false", "commit", "-m", "maintenance control"], { GIT_TRACE: enabledTrace, GIT_CONFIG_VALUE_0: "true" }));
    expect(readFileSync(enabledTrace, "utf8")).toMatch(/maintenance run --auto/);
    const fixtureTrace = join(root, "maintenance-fixture.trace");
    writeFileSync(join(cwd, "alpha.txt"), "fixture commit\n");
    succeed(native(["add", "."]));
    succeed(native(["-c", "commit.gpgSign=false", "commit", "-m", "fixture commit"], { GIT_TRACE: fixtureTrace }));
    expect(readFileSync(fixtureTrace, "utf8")).not.toMatch(/maintenance run/);
  });

  // Runs last in this file so the CI log records which branch every control took.
  it("reports the branch every native control took on this engine", () => {
    process.stderr.write(`[git-readonly-controls] native Git ${NATIVE_GIT.version}: ${branches.positive} positive controls, ${branches.belowFloor} below-floor refusals\n`);
    // CI runners must prove the recipe itself; only a local older engine may take the refusal branch.
    if (process.env.CI) {
      expect(NATIVE_GIT.admissible, `CI requires native Git ${GIT_VERSION_FLOOR.major}.${GIT_VERSION_FLOOR.minor} or newer, found ${NATIVE_GIT.version}`).toBe(true);
    }
    if (NATIVE_GIT.admissible) expect(branches.belowFloor).toBe(0);
    else expect(branches.positive).toBe(0);
  });
});
