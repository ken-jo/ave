import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { MxcExtensionProcess, MxcProcessCleanupError, MxcProcessContractError, MxcSupervisorLostError } from "../mxc-extension-process.js";
import { encodeMxcFrame, MxcFrameDecoder, MXC_FRAME_MAX_BYTES, MXC_STREAM_CHUNK_BYTES } from "../mxc-extension-protocol.js";

const GENERATION = "a".repeat(64);
function nativeProcess() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let resolve!: (value: { exitCode: number; timedOut: boolean }) => void;
  let reject!: (error: Error) => void;
  const completion = new Promise<{ exitCode: number; timedOut: boolean }>((yes, no) => { resolve = yes; reject = no; });
  const accesses: string[] = [];
  const native = {
    id: 42,
    get standardInput() { accesses.push("stdin"); return stdin; },
    get standardOutput() { accesses.push("stdout"); return stdout; },
    get standardError() { accesses.push("stderr"); return stderr; },
    wait: vi.fn(() => { accesses.push("wait"); return completion; }),
    kill: vi.fn(() => { stdout.end(); stderr.end(); resolve({ exitCode: 1, timedOut: false }); }),
    dispose: vi.fn(),
  };
  return { native, accesses, resolve, reject, stdout, stderr };
}

describe("owned native process state machine", () => {
  it("takes every stream before wait and disposes once after terminal drain", async () => {
    const fixture = nativeProcess();
    const process = new MxcExtensionProcess(fixture.native);
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
    const fixture = nativeProcess();
    const process = new MxcExtensionProcess(fixture.native);
    fixture.stdout.write(Buffer.alloc(128 * 1024));
    fixture.stderr.write(Buffer.alloc(128 * 1024));
    await process.dispose();
    expect(fixture.stdout.readableEnded).toBe(true);
    expect(fixture.stderr.readableEnded).toBe(true);
  });

  it("does not report death after wait rejection", async () => {
    const fixture = nativeProcess();
    const process = new MxcExtensionProcess(fixture.native);
    fixture.reject(new Error("native ownership lost"));
    await expect(process.completion).rejects.toBeInstanceOf(MxcSupervisorLostError);
    await expect(process.dispose()).rejects.toBeInstanceOf(MxcProcessCleanupError);
    expect(process.state).toBe("cleanup-failed");
    expect(fixture.native.dispose).toHaveBeenCalledOnce();
  });

  it("surfaces synchronous disposal failure after a settled exit", async () => {
    const fixture = nativeProcess();
    fixture.native.dispose.mockImplementation(() => { throw new Error("free failed"); });
    const process = new MxcExtensionProcess(fixture.native);
    await expect(process.dispose()).rejects.toBeInstanceOf(MxcProcessCleanupError);
    expect(process.state).toBe("cleanup-failed");
  });

  it("bounds cleanup without treating disposal as death", async () => {
    vi.useFakeTimers();
    try {
      const fixture = nativeProcess();
      fixture.native.kill.mockImplementation(() => {});
      const process = new MxcExtensionProcess(fixture.native);
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
      const fixture = nativeProcess();
      fixture.native.kill.mockImplementation(() => {});
      const process = new MxcExtensionProcess(fixture.native);
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
    const fixture = nativeProcess();
    fixture.native.wait.mockImplementation(() => { throw new Error("wait failed"); });
    expect(() => new MxcExtensionProcess(fixture.native)).toThrow(MxcProcessContractError);
    expect(fixture.native.kill).toHaveBeenCalledOnce();
    expect(fixture.native.dispose).toHaveBeenCalledOnce();
  });

  it("preserves a malformed completion as a contract failure", async () => {
    const fixture = nativeProcess();
    const process = new MxcExtensionProcess(fixture.native);
    fixture.resolve({ exitCode: NaN, timedOut: false });
    await expect(process.completion).rejects.toBeInstanceOf(MxcProcessContractError);
    await expect(process.dispose()).rejects.toBeInstanceOf(MxcProcessCleanupError);
  });

  it("refuses missing native endpoints", () => {
    const fixture = nativeProcess();
    expect(() => new MxcExtensionProcess({ ...fixture.native, standardError: null })).toThrow(MxcProcessContractError);
    expect(fixture.native.kill).toHaveBeenCalledOnce();
    expect(fixture.native.dispose).toHaveBeenCalledOnce();
  });
});

describe("bounded supervisor frames", () => {
  it("round trips binary chunks across arbitrary boundaries", () => {
    const data = Buffer.from([0, 255, 10, 13, 128]);
    const frame = { version: 1 as const, generation: GENERATION, sequence: 0, type: "stdout" as const, data: data.toString("base64") };
    const bytes = encodeMxcFrame(frame);
    const decoder = new MxcFrameDecoder(GENERATION);
    const received = [...bytes].flatMap((byte) => [...decoder.read(Buffer.from([byte]))]);
    expect(received).toEqual([frame]);
    decoder.end();
  });

  it("handles coalesced frames and rejects replay or another generation", () => {
    const frame = { version: 1 as const, generation: GENERATION, sequence: 0, type: "ready" as const };
    const decoder = new MxcFrameDecoder(GENERATION);
    expect([...decoder.read(Buffer.concat([encodeMxcFrame(frame), encodeMxcFrame({ ...frame, sequence: 1 })]))]).toHaveLength(2);
    expect(() => [...decoder.read(encodeMxcFrame(frame))]).toThrow(MxcProcessContractError);
    expect(() => [...new MxcFrameDecoder("b".repeat(64)).read(encodeMxcFrame(frame))]).toThrow(MxcProcessContractError);
  });

  it("refuses excessive lengths before allocating a body", () => {
    for (const length of [0, MXC_FRAME_MAX_BYTES + 1, 0xffffffff]) {
      const header = Buffer.alloc(4); header.writeUInt32BE(length);
      const decoder = new MxcFrameDecoder(GENERATION);
      expect(() => [...decoder.read(header)]).toThrow(MxcProcessContractError);
      expect(() => [...decoder.read(Buffer.alloc(1))]).toThrow(MxcProcessContractError);
    }
    expect(() => encodeMxcFrame({ version: 1, generation: GENERATION, sequence: 0, type: "stdin", data: Buffer.alloc(MXC_STREAM_CHUNK_BYTES + 1).toString("base64") })).toThrow(MxcProcessContractError);
  });

  it("refuses malformed JSON, unknown fields, invalid base64 and truncated EOF", () => {
    const bodies = ["{", JSON.stringify({ version: 1, generation: GENERATION, sequence: 0, type: "ready", extra: true }), JSON.stringify({ version: 1, generation: GENERATION, sequence: 0, type: "stdin", data: "??" })];
    for (const text of bodies) {
      const body = Buffer.from(text), header = Buffer.alloc(4); header.writeUInt32BE(body.length);
      expect(() => [...new MxcFrameDecoder(GENERATION).read(Buffer.concat([header, body]))]).toThrow(MxcProcessContractError);
    }
    const decoder = new MxcFrameDecoder(GENERATION);
    expect([...decoder.read(Buffer.from([0]))]).toEqual([]);
    expect(() => decoder.end()).toThrow(MxcProcessContractError);
  });
});
