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
import { prepareSandboxFixture } from "../../tools/__tests__/support/prepared-shell.js";
import { spawnWithSandbox } from "../../tools/shell-tools.js";

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
  // and the shell's write roots include that temp directory. The suite gives this process a temp directory of its own, so the root
  // holds nothing but the socket directory and its scan cannot be withdrawn over another suite's fixtures.
  const inheritedTemp = process.env.TMPDIR;
  let root: string;
  let temp: string;
  let socketDirectory: string;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-socket-floor-")));
    temp = join(root, "t");
    mkdirSync(temp);
    mkdirSync(join(root, "project"));
    process.env.TMPDIR = temp;
    await initializeRequiredSandbox({ allowedDomains: [] });
    const created = readdirSync(temp).filter(name => name.startsWith("srt-sock-"));
    expect(created).toHaveLength(1);
    socketDirectory = join(temp, ...created);
  });
  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (inheritedTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = inheritedTemp;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("keeps another run's backend socket from being renamed, removed or replaced when only the temp root is writable", async () => {
    const sockets = readdirSync(socketDirectory);
    expect(sockets.length).toBeGreaterThan(0);
    const socket = join(socketDirectory, sockets[0] ?? "");
    const project = join(root, "project");
    // Each row leaves the directory as it found it when it is refused, so no row depends on an earlier one.
    const result = await runConfined([
      `mv '${socket}' '${socket}.moved' 2>/dev/null; echo "rename=$?"`,
      `rm -f '${socket}' '${socket}.moved' 2>/dev/null; echo "unlink=$?"`,
      `printf x > '${socketDirectory}/planted' 2>/dev/null; echo "plant=$?"`,
      `mv '${socketDirectory}' '${temp}/renamed' 2>/dev/null; echo "rename-directory=$?"`,
      `mkdir '${temp}/srt-sock-forged' 2>/dev/null; echo "forge-directory=$?"`,
      `printf x > '${temp}/control' && mv '${temp}/control' '${temp}/control-moved' && rm '${temp}/control-moved'; echo "temp-write=$?"`,
      `printf x > ordinary; echo "project-write=$?"`,
    ].join("\n"), project, [project, temp]);
    // Production shape: the temp root is granted, the socket directory is not named.
    expect(result.grantedWrite).toEqual([project, temp]);
    expect(statuses(result.stdout)).toEqual({
      rename: "1", unlink: "1", plant: "1", "rename-directory": "1", "forge-directory": "1", "temp-write": "0", "project-write": "0",
    });
    expect(readdirSync(socketDirectory)).toEqual(sockets);
    expect(readdirSync(temp)).toEqual([socketDirectory.slice(temp.length + 1)]);
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

  // The shell tool's own path: its read policy re-opens the command's HOME, which is created under the Ave home.
  it("leaves the bash tool's own HOME and temp fully usable under an ancestor working directory", async () => {
    const victim = join(aveHomeDirectory, "runtime", "layout");
    mkdirSync(join(aveHomeDirectory, "runtime"), { recursive: true });
    writeFileSync(victim, "host");
    const script = [
      `printf x >> '${victim}' 2>/dev/null; echo "home-state=$?"`,
      `printf x > "$HOME/file" && mv "$HOME/file" "$HOME/moved" && rm "$HOME/moved"; echo "own-home=$?"`,
      `made=$(mktemp "$TMPDIR/probe.XXXXXX") && printf x > "$made" && rm "$made"; echo "own-temp=$?"`,
      `cat <<'TEXT' > "$HOME/heredoc" && rm "$HOME/heredoc"; echo "heredoc=$?"\nline\nTEXT`,
      `case "$HOME" in '${aveHomeDirectory}'/*) echo "home-under-ave-home=0";; *) echo "home-under-ave-home=1";; esac`,
      `printf x > ordinary; echo "account=$?"`,
    ].join("\n");
    writeFileSync(join(account, "probe.sh"), script);
    const command = "bash ./probe.sh";
    const result = await spawnWithSandbox(command, account, [account], 30, prepareSandboxFixture(command, account));
    expect(statuses(result.output)).toEqual({
      "home-state": "1", "own-home": "0", "own-temp": "0", heredoc: "0", "home-under-ave-home": "0", account: "0",
    });
    expect(readFileSync(victim, "utf8")).toBe("host");
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

// The Ave home and the write roots given in a spelling that is not the resolved one, as `/tmp` is for `/private/tmp`.
describe.skipIf(process.platform !== "darwin" || shouldSkipNativeSandboxTests())("native app-owned state under an ancestor root spelled through a link", () => {
  const inherited = { home: process.env.AVE_HOME, base: process.env.AVE_TEST_SANDBOX_BASE };
  let resolved: string;
  let account: string;
  beforeAll(async () => {
    resolved = realpathSync(mkdtempSync(join("/tmp", "sandbox-link-floor-")));
    expect(resolved.startsWith("/private/tmp/")).toBe(true);
    account = join("/tmp", resolved.slice("/private/tmp/".length), "account");
    mkdirSync(join(account, "Library", "Caches"), { recursive: true });
    process.env.AVE_HOME = join(account, "ave-data");
    process.env.AVE_TEST_SANDBOX_BASE = join(account, "Library", "Caches");
    await initializeRequiredSandbox({ allowedDomains: [] });
  });
  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    for (const [name, value] of [["AVE_HOME", inherited.home], ["AVE_TEST_SANDBOX_BASE", inherited.base]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (resolved) rmSync(resolved, { recursive: true, force: true });
  });

  it("denies the home and keeps the wrap's own directories writable in either spelling", async () => {
    const home = join(account, "ave-data");
    const victim = join(home, "runtime", "layout");
    const ownHome = join(home, "sandbox", "home", "own");
    const workspace = join(home, "workspace");
    for (const directory of [join(home, "runtime"), ownHome, workspace]) mkdirSync(directory, { recursive: true });
    writeFileSync(victim, "host");
    const physical = (path: string) => join("/private", path);
    const result = await runConfined([
      `printf x >> '${victim}' 2>/dev/null; echo "state=$?"`,
      `printf x >> '${physical(victim)}' 2>/dev/null; echo "state-resolved=$?"`,
      `printf x > '${join(home, "planted")}' 2>/dev/null; echo "plant=$?"`,
      `printf x > '${join(ownHome, "file")}'; echo "own-home=$?"`,
      `printf x > '${physical(join(workspace, "file"))}'; echo "workspace=$?"`,
      `printf x > '${join(account, "ordinary")}'; echo "account=$?"`,
    ].join("\n"), account, [account, ownHome, workspace]);
    expect(statuses(result.stdout)).toEqual({ state: "1", "state-resolved": "1", plant: "1", "own-home": "0", workspace: "0", account: "0" });
    expect(readFileSync(victim, "utf8")).toBe("host");
  });
});
