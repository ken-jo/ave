import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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

function launchShell() {
  const owner = new PassThrough();
  const control = new Duplex({
    read() {},
    write(_chunk, _encoding, callback) { callback(); },
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
    { type: "shell-start", requestPath: process.cwd(), requestSha256: "a".repeat(64) },
    5_000, undefined, revoke, "test:shell-receipt", { entry: "unit-entry", nodeModules: "unit-modules", isPackaged: false },
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
  return { header: { version: 1, generation, sequence: 0 } as const, key, finish, revoke };
}

afterEach(async () => {
  await setImmediate();
  vi.mocked(spawn).mockReset();
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
