import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { t } from "../../i18n/index.js";
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

describe.skipIf(process.platform !== "darwin" || shouldSkipNativeSandboxTests())("native named entries beneath a write root", () => {
  let root: string;
  beforeAll(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sandbox-name-floor-")));
    await initializeRequiredSandbox({ allowedDomains: [] });
  });
  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("keeps .agents and the project's commands and hooks read-only at the root, and other .ave content and nested copies writable", async () => {
    const project = join(root, "existing");
    for (const directory of [".agents/skills", ".ave/commands", ".ave/hooks", ".codex", "packages/tool/.ave/commands"]) mkdirSync(join(project, directory), { recursive: true });
    writeFileSync(join(project, ".agents", "skills", "SKILL.md"), "host");
    writeFileSync(join(project, ".ave", "commands", "deploy.md"), "host");
    const result = await runConfined([
      `printf x > .agents/skills/SKILL.md 2>/dev/null; echo "agents=$?"`,
      `printf x > .agents/planted 2>/dev/null; echo "agents-create=$?"`,
      `mv .agents .agents-moved 2>/dev/null; echo "move-agents=$?"`,
      `printf x > .ave/commands/deploy.md 2>/dev/null; echo "ave-commands=$?"`,
      `printf x > .ave/COMMANDS/planted.md 2>/dev/null; echo "ave-other-case=$?"`,
      `printf x > .ave/hooks/planted.json 2>/dev/null; echo "ave-hooks=$?"`,
      // Moving the directory away would take the parts out from under their names, to be edited and moved back.
      `mv .ave .ave-moved 2>/dev/null; echo "move-ave=$?"`,
      `mv .ave/commands .ave/commands-moved 2>/dev/null; echo "move-part=$?"`,
      `printf x > .ave/notes.md; echo "ave-other=$?"`,
      // Only the entries directly beneath the root are named.
      `printf x > packages/tool/.ave/commands/x.md; echo "nested-ave=$?"`,
      `mkdir -p packages/tool/.agents/skills && printf x > packages/tool/.agents/skills/x.md; echo "nested-agents=$?"`,
      // Not on this floor.
      `printf x > .codex/config.toml && mkdir .aws && printf x > .aws/config; echo "unnamed=$?"`,
      `printf x > ordinary.txt; echo "ordinary=$?"`,
    ].join("\n"), project);
    expect(statuses(result.stdout)).toEqual({
      agents: "1", "agents-create": "1", "move-agents": "1", "ave-commands": "1", "ave-other-case": "1", "ave-hooks": "1", "move-ave": "1", "move-part": "1",
      "ave-other": "0", "nested-ave": "0", "nested-agents": "0", unnamed: "0", ordinary: "0",
    });
    expect(readFileSync(join(project, ".agents", "skills", "SKILL.md"), "utf8")).toBe("host");
    expect(readFileSync(join(project, ".ave", "commands", "deploy.md"), "utf8")).toBe("host");
    expect(readdirSync(join(project, ".ave")).sort()).toEqual(["commands", "hooks", "notes.md"]);
  });

  it("refuses to create the entries, or rename a prepared directory into place, where they are absent", async () => {
    const project = join(root, "absent");
    mkdirSync(project);
    const result = await runConfined([
      `mkdir .agents 2>/dev/null; echo "agents=$?"`,
      `mkdir .AGENTS 2>/dev/null; echo "agents-other-case=$?"`,
      `mkdir -p prepared/skills && printf x > prepared/skills/x.md && mv prepared .agents 2>/dev/null; echo "rename-into-agents=$?"`,
      `mkdir -p .ave/commands 2>/dev/null; echo "ave=$?"`,
      `mkdir -p staged/commands && printf x > staged/commands/planted.md && mv staged .ave 2>/dev/null; echo "rename-into-ave=$?"`,
      `mkdir -p deeper/.ave/commands && printf x > deeper/.ave/commands/x.md; echo "nested=$?"`,
    ].join("\n"), project);
    expect(statuses(result.stdout)).toEqual({ agents: "1", "agents-other-case": "1", "rename-into-agents": "1", ave: "1", "rename-into-ave": "1", nested: "0" });
    expect(readdirSync(project).sort()).toEqual(["deeper", "prepared", "staged"]);
  });

  it("holds the entries where a link stands in for them, at the link and at what it points to", async () => {
    const project = join(root, "linked");
    for (const directory of ["tools/agents/skills", ".ave", "cmds"]) mkdirSync(join(project, directory), { recursive: true });
    symlinkSync("tools/agents", join(project, ".agents"));
    symlinkSync("../cmds", join(project, ".ave", "commands"));
    writeFileSync(join(project, "tools", "agents", "skills", "SKILL.md"), "host");
    const result = await runConfined([
      `printf x > .agents/skills/evil.md 2>/dev/null; echo "through-link=$?"`,
      `printf x > tools/agents/skills/SKILL.md 2>/dev/null; echo "at-target=$?"`,
      // Moving the target or a folder above it away would leave the name free to be filled again.
      `mv tools/agents tools/moved 2>/dev/null; echo "move-target=$?"`,
      `mv tools tools-moved 2>/dev/null; echo "move-above=$?"`,
      `rm .agents 2>/dev/null; echo "remove-link=$?"`,
      `printf x > .ave/commands/x.md 2>/dev/null; echo "commands-through-link=$?"`,
      `printf x > cmds/x.md 2>/dev/null; echo "commands-at-target=$?"`,
      `printf x > tools/other.txt; echo "beside-target=$?"`,
      `printf x > ordinary.txt; echo "ordinary=$?"`,
    ].join("\n"), project);
    expect(statuses(result.stdout)).toEqual({
      "through-link": "1", "at-target": "1", "move-target": "1", "move-above": "1", "remove-link": "1",
      "commands-through-link": "1", "commands-at-target": "1", "beside-target": "0", ordinary: "0",
    });
    expect(readFileSync(join(project, "tools", "agents", "skills", "SKILL.md"), "utf8")).toBe("host");
    expect(readdirSync(join(project, "cmds"))).toEqual([]);
  });

  it("holds the commands and hooks of a linked .ave, present or not yet created", async () => {
    const project = join(root, "linked-carrier");
    mkdirSync(join(project, "conf", "commands"), { recursive: true });
    symlinkSync("conf", join(project, ".ave"));
    const result = await runConfined([
      `printf x > .ave/commands/x.md 2>/dev/null; echo "through-link=$?"`,
      `printf x > conf/commands/x.md 2>/dev/null; echo "at-target=$?"`,
      `mkdir conf/hooks 2>/dev/null; echo "absent-part=$?"`,
      `mv conf conf-moved 2>/dev/null; echo "move-target=$?"`,
      `printf x > conf/notes.md; echo "other=$?"`,
    ].join("\n"), project);
    expect(statuses(result.stdout)).toEqual({ "through-link": "1", "at-target": "1", "absent-part": "1", "move-target": "1", other: "0" });
    expect(readdirSync(join(project, "conf")).sort()).toEqual(["commands", "notes.md"]);
  });

  it("keeps every link on the way to an entry from being removed, replaced or moved", async () => {
    const project = join(root, "chained");
    for (const directory of ["real/skills", "hops", ".ave", "cmds-real"]) mkdirSync(join(project, directory), { recursive: true });
    symlinkSync("hops/l1", join(project, ".agents"));
    symlinkSync("../l2", join(project, "hops", "l1"));
    symlinkSync("real", join(project, "l2"));
    symlinkSync("../cmds", join(project, ".ave", "commands"));
    symlinkSync("cmds-real", join(project, "cmds"));
    const result = await runConfined([
      `mkdir fresh`,
      `rm hops/l1 2>/dev/null; echo "remove-first=$?"`,
      `ln -sfn ../fresh hops/l1 2>/dev/null; echo "replace-first=$?"`,
      `mv hops hops-moved 2>/dev/null; echo "move-above-first=$?"`,
      `rm l2 2>/dev/null; echo "remove-second=$?"`,
      `ln -s fresh staged && mv -f staged l2 2>/dev/null; echo "rename-over-second=$?"`,
      `rm cmds 2>/dev/null; echo "remove-commands-hop=$?"`,
      `mkdir -p .agents/skills 2>/dev/null; printf x > .agents/skills/planted 2>/dev/null; echo "plant=$?"`,
      `printf x > .ave/commands/planted.md 2>/dev/null; echo "plant-command=$?"`,
      `printf x > hops/other.txt; echo "beside-link=$?"`,
    ].join("\n"), project);
    expect(statuses(result.stdout)).toEqual({
      "remove-first": "1", "replace-first": "1", "move-above-first": "1", "remove-second": "1", "rename-over-second": "1",
      "remove-commands-hop": "1", plant: "1", "plant-command": "1", "beside-link": "0",
    });
    expect(readdirSync(join(project, "fresh"))).toEqual([]);
    expect(readdirSync(join(project, "real", "skills"))).toEqual([]);
    expect(readdirSync(join(project, "cmds-real"))).toEqual([]);
  });

  it("refuses the wrap when an entry links to a work folder or a folder that holds one", async () => {
    const same = join(root, "self");
    mkdirSync(same);
    symlinkSync(".", join(same, ".agents"));
    await expect(runConfined("true", same)).rejects.toThrow(t("sandboxPolicy.namedEntryLinksToWriteRoot", { entry: ".agents" }));
    const outer = join(root, "outer");
    const inner = join(outer, "inner");
    mkdirSync(join(inner, ".ave"), { recursive: true });
    symlinkSync("../..", join(inner, ".ave", "hooks"));
    await expect(runConfined("true", inner, [inner, outer])).rejects.toThrow(t("sandboxPolicy.namedEntryLinksToWriteRoot", { entry: ".ave/hooks" }));
  });

  // A working folder may carry a character the write policy reads as a pattern.
  it.each(["a?b", "s*r", "k[1]"])("holds the entries beneath a root named %s", async name => {
    const project = join(root, name);
    mkdirSync(project);
    const result = await runConfined([
      `mkdir .agents 2>/dev/null; echo "agents=$?"`,
      `mkdir -p .ave/commands 2>/dev/null; echo "ave=$?"`,
      `printf x > ordinary.txt; echo "ordinary=$?"`,
    ].join("\n"), project);
    expect(statuses(result.stdout)).toEqual({ agents: "1", ave: "1", ordinary: "0" });
  });

  it("loads and holds the entries beneath a long root whose name takes several bytes a character", async () => {
    // About 905 bytes of path: under the character count of one pattern for every name, over Seatbelt's limit in bytes.
    let project = root;
    while (Buffer.byteLength(project) < 905) project = join(project, "가".repeat(Math.min(70, Math.ceil((905 - Buffer.byteLength(project)) / 3))));
    mkdirSync(project, { recursive: true });
    const result = await runConfined([
      `mkdir .agents 2>/dev/null; echo "agents=$?"`,
      `mkdir -p .ave/hooks 2>/dev/null; echo "ave=$?"`,
      `printf x > ordinary.txt; echo "ordinary=$?"`,
    ].join("\n"), project);
    expect(statuses(result.stdout)).toEqual({ agents: "1", ave: "1", ordinary: "0" });
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
