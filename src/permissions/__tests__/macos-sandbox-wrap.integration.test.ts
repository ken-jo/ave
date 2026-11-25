import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { cleanupAsrtSandboxAfterCommand, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";

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
    const result = spawnSync(wrapped.argv[0]!, wrapped.argv.slice(1), {
      cwd: directory, env: { ...process.env, ...wrapped.env }, encoding: "utf8", timeout: TOOL_TIMEOUT_POLICY.shellDefaultMs,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).not.toBe(71);
    return result;
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
    const before = new Set(readdirSync(temp));
    await initializeRequiredSandbox({ allowedDomains: [] });
    const created = readdirSync(temp).filter(name => name.startsWith("srt-sock-") && !before.has(name));
    expect(created).toHaveLength(1);
    socketDirectory = join(temp, created[0]!);
  });
  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("keeps another run's backend socket from being removed, renamed or replaced while the temp root stays writable", async () => {
    const sockets = readdirSync(socketDirectory);
    expect(sockets.length).toBeGreaterThan(0);
    const socket = join(socketDirectory, sockets[0]!);
    const control = join(temp, "sandbox-socket-floor-control");
    const result = await runConfined([
      `rm -f '${socket}' 2>/dev/null; test -e '${socket}'; echo "unlink=$?"`,
      `mv '${socket}' '${socket}.moved' 2>/dev/null; echo "rename=$?"`,
      `printf x > '${socketDirectory}/planted' 2>/dev/null; echo "plant=$?"`,
      `mv '${socketDirectory}' '${socketDirectory}-moved' 2>/dev/null; echo "rename-directory=$?"`,
      `rm -rf '${socketDirectory}' 2>/dev/null; test -d '${socketDirectory}'; echo "remove-directory=$?"`,
      `printf x > '${control}' && rm '${control}'; echo "temp-write=$?"`,
      `printf x > ordinary; echo "project-write=$?"`,
    ].join("\n"), root, [root, temp]);
    expect(statuses(result.stdout)).toEqual({
      unlink: "0", rename: "1", plant: "1", "rename-directory": "1", "remove-directory": "0", "temp-write": "0", "project-write": "0",
    });
    expect(readdirSync(socketDirectory)).toEqual(sockets);
  });
});
