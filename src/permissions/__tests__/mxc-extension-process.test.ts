import { createHmac } from "node:crypto";
import { createMxcNativeProcess } from "../../__tests__/support/mxc-supervisor.js";
import { describe, expect, it, vi } from "vitest";
import { MxcNativeProcess } from "../mxc-native-process.js";
import { MxcProcessCleanupError, MxcProcessContractError, MxcSupervisorLostError } from "../mxc-extension-errors.js";
import { encodeMxcFrame, MxcFrameDecoder, MXC_FRAME_MAX_BYTES, MXC_STREAM_CHUNK_BYTES, type MxcStreamFrame } from "../mxc-extension-protocol.js";

const GENERATION = "a".repeat(64);
const KEY = Buffer.alloc(32, 1);
const encode = (frame: MxcStreamFrame) => encodeMxcFrame(frame, KEY, "supervisor");

describe("owned native process state machine", () => {
  it("takes every stream before wait and disposes once after terminal drain", async () => {
    const fixture = createMxcNativeProcess();
    const process = new MxcNativeProcess(fixture.native);
    expect(fixture.accesses).toEqual(["stdin", "stdout", "stderr", "wait"]);
    expect(process.id).toBe(42);
    const stop = process.dispose();
    expect(process.dispose()).toBe(stop);
    await stop;
    expect(process.state).toBe("terminated");
    expect(fixture.native.kill).toHaveBeenCalledOnce();
    expect(fixture.native.dispose).toHaveBeenCalledOnce();
  });

  it("drains unread output on stop", async () => {
    const fixture = createMxcNativeProcess();
    const process = new MxcNativeProcess(fixture.native);
    fixture.stdout.write(Buffer.alloc(128 * 1024));
    fixture.stderr.write(Buffer.alloc(128 * 1024));
    await process.dispose();
    expect(fixture.stdout.readableEnded).toBe(true);
    expect(fixture.stderr.readableEnded).toBe(true);
  });

  it("does not report death after wait rejection", async () => {
    const fixture = createMxcNativeProcess();
    const process = new MxcNativeProcess(fixture.native);
    fixture.reject(new Error("native ownership lost"));
    await expect(process.completion).rejects.toBeInstanceOf(MxcSupervisorLostError);
    await expect(process.dispose()).rejects.toBeInstanceOf(MxcProcessCleanupError);
    expect(process.state).toBe("cleanup-failed");
    expect(fixture.native.dispose).toHaveBeenCalledOnce();
  });

  it("surfaces synchronous disposal failure after a settled exit", async () => {
    const fixture = createMxcNativeProcess();
    fixture.native.dispose.mockImplementation(() => { throw new Error("free failed"); });
    const process = new MxcNativeProcess(fixture.native);
    await expect(process.dispose()).rejects.toBeInstanceOf(MxcProcessCleanupError);
    expect(process.state).toBe("cleanup-failed");
  });

  it("bounds cleanup without treating disposal as death", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createMxcNativeProcess();
      fixture.native.kill.mockImplementation(() => {});
      const process = new MxcNativeProcess(fixture.native);
      const outcome = process.dispose().catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await outcome).toBeInstanceOf(MxcProcessCleanupError);
      expect(process.state).toBe("cleanup-failed");
      expect(fixture.native.dispose).toHaveBeenCalledOnce();
      fixture.reject(new Error("disposed"));
    } finally { vi.useRealTimers(); }
  });

  it("retains cleanup failure after a late native completion", async () => {
    vi.useFakeTimers();
    try {
      const fixture = createMxcNativeProcess();
      fixture.native.kill.mockImplementation(() => {});
      const process = new MxcNativeProcess(fixture.native);
      const outcome = process.dispose().catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      expect(await outcome).toBeInstanceOf(MxcProcessCleanupError);
      fixture.resolve({ exitCode: 0, timedOut: false });
      await process.completion;
      expect(process.state).toBe("cleanup-failed");
      fixture.stdout.end(); fixture.stderr.end();
    } finally { vi.useRealTimers(); }
  });

  it("cleans up when initial wait throws synchronously", () => {
    const fixture = createMxcNativeProcess();
    fixture.native.wait.mockImplementation(() => { throw new Error("wait failed"); });
    expect(() => new MxcNativeProcess(fixture.native)).toThrow(MxcProcessContractError);
    expect(fixture.native.kill).toHaveBeenCalledOnce();
    expect(fixture.native.dispose).toHaveBeenCalledOnce();
  });

  it("preserves a malformed completion as a contract failure", async () => {
    const fixture = createMxcNativeProcess();
    const process = new MxcNativeProcess(fixture.native);
    fixture.resolve({ exitCode: NaN, timedOut: false });
    await expect(process.completion).rejects.toBeInstanceOf(MxcProcessContractError);
    await expect(process.dispose()).rejects.toBeInstanceOf(MxcProcessCleanupError);
  });

  it("refuses missing native endpoints", () => {
    const fixture = createMxcNativeProcess();
    expect(() => new MxcNativeProcess({ ...fixture.native, standardError: null })).toThrow(MxcProcessContractError);
    expect(fixture.native.kill).toHaveBeenCalledOnce();
    expect(fixture.native.dispose).toHaveBeenCalledOnce();
  });
});

describe("bounded supervisor frames", () => {
  it.each(["integrity", "capability-unavailable", "contract", "supervisor-lost", "cleanup-unverified"] as const)("round trips the typed failure code %s", (code) => {
    const frame: MxcStreamFrame = { version: 1, generation: GENERATION, sequence: 0, type: "error", code, message: "Rejected" };
    expect([...new MxcFrameDecoder(GENERATION, KEY, "supervisor").read(encode(frame))]).toEqual([frame]);
  });

  it.each(["creating", "spawning"] as const)("authenticates the native creation receipt %s", (type) => {
    const frame: MxcStreamFrame = { version: 1, generation: GENERATION, sequence: 0, type };
    expect([...new MxcFrameDecoder(GENERATION, KEY, "supervisor").read(encode(frame))]).toEqual([frame]);
  });

  it.each([false, true])("authenticates the pending-spawn cancellation observation %s", (spawnPendingAtCancellation) => {
    const frame: MxcStreamFrame = { version: 1, generation: GENERATION, sequence: 0, type: "stopped", spawnPendingAtCancellation };
    expect([...new MxcFrameDecoder(GENERATION, KEY, "supervisor").read(encode(frame))]).toEqual([frame]);
  });

  it.each(["0", "-1", "01", "18446744073709551616", "not-a-handle"])("rejects the invalid liveness handle diagnostic %s", (ownerHandle) => {
    expect(() => encode({ version: 1, generation: GENERATION, sequence: 0, type: "ready", id: 42, nodeVersion: "24.22.1", nativeModules: [], ownerHandle })).toThrow(MxcProcessContractError);
  });

  it("round trips the maximum unsigned native liveness handle diagnostic", () => {
    const frame: MxcStreamFrame = { version: 1, generation: GENERATION, sequence: 0, type: "ready", id: 42, nodeVersion: "24.22.1", nativeModules: [], ownerHandle: "18446744073709551615" };
    expect([...new MxcFrameDecoder(GENERATION, KEY, "supervisor").read(encode(frame))]).toEqual([frame]);
  });

  it("round trips binary chunks across arbitrary boundaries", () => {
    const data = Buffer.from([0, 255, 10, 13, 128]);
    const frame = { version: 1 as const, generation: GENERATION, sequence: 0, type: "stdout" as const, data: data.toString("base64") };
    const bytes = encode(frame);
    const decoder = new MxcFrameDecoder(GENERATION, KEY, "supervisor");
    const received = [...bytes].flatMap((byte) => [...decoder.read(Buffer.from([byte]))]);
    expect(received).toEqual([frame]);
    decoder.end();
  });

  it("handles coalesced frames and rejects replay or another generation", () => {
    const frame = { version: 1 as const, generation: GENERATION, sequence: 0, type: "stop" as const };
    const decoder = new MxcFrameDecoder(GENERATION, KEY, "supervisor");
    expect([...decoder.read(Buffer.concat([encode(frame), encode({ ...frame, sequence: 1 })]))]).toHaveLength(2);
    expect(() => [...decoder.read(encode(frame))]).toThrow(MxcProcessContractError);
    expect(() => [...new MxcFrameDecoder("b".repeat(64), KEY, "supervisor").read(encode(frame))]).toThrow(MxcProcessContractError);
  });

  it("refuses excessive lengths before allocating a body", () => {
    for (const length of [0, MXC_FRAME_MAX_BYTES + 1, 0xffffffff]) {
      const header = Buffer.alloc(4); header.writeUInt32BE(length);
      const decoder = new MxcFrameDecoder(GENERATION, KEY, "supervisor");
      expect(() => [...decoder.read(header)]).toThrow(MxcProcessContractError);
      expect(() => [...decoder.read(Buffer.alloc(1))]).toThrow(MxcProcessContractError);
    }
    expect(() => encode({ version: 1, generation: GENERATION, sequence: 0, type: "stdin", data: Buffer.alloc(MXC_STREAM_CHUNK_BYTES + 1).toString("base64") })).toThrow(MxcProcessContractError);
  });

  it("refuses malformed JSON, unknown fields, invalid base64 and truncated EOF", () => {
    const bodies = ["{", JSON.stringify({ version: 1, generation: GENERATION, sequence: 0, type: "stop", extra: true }), JSON.stringify({ version: 1, generation: GENERATION, sequence: 0, type: "stdin", data: "??" })];
    for (const text of bodies) {
      const body = Buffer.from(text), header = Buffer.alloc(4); header.writeUInt32BE(body.length + 32);
      const mac = createHmac("sha256", KEY).update("supervisor").update(body).digest();
      expect(() => [...new MxcFrameDecoder(GENERATION, KEY, "supervisor").read(Buffer.concat([header, body, mac]))]).toThrow(MxcProcessContractError);
    }
    const decoder = new MxcFrameDecoder(GENERATION, KEY, "supervisor");
    expect([...decoder.read(Buffer.from([0]))]).toEqual([]);
    expect(() => decoder.end()).toThrow(MxcProcessContractError);
  });
});

describe("supervisor frame authentication", () => {
  it("rejects forged keys, direction reflection and modified payloads", () => {
    const frame = { version: 1 as const, generation: GENERATION, sequence: 0, type: "stop" as const };
    const packet = encode(frame);
    expect(() => [...new MxcFrameDecoder(GENERATION, Buffer.alloc(32, 2), "supervisor").read(packet)]).toThrow(/authentication/);
    expect(() => [...new MxcFrameDecoder(GENERATION, KEY, "host").read(packet)]).toThrow(/authentication/);
    const changed = Buffer.from(packet); changed[8] ^= 1;
    expect(() => [...new MxcFrameDecoder(GENERATION, KEY, "supervisor").read(changed)]).toThrow(/authentication/);
  });
});


describe("bounded native dependency diagnostics", () => {
  it("admits the full module snapshot only within the frame and module-count limits", () => {
    const frame: MxcStreamFrame = { version: 1, generation: GENERATION, sequence: 0, type: "ready", id: 42,
      nodeVersion: "24.22.1", ownerHandle: "5", nativeModules: Array.from({ length: 256 }, (_, index) => "C:\\Windows\\System32\\dependency" + index + ".dll") };
    expect(() => encode(frame)).not.toThrow();
    expect(() => encode({ ...frame, nativeModules: [...frame.nativeModules, "extra.dll"] })).toThrow(MxcProcessContractError);
    expect(() => encode({ ...frame, nativeModules: Array(256).fill("x".repeat(300)) })).toThrow(MxcProcessContractError);
  });
});
