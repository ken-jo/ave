import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withSourceHostResources } from "../../__tests__/support/source-host-resources.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { holdHostShellSpawnDirectory, HostShellDirectoryHoldError, type HostShellSpawnDirectoryHold } from "../host-shell-execution-permit.js";
import { captureShellWorkingDirectoryIdentity } from "../shell-working-directory-identity.js";

const helpers = vi.hoisted(() => ({ spawned: [] as import("node:child_process").ChildProcess[] }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      if (String(args[0]).endsWith("ave-path-kind.exe")) helpers.spawned.push(child);
      return child;
    },
  };
});

withSourceHostResources();

const refused = (action: () => void): string | undefined => {
  try {
    action();
    return undefined;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code;
  }
};

describe.runIf(process.platform === "win32")("host shell spawn directory hold", () => {
  let root: string;
  let parent: string;
  let leaf: string;
  let hold: HostShellSpawnDirectoryHold | undefined;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ave-cwd-hold-")));
    parent = join(root, "parent");
    leaf = join(parent, "leaf");
    mkdirSync(leaf, { recursive: true });
    mkdirSync(join(root, "sibling"));
    hold = undefined;
    helpers.spawned = [];
  });
  afterEach(async () => {
    hold?.dispose();
    await vi.waitFor(() => expect(refused(() => renameSync(parent, join(root, "released")))).toBeUndefined());
    await cleanupTmpDir(root);
  });

  const identityOf = (path: string) => {
    const identity = captureShellWorkingDirectoryIdentity(path);
    if (identity === undefined) throw new Error("directory identity unavailable");
    return identity;
  };
  const holdLeaf = async () => {
    const held = await holdHostShellSpawnDirectory({ cwdIdentity: identityOf(leaf) });
    hold = held;
    return held;
  };
  const killHelper = async () => {
    const [helper] = helpers.spawned;
    if (helper === undefined) throw new Error("no hold helper");
    helper.kill();
    await new Promise(resolve => helper.exitCode !== null || helper.signalCode !== null ? resolve(undefined) : helper.once("exit", resolve));
  };
  const longChild = (): ChildProcess => spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore", windowsHide: true });
  const closed = (child: ChildProcess) => new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve(undefined) : child.once("close", resolve));

  it("refuses rename and delete of the directory and its ancestors while held, and leaves a sibling alone", async () => {
    await holdLeaf();
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(refused(() => rmdirSync(leaf))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(refused(() => renameSync(parent, join(root, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    expect(existsSync(leaf)).toBe(true);
    expect(refused(() => renameSync(join(root, "sibling"), join(root, "sibling-moved")))).toBeUndefined();
  });

  it("releases on dispose when no child was bound", async () => {
    (await holdLeaf()).dispose();
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined());
  });

  it("keeps a bound hold past dispose until the child closes", async () => {
    const held = await holdLeaf();
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300)"], { stdio: "ignore", windowsHide: true });
    held.bind(child);
    held.dispose();
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    await new Promise(resolve => child.once("close", resolve));
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined());
  });

  it("refuses a directory replaced at the approved path", async () => {
    const identity = identityOf(leaf);
    renameSync(leaf, join(parent, "original"));
    mkdirSync(leaf);
    await expect(holdHostShellSpawnDirectory({ cwdIdentity: identity })).rejects.toBeInstanceOf(HostShellDirectoryHoldError);
  });

  it("keeps the hold through an error from a started child until it closes", async () => {
    const held = await holdLeaf();
    const child = longChild();
    held.bind(child);
    child.emit("error", new Error("termination failed"));
    // A release would end the helper asynchronously; give it time to show.
    await new Promise(resolve => setTimeout(resolve, 750));
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toMatch(/^(EBUSY|EPERM|EACCES)$/u);
    child.kill();
    await closed(child);
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined());
  });

  it("frees the hold when the child never started", async () => {
    const held = await holdLeaf();
    const child = spawn(join(root, "missing.exe"), [], { stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    held.bind(child);
    await vi.waitFor(() => expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined());
  });

  it("refuses a launch once the helper has exited after its reply", async () => {
    const held = await holdLeaf();
    held.assertHeld();
    await killHelper();
    expect(() => held.assertHeld()).toThrow(HostShellDirectoryHoldError);
    expect(refused(() => renameSync(leaf, join(parent, "moved")))).toBeUndefined();
  });

  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  // The command starts a descendant that keeps the output pipe and prints its PID.
  const launchTree = (held: HostShellSpawnDirectoryHold) => {
    const script = "const c = require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { stdio: 'inherit' });" +
      "console.log(c.pid); setTimeout(() => {}, 20000);";
    const target = held.command(process.execPath, ["-e", script]);
    const child = spawn(target.executable, target.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    held.bind(child);
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    return { child, output: () => output };
  };

  it("lets the OS stop the command and its descendant when the helper exits", async () => {
    const held = await holdLeaf();
    const { child, output } = launchTree(held);
    await vi.waitFor(() => expect(output()).toMatch(/^\d+/u), { timeout: 5000 });
    const descendant = Number.parseInt(output(), 10);
    expect(alive(descendant)).toBe(true);
    const started = Date.now();
    await killHelper();
    await closed(child);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(child.exitCode).toBe(125);
    expect(output()).toContain("cwd-pin-lost");
    expect(alive(descendant)).toBe(false);
  });

  it("runs a command to completion and reports its own exit code once its job is empty", async () => {
    const held = await holdLeaf();
    const target = held.command(process.execPath, ["-e", "process.exitCode = 7"]);
    const child = spawn(target.executable, target.args, { stdio: "ignore", windowsHide: true });
    held.bind(child);
    await closed(child);
    expect(child.exitCode).toBe(7);
  });

  it("refuses to start a command after the helper has gone", async () => {
    const held = await holdLeaf();
    await killHelper();
    const target = held.command(process.execPath, ["-e", "require('fs').writeFileSync('ran', '')"]);
    const child = spawn(target.executable, target.args, { cwd: root, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    held.bind(child);
    await closed(child);
    expect(child.exitCode).toBe(125);
    expect(stderr).toContain("cwd-pin-lost");
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  it("refuses a hold pipe whose server is not the named helper", async () => {
    const held = await holdLeaf();
    const target = held.command(process.execPath, ["-e", "require('fs').writeFileSync('ran', '')"]);
    const args = [...target.args];
    args[2] = String(process.pid);
    const child = spawn(target.executable, args, { cwd: root, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    await closed(child);
    expect(child.exitCode).toBe(125);
    expect(stderr).toContain("cwd-pin-lost");
    expect(existsSync(join(root, "ran"))).toBe(false);
    held.dispose();
  });

  it("releases once however close, dispose and helper loss interleave", async () => {
    for (const order of ["close-first", "loss-first"] as const) {
      const held = await holdLeaf();
      const [helper] = helpers.spawned.slice(-1);
      if (helper === undefined) throw new Error("no hold helper");
      const kill = vi.spyOn(helper, "kill");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"], { stdio: "ignore", windowsHide: true });
      held.bind(child);
      if (order === "loss-first") {
        helper.kill();
        kill.mockClear();
        await new Promise(resolve => helper.once("exit", resolve));
      }
      await closed(child);
      held.dispose();
      held.dispose();
      expect(kill).toHaveBeenCalledTimes(1);
      expect(child.exitCode).toBe(0);
      hold = undefined;
    }
  });
});
