import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { cleanupAsrtSandboxAfterCommand, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { mxcRuntimeRootFloorPath } from "../mxc-runtime-root.js";

describe.skipIf(process.platform !== "darwin" || shouldSkipNativeSandboxTests())("native typed repository markers", () => {
  let root: string;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-marker-types-")));
    await initializeRequiredSandbox({ allowedDomains: [] });
  });
  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function run(command: string, directory: string) {
    const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
      context: { sessionId: undefined, workspaceRoot: directory, approvalSurface: "unavailable" } });
    try {
      const wrapped = await wrapToolCommand(command, {
        commandId: invocation.token, denyUnixSockets: true,
        filesystem: { allowWrite: [directory], denyWrite: [] },
      });
      const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: directory, env: { ...process.env, ...wrapped.env }, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
      });
      if (result.error) throw result.error;
      expect(result.status, result.stderr).not.toBeNull();
      expect(result.status, result.stderr).not.toBe(71);
      return result;
    } finally {
      invocation.release();
      await cleanupAsrtSandboxAfterCommand();
    }
  }

  it("allows writes within an existing metadata directory while pinning its entry", async () => {
    const directory = join(root, "existing");
    mkdirSync(join(directory, ".git", "objects"), { recursive: true });
    writeFileSync(join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
    expect((await run("printf changed > .git/HEAD && printf object > .git/objects/new", directory)).status).toBe(0);
    expect(readFileSync(join(directory, ".git", "HEAD"), "utf8")).toBe("changed");
    expect((await run("mv .git relocated", directory)).status).not.toBe(0);
    expect(existsSync(join(directory, "relocated"))).toBe(false);
  });

  it.each([".git", ".GIT"])("blocks creation of a future %s marker at depth four", async marker => {
    const directory = join(root, marker === ".git" ? "future-lower" : "future-upper");
    mkdirSync(directory);
    const result = await run(`mkdir -p one/two/three/four/${marker}/hooks && printf payload > one/two/three/four/${marker}/hooks/pre-commit`, directory);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(directory, "one/two/three/four", marker))).toBe(false);
  });

  it("denies a depth-four regular pointer file's contents and replacement", async () => {
    const directory = join(root, "pointer");
    const parent = join(directory, "one/two/three/four");
    mkdirSync(parent, { recursive: true });
    writeFileSync(join(parent, ".git"), "gitdir: target\n");
    expect((await run("printf replacement > one/two/three/four/.git", directory)).status).not.toBe(0);
    expect((await run("rm one/two/three/four/.git && printf replacement > one/two/three/four/.git", directory)).status).not.toBe(0);
    expect(readFileSync(join(parent, ".git"), "utf8")).toBe("gitdir: target\n");
  });
});

// One confined bash command, wrapped the way the shell tool wraps it: the given write roots, the mandatory floor, no unix sockets.
async function runConfined(command: string, directory: string, allowWrite: readonly string[] = [directory]) {
  const invocation = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: undefined,
    context: { sessionId: undefined, workspaceRoot: directory, approvalSurface: "unavailable" } });
  try {
    const wrapped = await wrapToolCommand(command, {
      commandId: invocation.token, denyUnixSockets: true,
      filesystem: { allowWrite: [...allowWrite], denyWrite: [] },
    });
    const [program = "", ...args] = wrapped.argv;
    const result = spawnSync(program, args, {
      cwd: directory, env: { ...process.env, ...wrapped.env }, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).not.toBe(71);
    return { stdout: result.stdout, grantedWrite: (wrapped.filesystemPolicy?.allowWrite ?? []).map(entry => typeof entry === "string" ? entry : entry.path) };
  } finally {
    invocation.release();
    await cleanupAsrtSandboxAfterCommand();
  }
}

function statuses(stdout: string): Record<string, string> {
  return Object.fromEntries(stdout.trim().split("\n").filter(line => line.includes("=")).map(line => line.split("=") as [string, string]));
}

describe.skipIf(process.platform !== "darwin" || shouldSkipNativeSandboxTests())("native egress proxy socket directory", () => {
  // The sandbox runtime keeps every proxy backend socket of this process in one `srt-sock-*` directory under the host temp directory,
  // and the shell's write roots include that temp directory.
  const temp = realpathSync(tmpdir());
  let root: string;
  let socketDirectory: string;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(temp, "sandbox-socket-floor-")));
    await initializeRequiredSandbox({ allowedDomains: [] });
    // Other suites' processes share the temp directory; this process's sockets carry its pid.
    const own = readdirSync(temp).filter(name => name.startsWith("srt-sock-")
      && readdirSync(join(temp, name)).some(socket => socket.includes(`-${process.pid}-`)));
    expect(own).toHaveLength(1);
    socketDirectory = join(temp, ...own);
  });
  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("keeps another run's backend socket from being removed, renamed or replaced while the temp root stays writable", async () => {
    const sockets = readdirSync(socketDirectory);
    expect(sockets.length).toBeGreaterThan(0);
    const socket = join(socketDirectory, sockets[0] ?? "");
    const control = join(temp, "sandbox-socket-floor-control");
    const result = await runConfined([
      `rm -f '${socket}' 2>/dev/null; test -e '${socket}'; echo "unlink=$?"`,
      `mv '${socket}' '${socket}.moved' 2>/dev/null; echo "rename=$?"`,
      `printf x > '${socketDirectory}/planted' 2>/dev/null; echo "plant=$?"`,
      `mv '${socketDirectory}' '${socketDirectory}-moved' 2>/dev/null; echo "rename-directory=$?"`,
      `rm -rf '${socketDirectory}' 2>/dev/null; test -d '${socketDirectory}'; echo "remove-directory=$?"`,
      `printf x > '${control}' && rm '${control}'; echo "temp-write=$?"`,
      `printf x > ordinary; echo "project-write=$?"`,
    ].join("\n"), root, [root, socketDirectory, temp]);
    // The directory is granted by name as well, so the case does not rest on the shared temp root: a scan that cannot finish there
    // (other suites' fixtures) withdraws that root alone, and the control below follows what the wrap actually granted.
    expect(result.grantedWrite).toContain(socketDirectory);
    expect(statuses(result.stdout)).toEqual({
      unlink: "0", rename: "1", plant: "1", "rename-directory": "1", "remove-directory": "0",
      "temp-write": result.grantedWrite.includes(temp) ? "0" : "1", "project-write": "0",
    });
    expect(readdirSync(socketDirectory)).toEqual(sockets);
  });
});

describe.skipIf(process.platform !== "darwin" || shouldSkipNativeSandboxTests())("native project names another tool loads", () => {
  let root: string;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-name-floor-")));
    await initializeRequiredSandbox({ allowedDomains: [] });
  });
  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("keeps existing and absent agent and cloud config directories read-only inside a write root", async () => {
    const project = join(root, "agent-config");
    for (const directory of [".codex", ".agents/skills", ".aws", "packages/tool/.codex"]) mkdirSync(join(project, directory), { recursive: true });
    mkdirSync(join(project, "fresh"));
    mkdirSync(join(project, "fresh-other-case"));
    writeFileSync(join(project, ".codex", "config.toml"), "host");
    const result = await runConfined([
      `printf x > .codex/config.toml 2>/dev/null; echo "codex=$?"`,
      `printf x > .agents/skills/planted.md 2>/dev/null; echo "agents=$?"`,
      `printf x > .aws/config 2>/dev/null; echo "aws=$?"`,
      `printf x > packages/tool/.codex/config.toml 2>/dev/null; echo "nested=$?"`,
      `mkdir fresh/.codex 2>/dev/null; echo "create=$?"`,
      `mkdir fresh-other-case/.CODEX 2>/dev/null; echo "create-other-case=$?"`,
      `mv .codex .codex-moved 2>/dev/null; echo "rename=$?"`,
      `printf x > codex.txt; echo "ordinary=$?"`,
    ].join("\n"), project);
    expect(statuses(result.stdout)).toEqual({
      codex: "1", agents: "1", aws: "1", nested: "1", create: "1", "create-other-case": "1", rename: "1", ordinary: "0",
    });
    expect(readFileSync(join(project, ".codex", "config.toml"), "utf8")).toBe("host");
    expect(readdirSync(join(project, "fresh"))).toEqual([]);
    expect(readdirSync(join(project, "fresh-other-case"))).toEqual([]);
  });

  it("keeps project commands and hooks read-only, and their directory in place", async () => {
    const project = join(root, "project-inputs");
    for (const directory of [".ave/commands", ".ave/hooks", "fresh/.ave", "absent", "nested/app/.ave/commands"]) mkdirSync(join(project, directory), { recursive: true });
    writeFileSync(join(project, ".ave", "commands", "deploy.md"), "host");
    const result = await runConfined([
      `printf x > .ave/commands/deploy.md 2>/dev/null; echo "edit=$?"`,
      `printf x > .ave/commands/planted.md 2>/dev/null; echo "plant=$?"`,
      `printf x > .ave/hooks/planted.json 2>/dev/null; echo "hooks=$?"`,
      `printf x > nested/app/.ave/commands/planted.md 2>/dev/null; echo "nested=$?"`,
      `mkdir fresh/.ave/commands 2>/dev/null; echo "create=$?"`,
      `mkdir -p staged/commands && printf x > staged/commands/planted.md && mv staged absent/.ave 2>/dev/null; echo "rename-into=$?"`,
      `mv .ave/commands .ave/commands-moved 2>/dev/null; echo "rename=$?"`,
      // Moving the parent away would take the commands out from under their name, to be edited and moved back.
      `mv .ave .ave-moved 2>/dev/null; echo "rename-parent=$?"`,
      `printf x > .ave/notes.txt; echo "sibling=$?"`,
      `printf x > ordinary.txt; echo "ordinary=$?"`,
    ].join("\n"), project);
    expect(statuses(result.stdout)).toEqual({
      edit: "1", plant: "1", hooks: "1", nested: "1", create: "1", "rename-into": "1", rename: "1", "rename-parent": "1", sibling: "0", ordinary: "0",
    });
    expect(readFileSync(join(project, ".ave", "commands", "deploy.md"), "utf8")).toBe("host");
    expect(readdirSync(join(project, ".ave", "commands"))).toEqual(["deploy.md"]);
    expect(readdirSync(join(project, "fresh", ".ave"))).toEqual([]);
    expect(readdirSync(join(project, "absent"))).toEqual([]);
  });
});

describe.skipIf(process.platform !== "darwin" || shouldSkipNativeSandboxTests())("native app-owned state under an ancestor write root", () => {
  const inherited = { home: process.env.AVE_HOME, base: process.env.AVE_TEST_SANDBOX_BASE };
  let outside: string;
  let account: string;
  let aveHomeDirectory: string;
  let runtimeRoot: string;
  beforeAll(async () => {
    outside = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-home-floor-")));
    // An account folder that holds the Ave home and the cache directory, as the user's home folder does. The home has a relocated
    // name, so the `.ave` entry rule is not what holds it in place.
    account = join(outside, "account");
    aveHomeDirectory = join(account, "ave-data");
    mkdirSync(join(account, "Library", "Caches"), { recursive: true });
    process.env.AVE_HOME = aveHomeDirectory;
    process.env.AVE_TEST_SANDBOX_BASE = join(account, "Library", "Caches");
    runtimeRoot = mxcRuntimeRootFloorPath();
    expect(runtimeRoot.startsWith(`${account}/Library/Caches/`)).toBe(true);
    await initializeRequiredSandbox({ allowedDomains: [] });
  });
  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    for (const [name, value] of [["AVE_HOME", inherited.home], ["AVE_TEST_SANDBOX_BASE", inherited.base]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (outside) rmSync(outside, { recursive: true, force: true });
  });

  it("keeps the Ave home and the runtime root read-only, and the wrap's own directories inside the home writable", async () => {
    const hostState = {
      "other-home": join(aveHomeDirectory, "sandbox", "home", "other", "marker"),
      handoff: join(aveHomeDirectory, "sandbox", "handoff", "terminal", "command"),
      plugin: join(aveHomeDirectory, "plugins", "extension", "dist", "index.js"),
      runtime: join(aveHomeDirectory, "runtime", "layout"),
      mcp: join(aveHomeDirectory, "mcp", "server", "state"),
      "runtime-root": join(runtimeRoot, "run", "state"),
    };
    for (const path of Object.values(hostState)) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "host");
    }
    const ownHome = join(aveHomeDirectory, "sandbox", "home", "own");
    const workspace = join(aveHomeDirectory, "workspace");
    for (const directory of [ownHome, workspace]) mkdirSync(directory, { recursive: true });
    const planted = [join(aveHomeDirectory, "runtime", "planted"), join(aveHomeDirectory, "planted"), join(runtimeRoot, "planted")];
    const result = await runConfined([
      ...Object.entries(hostState).map(([name, path]) => `printf x >> '${path}' 2>/dev/null; echo "${name}=$?"`),
      ...planted.map((path, index) => `printf x > '${path}' 2>/dev/null; echo "plant-${index}=$?"`),
      `mkdir '${join(aveHomeDirectory, "sandbox", "home", "new")}' 2>/dev/null; echo "new-home=$?"`,
      `rm -f '${hostState.plugin}' 2>/dev/null; echo "remove=$?"`,
      `mv '${join(aveHomeDirectory, "sandbox", "home", "other")}' '${join(ownHome, "taken")}' 2>/dev/null; echo "take=$?"`,
      `mv '${aveHomeDirectory}' '${aveHomeDirectory}-moved' 2>/dev/null; echo "move-home=$?"`,
      `mv '${join(account, "Library")}' '${join(account, "Library-moved")}' 2>/dev/null; echo "move-ancestor=$?"`,
      `printf x > '${join(ownHome, "file")}'; echo "own-home=$?"`,
      `mkdir '${join(ownHome, "tmp")}'; echo "own-home-create=$?"`,
      `printf x > '${join(workspace, "file")}'; echo "workspace=$?"`,
      `printf x > '${join(account, "ordinary")}'; echo "account=$?"`,
    ].join("\n"), account, [account, ownHome, workspace]);
    expect(result.grantedWrite).toEqual([account, ownHome, workspace]);
    expect(statuses(result.stdout)).toEqual({
      "other-home": "1", handoff: "1", plugin: "1", runtime: "1", mcp: "1", "runtime-root": "1",
      "plant-0": "1", "plant-1": "1", "plant-2": "1", "new-home": "1", remove: "1", take: "1",
      "move-home": "1", "move-ancestor": "1", "own-home": "0", "own-home-create": "0", workspace: "0", account: "0",
    });
    for (const path of Object.values(hostState)) expect(readFileSync(path, "utf8")).toBe("host");
    for (const path of planted) expect(existsSync(path)).toBe(false);
    expect(readdirSync(ownHome).sort()).toEqual(["file", "tmp"]);
  });

  it("adds nothing for a wrap whose roots do not hold the home", async () => {
    const project = join(outside, "project");
    const ownHome = join(aveHomeDirectory, "sandbox", "home", "own");
    for (const directory of [project, ownHome]) mkdirSync(directory, { recursive: true });
    const result = await runConfined([
      `printf x > ordinary; echo "project=$?"`,
      `printf x > '${join(ownHome, "file")}'; echo "own-home=$?"`,
      `printf x > '${join(aveHomeDirectory, "planted")}' 2>/dev/null; echo "home=$?"`,
    ].join("\n"), project, [project, ownHome]);
    expect(statuses(result.stdout)).toEqual({ project: "0", "own-home": "0", home: "1" });
  });
});
