vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

// Holder grants must name the holder PID, revoke on failure, report holder death and release idempotently. This suite records grant operations; native ACL admission needs a provisioned host.
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeHolder = EventEmitter & {
  pid: number | undefined;
  stdin: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
};

const spawned = vi.hoisted(() => ({ holders: [] as FakeHolder[], calls: [] as unknown[][], nextPid: 7000 as number | undefined }));
vi.mock("node:child_process", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  const { PassThrough: Pass } = await import("node:stream");
  return {
    spawn: (...args: unknown[]) => {
      spawned.calls.push(args);
      const holder = Object.assign(new Emitter(), {
        pid: spawned.nextPid,
        stdin: new Pass(),
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: vi.fn(),
      }) as FakeHolder;
      spawned.holders.push(holder);
      return holder;
    },
  };
});

vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: () => {},
  trackManagedChildProcess: () => () => {},
}));

const grants = vi.hoisted(() => ({
  calls: [] as Array<{ holderPid: number; allowRead?: readonly string[]; allowWrite?: readonly string[] }>,
  released: 0,
  fail: undefined as Error | undefined,
}));
vi.mock("../asrt-sandbox.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../asrt-sandbox.js")>()),
  grantWindowsWorkerFilesystemAccess: async (opts: { holderPid: number; allowRead?: readonly string[]; allowWrite?: readonly string[] }) => {
    grants.calls.push(opts);
    if (grants.fail) throw grants.fail;
    return {
      allowRead: opts.allowRead ?? [],
      allowWrite: opts.allowWrite ?? [],
      release: () => {
        grants.released += 1;
      },
    };
  },
}));

import { holdWindowsFilesystemGrant } from "../windows-acl-grant-holder.js";
import { pluginGrantPathsBeyondOwnRoots } from "../asrt-sandbox.js";

const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };

beforeEach(() => {
  spawned.holders.length = 0;
  spawned.calls.length = 0;
  spawned.nextPid = 7000;
  grants.calls.length = 0;
  grants.released = 0;
  grants.fail = undefined;
  process.env.SystemRoot = "C:\\Windows";
});

afterEach(() => {
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function holderStopped(holder: FakeHolder): boolean {
  return holder.stdin.writableEnded || holder.kill.mock.calls.length > 0;
}

describe("holdWindowsFilesystemGrant", () => {
  it("grants exactly the named paths against a pinned System32 holder's pid", async () => {
    const held = await holdWindowsFilesystemGrant({
      label: "plugin-child:p:asrt-win-acl",
      allowRead: ["C:\\a", "C:\\b"],
      allowWrite: ["C:\\b"],
    });
    expect(spawned.calls).toHaveLength(1);
    const [command, args, opts] = spawned.calls[0] as [string, string[], { shell: boolean; env: NodeJS.ProcessEnv }];
    expect(command).toBe("C:\\Windows\\System32\\more.com");
    expect(args).toEqual([]);
    expect(opts.shell).toBe(false);
    expect(opts.env.PATH).toBeUndefined();
    expect(grants.calls).toEqual([{ holderPid: 7000, allowRead: ["C:\\a", "C:\\b"], allowWrite: ["C:\\b"] }]);
    expect(() => held.assertAlive()).not.toThrow();
    expect(holderStopped(spawned.holders[0]!)).toBe(false);
    held.release();
    held.release();
    expect(grants.released).toBe(1);
    expect(holderStopped(spawned.holders[0]!)).toBe(true);
  });

  it("stops the holder and rethrows when the grant fails, leaving nothing held", async () => {
    grants.fail = new Error("srt-win acl grant failed");
    await expect(
      holdWindowsFilesystemGrant({ label: "x", allowRead: ["C:\\a"], allowWrite: [] }),
    ).rejects.toThrow("srt-win acl grant failed");
    expect(grants.released).toBe(0);
    expect(holderStopped(spawned.holders[0]!)).toBe(true);
  });

  it("revokes and refuses when the holder died while the grant was being made", async () => {
    const pending = holdWindowsFilesystemGrant({ label: "x", allowRead: ["C:\\a"], allowWrite: [] });
    spawned.holders[0]!.emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/x: grant holder exited before release \(code=1 signal=null\)/);
    expect(grants.released).toBe(1);
  });

  it("refuses a holder that started without a pid, before any grant", async () => {
    spawned.nextPid = undefined;
    await expect(holdWindowsFilesystemGrant({ label: "x", allowRead: [], allowWrite: [] })).rejects.toThrow(
      /started without a pid/,
    );
    expect(grants.calls).toHaveLength(0);
  });

  it("reports a holder lost after the grant, once, to listeners added before and after", async () => {
    const held = await holdWindowsFilesystemGrant({ label: "x", allowRead: ["C:\\a"], allowWrite: [] });
    const early = vi.fn();
    held.onLost(early);
    spawned.holders[0]!.emit("exit", null, "SIGKILL");
    spawned.holders[0]!.emit("error", new Error("late"));
    expect(early).toHaveBeenCalledTimes(1);
    expect(() => held.assertAlive()).toThrow(/grant holder exited before release/);
    const late = vi.fn();
    held.onLost(late);
    expect(late).toHaveBeenCalledTimes(1);
    held.release();
    expect(grants.released).toBe(1);
  });

  it("does not report the holder's own stop on release as a loss", async () => {
    const held = await holdWindowsFilesystemGrant({ label: "x", allowRead: ["C:\\a"], allowWrite: [] });
    const lost = vi.fn();
    held.onLost(lost);
    held.release();
    spawned.holders[0]!.emit("exit", 0, null);
    expect(lost).not.toHaveBeenCalled();
    expect(() => held.assertAlive()).not.toThrow();
  });
});

describe("pluginGrantPathsBeyondOwnRoots", () => {
  let home: string;
  const previous = process.env.AVE_HOME;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "win-grant-roots-"));
    process.env.AVE_HOME = home;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previous;
    rmSync(home, { recursive: true, force: true });
  });

  it("admits the plugin's own install, data and generation, and anything outside the plugin-owned roots", () => {
    const own = [
      join(home, "plugins", "p"),
      join(home, "plugins", "p", "data"),
      join(home, "plugins", "p", "sockets"),
      join(home, "plugins", ".cache", "p", "g1"),
      join(tmpdir(), "ave-sandbox-home-x"),
      join(home, "sandbox", "home"),
    ];
    expect(pluginGrantPathsBeyondOwnRoots("p", own)).toEqual([]);
  });

  it("refuses a neighbour, a neighbour's generation, the agent roots, and any root or ancestor of one", () => {
    const beyond = [
      join(home, "plugins", "q"),
      join(home, "plugins", "pq"),
      join(home, "plugins", ".cache", "q", "g1"),
      join(home, "plugins", ".cache"),
      join(home, "plugins"),
      join(home, "agent-plugin-data", "p"),
      join(home, "packages", "agent-plugin", "p"),
      join(home, "packages"),
      home,
      join(home, ".."),
    ];
    expect(pluginGrantPathsBeyondOwnRoots("p", beyond)).toEqual(beyond);
  });

  it("is case-insensitive on Windows, where the filesystem is", () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      expect(pluginGrantPathsBeyondOwnRoots("p", [join(home, "PLUGINS", "Q")])).toEqual([join(home, "PLUGINS", "Q")]);
      expect(pluginGrantPathsBeyondOwnRoots("p", [join(home, "Plugins", "P", "data")])).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
