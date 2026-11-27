import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { realpathSync, statSync } from "node:fs";
import { Duplex, PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeMxcFrame, MxcFrameDecoder } from "../mxc-extension-protocol.js";
import { MxcProcessContractError } from "../mxc-extension-errors.js";
import { startMxcShellSupervisor } from "../mxc-shell-supervisor-client.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));
vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: vi.fn(),
  trackManagedChildProcess: vi.fn(),
}));

const REFUSAL = { type: "error", code: "start-refused", sdkCode: "malformed_request", message: "Start refused" } as const;
const BACKEND_LOSS = { type: "error", code: "capability-unavailable", backendLoss: "common", message: "Backend unavailable" } as const;

function launchShell(options: {
  readonly authorize?: (grant: () => boolean) => Promise<boolean>;
  readonly cwdIdentity?: { realpath: string; dev: string; ino: string };
} = {}) {
  const owner = new PassThrough();
  const written: Buffer[] = [];
  const control = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) { written.push(chunk); callback(); },
  });
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid: 42, exitCode: null as number | null, signalCode: null, stdout, stderr, stdio: [null, stdout, stderr, owner, control],
    kill: vi.fn(),
  });
  const mockSpawn = vi.mocked(spawn);
  mockSpawn.mockReturnValueOnce(child as unknown as ChildProcess);
  const revoke = vi.fn();
  const { completion } = startMxcShellSupervisor(
    { type: "shell-start", requestPath: process.cwd(), requestSha256: "a".repeat(64), cwdIdentity: options.cwdIdentity ?? { realpath: process.cwd(), dev: "1", ino: "2" } },
    5_000, undefined, revoke, "test:shell-receipt", { entry: "unit-entry", nodeModules: "unit-modules", isPackaged: false }, options.authorize,
  );
  const args = mockSpawn.mock.calls[0]?.[1];
  const generation = Array.isArray(args) ? args[2] : undefined;
  if (typeof generation !== "string") throw new Error("Shell supervisor generation was not supplied");
  const key = owner.read() as Buffer;
  const finish = (packet: Buffer) => {
    control.push(packet);
    control.push(null);
    stdout.end().resume();
    stderr.end().resume();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return completion;
  };
  /** The frame types the host has written so far, after the shell-start. */
  const hostFrames = (): string[] => {
    const decoder = new MxcFrameDecoder(generation, key, "host");
    return written.flatMap((chunk) => [...decoder.read(chunk)].map((frame) => frame.type));
  };
  return { header: { version: 1, generation, sequence: 0 } as const, key, finish, revoke, control, hostFrames };
}

function ownCwdIdentity() {
  const stats = statSync(process.cwd(), { bigint: true });
  return { realpath: realpathSync.native(process.cwd()), dev: String(stats.dev), ino: String(stats.ino) };
}

afterEach(async () => {
  await setImmediate();
  vi.mocked(spawn).mockReset();
});

describe("macOS shell grant before user code", () => {
  it("grants a verified workload through the caller's final check while the staged cwd still matches", async () => {
    const authorize = vi.fn((grant: () => boolean) => Promise.resolve(grant()));
    const { header, key, control, hostFrames, finish } = launchShell({ authorize, cwdIdentity: ownCwdIdentity() });
    control.push(encodeMxcFrame({ ...header, type: "shell-cwd-verified", id: 7 }, key, "supervisor"));
    await vi.waitFor(() => expect(hostFrames()).toEqual(["shell-start", "spawn-authorized"]));
    control.push(encodeMxcFrame({ ...header, sequence: 1, type: "shell-ready", id: 7 }, key, "supervisor"));
    const exit = encodeMxcFrame({ ...header, sequence: 2, type: "exit", exitCode: 197, timedOut: false }, key, "supervisor");
    expect(await finish(exit)).toEqual({ code: 197, timedOut: false, cancelled: false, rejected: false, cleanupUnverified: false });
    expect(authorize).toHaveBeenCalledOnce();
  });

  it.each([
    ["the caller's check refuses", () => Promise.resolve(false), ownCwdIdentity],
    ["the caller's check throws", () => Promise.reject(new Error("admission")), ownCwdIdentity],
    ["the staged cwd no longer matches", (grant: () => boolean) => Promise.resolve(grant()), () => ({ ...ownCwdIdentity(), ino: "1" })],
  ] as const)("withholds the grant and stops the run when %s, reporting nothing ran", async (_case, authorize, identity) => {
    const { header, key, control, hostFrames, finish } = launchShell({ authorize, cwdIdentity: identity() });
    control.push(encodeMxcFrame({ ...header, type: "shell-cwd-verified", id: 7 }, key, "supervisor"));
    await vi.waitFor(() => expect(hostFrames()).toContain("stop"));
    expect(hostFrames()).not.toContain("spawn-authorized");
    const stopped = encodeMxcFrame({ ...header, sequence: 1, type: "stopped", spawnPendingAtCancellation: false }, key, "supervisor");
    expect(await finish(stopped)).toMatchObject({ rejected: true, grantWithheld: true, cancelled: false, cleanupUnverified: false });
  });

  it("refuses a ready frame before the workload's verified cwd as a protocol failure", async () => {
    const { header, key, finish, revoke } = launchShell({ cwdIdentity: ownCwdIdentity() });
    const ready = encodeMxcFrame({ ...header, type: "shell-ready", id: 7 }, key, "supervisor");
    expect(await finish(ready)).toMatchObject({ cleanupUnverified: true, startFailed: true });
    expect(revoke).toHaveBeenCalled();
  });
});

describe("macOS shell receipts", () => {
  it("treats an authenticated backend-loss field as a protocol failure with cleanup unverified", async () => {
    const { header, key, finish, revoke } = launchShell();
    const packet = encodeMxcFrame({ ...header, ...BACKEND_LOSS }, key, "supervisor", "windows-extension");
    const result = await finish(packet);
    expect(result).toEqual({ code: null, timedOut: false, cancelled: false, rejected: false, cleanupUnverified: true, startFailed: true });
    expect(revoke).toHaveBeenCalled();
  });

  it("keeps the SDK code on a valid start refusal", async () => {
    const { header, key, finish } = launchShell();
    const frame = { ...header, ...REFUSAL };
    const packet = encodeMxcFrame(frame, key, "supervisor");
    expect(await finish(packet)).toMatchObject({ rejected: true, cleanupUnverified: false, failure: frame });
  });

  it("reserves encoding of backend-loss metadata for the Windows extension", () => {
    const frame = { version: 1, generation: "b".repeat(64), sequence: 0, ...BACKEND_LOSS } as const;
    expect(() => encodeMxcFrame(frame, Buffer.alloc(32), "supervisor")).toThrow(MxcProcessContractError);
  });

  it("reserves release metadata for the Windows extension in both directions", () => {
    const generation = "b".repeat(64);
    const key = Buffer.alloc(32);
    const frame = {
      version: 1, generation, sequence: 0, type: "spawn-authorized", releasePath: "release", releaseDigest: "a".repeat(64),
    } as const;
    const packet = encodeMxcFrame(frame, key, "host", "windows-extension");
    const extensionDecoder = new MxcFrameDecoder(generation, key, "host", "windows-extension");
    expect([...extensionDecoder.read(packet)]).toEqual([frame]);
    const shellDecoder = new MxcFrameDecoder(generation, key, "host");
    expect(() => [...shellDecoder.read(packet)]).toThrow(MxcProcessContractError);
    expect(() => encodeMxcFrame(frame, key, "host")).toThrow(MxcProcessContractError);
  });
});
