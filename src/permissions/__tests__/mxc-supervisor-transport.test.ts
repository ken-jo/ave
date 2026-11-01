import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { MxcProcess, ProbeOutput } from "@microsoft/mxc-sdk/v1";
import { describe, expect, it, vi } from "vitest";
import { createMxcExtensionRequest, createMxcNativeProcess } from "../../__tests__/support/mxc-supervisor.js";
import { _spawnMxcExtensionProcessForTest, spawnMxcExtensionProcess, type OwnedMxcExtensionProcess, type MxcProcessLifecycleEvent } from "../mxc-extension-process.js";
import { MxcExtensionChannel } from "../mxc-extension-channel.js";
import { serveMxcSupervisor } from "../mxc-supervisor-service.js";
import { MxcIntegrityError } from "../../../scripts/lib/mxc-sdk-integrity.mjs";
import { MxcCapabilityUnavailableError, MxcProcessCleanupError, MxcProcessContractError, MxcSupervisorLostError } from "../mxc-extension-errors.js";
import type { MxcSupervisorRuntime } from "../mxc-supervisor-bootstrap.js";

vi.mock("../../main/host-resources.js", () => ({ getHostResources: () => ({ resourcePath: "unit-resources", isPackaged: false }) }));
vi.mock("../../main/managed-child-processes.js", () => ({ spawnManaged: vi.fn() }));

function transportFixture() {
  const fixture = createMxcNativeProcess();
  const probe = vi.fn(() => ({ tier: "base-container", needsDaclAugmentation: false, probes: { baseContainerSupportsEnumeratePaths: true } } as ProbeOutput));
  const spawn = vi.fn(async () => fixture.native as unknown as MxcProcess);
  const runtime: MxcSupervisorRuntime = { ownerHandle: "271828", sdk: { probe, spawn }, auditModules: vi.fn(() => ["verified-unit-path"]) };
  const bootstrap = vi.fn(async () => runtime);
  let child!: ChildProcess;
  let liveness!: PassThrough;
  let events!: PassThrough;
  let service!: Promise<void>;
  const fatal = vi.fn();
  const spawnSupervisor = vi.fn((_entry: string, _modules: string, generation: string) => {
    const controls = new PassThrough(); events = new PassThrough(); liveness = new PassThrough();
    const diagnostics = new PassThrough();
    child = Object.assign(new EventEmitter(), {
      pid: 314159, stdin: controls, stdout: events, stderr: diagnostics, stdio: [controls, events, diagnostics, liveness],
      kill: vi.fn(() => { liveness.end(); events.destroy(); child.emit("close", 1, null); return true; }),
    }) as unknown as ChildProcess;
    service = new Promise<Buffer>((resolve) => liveness.once("data", resolve))
      .then((key) => serveMxcSupervisor(new MxcExtensionChannel(controls, events, generation, key, "supervisor"), liveness, bootstrap, fatal));
    void service.then(() => child.emit("close", 0, null), () => child.emit("close", 1, null));
    return child;
  });
  const launch = (signal?: AbortSignal, onLifecycle?: (event: MxcProcessLifecycleEvent) => void) => _spawnMxcExtensionProcessForTest(createMxcExtensionRequest(), "unit-modules", "unit-entry", spawnSupervisor, signal, onLifecycle);
  return { fixture, probe, spawn, bootstrap, runtime, launch, fatal, get child() { return child; }, get liveness() { return liveness; }, get service() { return service; } };
}

async function collect(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("supervisor transport and lifecycle with an injected SDK (unit only)", () => {
  it("requires the supported platform and a packaged installation on the public path", async () => {
    await expect(spawnMxcExtensionProcess(createMxcExtensionRequest())).rejects.toBeInstanceOf(MxcCapabilityUnavailableError);
  });

  it("forwards binary stdin, stdout, stderr and terminal status, omitting telemetry", async () => {
    const f = transportFixture();
    f.fixture.stdin.on("data", (bytes: Buffer) => f.fixture.stdout.write(bytes));
    f.fixture.stdin.once("finish", () => {
      f.fixture.stdout.end(); f.fixture.stderr.end(Buffer.from([0, 255, 128]));
      f.fixture.resolve({ exitCode: 17, timedOut: false });
    });
    const owned: OwnedMxcExtensionProcess = await f.launch();
    const output = collect(owned.stdout), errors = collect(owned.stderr);
    const bytes = Buffer.alloc(512 * 1024); for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    owned.stdin.end(bytes);
    expect(await owned.completion).toEqual({ exitCode: 17, timedOut: false });
    expect(await output).toEqual(bytes);
    expect(await errors).toEqual(Buffer.from([0, 255, 128]));
    expect(owned.id).toBe(42);
    expect(owned.diagnostics.ownerHandle).toBe("271828");
    expect(f.spawn.mock.calls[0]).toHaveLength(1);
    expect(f.fixture.accesses).toEqual(["stdin", "stdout", "stderr", "wait"]);
    await owned.dispose();
    expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
    expect(f.fatal).not.toHaveBeenCalled();
  });

  it("stops idempotently and drains output even when the caller stopped reading", async () => {
    const f = transportFixture();
    const owned = await f.launch();
    f.fixture.stdout.write(Buffer.alloc(256 * 1024));
    f.fixture.stderr.write(Buffer.alloc(256 * 1024));
    const stopped = owned.dispose(); expect(owned.dispose()).toBe(stopped);
    await stopped;
    expect(f.fixture.native.kill).toHaveBeenCalledOnce();
    expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
  });

  it("tears down on the independent owner-liveness EOF", async () => {
    const f = transportFixture();
    const owned = await f.launch();
    owned.stdout.resume(); owned.stderr.resume();
    f.liveness.end();
    await owned.completion;
    await f.service;
    expect(f.fixture.native.kill).toHaveBeenCalledOnce();
    expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
  });

  it("fails the handle on supervisor death without claiming native cleanup proof", async () => {
    const f = transportFixture();
    const owned = await f.launch();
    f.child.kill();
    await expect(owned.completion).rejects.toBeInstanceOf(MxcSupervisorLostError);
    await expect(owned.dispose()).rejects.toBeInstanceOf(MxcProcessCleanupError);
    await f.service.catch(() => {});
  });

  it("cancels during bootstrap without creating a container", async () => {
    const f = transportFixture();
    let resolve!: (runtime: MxcSupervisorRuntime) => void;
    f.bootstrap.mockImplementation(() => new Promise((yes) => { resolve = yes; }));
    const controller = new AbortController();
    const events: MxcProcessLifecycleEvent[] = [];
    const launched = f.launch(controller.signal, (event) => events.push(event)).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.bootstrap).toHaveBeenCalledOnce());
    controller.abort();
    await new Promise<void>((yes) => setImmediate(yes));
    resolve(f.runtime);
    expect(await launched).toBeInstanceOf(MxcProcessContractError);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(events).toEqual([{ type: "supervisor-started", pid: 314159 }, { type: "stopped", spawnPendingAtCancellation: false }]);
    await f.service;
  });

  it("disposes promptly while native stdin is backpressured", async () => {
    const f = transportFixture();
    let blocked!: (error?: Error | null) => void;
    const input = new Writable({ write(_chunk, _encoding, callback) { blocked = callback; } });
    Object.defineProperty(f.fixture.native, "standardInput", { get: () => input });
    const kill = f.fixture.native.kill.getMockImplementation()!;
    f.fixture.native.kill.mockImplementation(() => { blocked?.(Object.assign(new Error("closed"), { code: "EPIPE" })); kill(); });
    const owned = await f.launch();
    owned.stdin.write(Buffer.alloc(32768));
    await vi.waitFor(() => expect(blocked).toBeTypeOf("function"));
    await owned.dispose();
    expect(f.fixture.native.kill).toHaveBeenCalledOnce();
    expect(f.fatal).not.toHaveBeenCalled();
  });

  it("disposes a native handle that arrives after cancellation during spawn", async () => {
    const f = transportFixture();
    let arrive!: (native: MxcProcess) => void;
    f.spawn.mockImplementation(() => new Promise((resolve) => { arrive = resolve; }));
    const controller = new AbortController();
    const events: MxcProcessLifecycleEvent[] = [];
    const launched = f.launch(controller.signal, (event) => events.push(event)).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    arrive(f.fixture.native as unknown as MxcProcess);
    expect(await launched).toBeInstanceOf(MxcProcessContractError);
    expect(f.fixture.native.kill).toHaveBeenCalledOnce();
    expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
    expect(events).toEqual([{ type: "supervisor-started", pid: 314159 }, { type: "creating" }, { type: "spawning" }, { type: "stopped", spawnPendingAtCancellation: true }]);
    await f.service;
  });

  it("refuses unsupported enumeration without SDK spawn or fallback", async () => {
    const f = transportFixture();
    f.probe.mockReturnValue({ tier: "base-container", needsDaclAugmentation: false, probes: { baseContainerSupportsEnumeratePaths: false } } as ProbeOutput);
    await expect(f.launch()).rejects.toBeInstanceOf(MxcCapabilityUnavailableError);
    expect(f.spawn).not.toHaveBeenCalled();
    await f.service.catch(() => {});
  });

  it.each([
    new MxcIntegrityError("Native payload hash mismatch"),
    new MxcCapabilityUnavailableError("Native job containment is unavailable"),
    new MxcSupervisorLostError("Native bootstrap disconnected"),
    new MxcProcessContractError("Invalid supervisor bootstrap request"),
  ])("preserves a typed startup rejection without inventing native cleanup failure: %s", async (failure) => {
    const f = transportFixture();
    f.bootstrap.mockRejectedValue(failure);
    const error: unknown = await f.launch().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(failure.constructor);
    expect((error as Error).message).toBe(failure.message);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.child.kill).not.toHaveBeenCalled();
    await expect(f.service).rejects.toBe(failure);
  });

  it("reports supervisor loss before native creation without teardown pending", async () => {
    const f = transportFixture();
    let resolve!: (runtime: MxcSupervisorRuntime) => void;
    f.bootstrap.mockImplementation(() => new Promise((yes) => { resolve = yes; }));
    const launched = f.launch().catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.bootstrap).toHaveBeenCalledOnce());
    f.child.kill();
    expect(await launched).toBeInstanceOf(MxcSupervisorLostError);
    expect(f.spawn).not.toHaveBeenCalled();
    resolve(f.runtime);
    await f.service.catch(() => {});
  });

  it("preserves a post-spawn integrity rejection after confirmed native teardown", async () => {
    const f = transportFixture();
    vi.mocked(f.runtime.auditModules).mockImplementationOnce(() => ["verified-unit-path"])
      .mockImplementationOnce(() => { throw new MxcIntegrityError("Unexpected native module"); });
    await expect(f.launch()).rejects.toBeInstanceOf(MxcIntegrityError);
    expect(f.fixture.native.kill).toHaveBeenCalledOnce();
    expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
    expect(f.child.kill).not.toHaveBeenCalled();
    await expect(f.service).rejects.toBeInstanceOf(MxcIntegrityError);
  });

  it("keeps native teardown pending when spawn fails without returning an owned handle", async () => {
    const f = transportFixture();
    f.spawn.mockRejectedValue(new Error("Native spawn lost its handle"));
    await expect(f.launch()).rejects.toBeInstanceOf(MxcProcessCleanupError);
    await expect(f.service).rejects.toBeInstanceOf(MxcProcessCleanupError);
  });

  it("reports cleanup failure when native wait cannot confirm termination", async () => {
    const f = transportFixture();
    const owned = await f.launch();
    f.fixture.reject(new Error("Native wait failed"));
    await expect(owned.completion).rejects.toBeInstanceOf(MxcProcessCleanupError);
    await expect(owned.dispose()).rejects.toBeInstanceOf(MxcProcessCleanupError);
    await expect(f.service).rejects.toBeInstanceOf(MxcProcessCleanupError);
  });

  it("lets liveness EOF finish teardown when the stop frame cannot be sent", async () => {
    const f = transportFixture();
    f.fixture.native.kill.mockImplementation(() => {});
    const owned = await f.launch();
    const send = MxcExtensionChannel.prototype.send;
    const sending = vi.spyOn(MxcExtensionChannel.prototype, "send").mockImplementation(function (this: MxcExtensionChannel, frame) {
      if (frame.type === "stop") return Promise.reject(new Error("Control pipe closed"));
      return send.call(this, frame);
    });
    try {
      const disposed = owned.dispose();
      await vi.waitFor(() => expect(f.fixture.native.kill).toHaveBeenCalledOnce());
      expect(f.liveness.writableEnded).toBe(true);
      expect(f.child.kill).not.toHaveBeenCalled();
      f.fixture.stdout.end(); f.fixture.stderr.end();
      f.fixture.resolve({ exitCode: 1, timedOut: false });
      await disposed;
      expect(f.child.kill).not.toHaveBeenCalled();
      expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
    } finally { sending.mockRestore(); }
  });

  it("observes the authenticated creation boundary without changing native admission", async () => {
    const f = transportFixture();
    const events: MxcProcessLifecycleEvent[] = [];
    const owned = await f.launch(undefined, (event) => events.push(event));
    expect(events).toEqual([{ type: "supervisor-started", pid: 314159 }, { type: "creating" }, { type: "spawning" }]);
    expect(f.probe).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0]).toHaveLength(1);
    await owned.dispose();
  });

  it.each(["supervisor-started", "creating", "spawning", "stopped"] as const)("cleans up when the %s lifecycle observer throws", async (type) => {
    const f = transportFixture();
    const controller = new AbortController();
    const cause = new Error("Observer refused event");
    let observed = false;
    const failure: unknown = await f.launch(controller.signal, (event) => {
      if (event.type === type) { observed = true; throw cause; }
      if (type === "stopped" && event.type === "supervisor-started") controller.abort();
    }).catch((error: unknown) => error);
    expect(observed).toBe(true);
    expect(failure).toBeInstanceOf(MxcProcessContractError);
    expect((failure as Error).message).toBe("Extension lifecycle observer failed");
    expect((failure as Error).cause).toBe(cause);
    await f.service;
    expect(f.child.kill).not.toHaveBeenCalled();
    if (f.spawn.mock.calls.length) {
      expect(f.fixture.native.kill).toHaveBeenCalledOnce();
      expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
    }
  });

  it("cancels from the authenticated spawning event while native creation remains pending", async () => {
    const f = transportFixture();
    let arrive!: (native: MxcProcess) => void;
    f.spawn.mockImplementation(() => new Promise((resolve) => { arrive = resolve; }));
    const controller = new AbortController();
    const events: MxcProcessLifecycleEvent[] = [];
    const launched = f.launch(controller.signal, (event) => {
      events.push(event);
      if (event.type === "spawning") controller.abort();
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    expect(f.spawn).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    arrive(f.fixture.native as unknown as MxcProcess);
    expect(await launched).toBeInstanceOf(MxcProcessContractError);
    expect(events).toEqual([{ type: "supervisor-started", pid: 314159 }, { type: "creating" }, { type: "spawning" }, { type: "stopped", spawnPendingAtCancellation: true }]);
    expect(f.fixture.native.kill).toHaveBeenCalledOnce();
    expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
    await f.service;
  });

  it("adopts and disposes a late native handle when the spawning notification fails", async () => {
    const f = transportFixture();
    let arrive!: (native: MxcProcess) => void;
    f.spawn.mockImplementation(() => new Promise((resolve) => { arrive = resolve; }));
    const send = MxcExtensionChannel.prototype.send;
    const sending = vi.spyOn(MxcExtensionChannel.prototype, "send").mockImplementation(function (this: MxcExtensionChannel, frame) {
      if (frame.type === "spawning") return Promise.reject(new Error("Spawning notification failed"));
      return send.call(this, frame);
    });
    try {
      const launched = f.launch().catch((error: unknown) => error);
      await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));
      arrive(f.fixture.native as unknown as MxcProcess);
      expect(await launched).toBeInstanceOf(MxcProcessContractError);
      expect(f.fixture.native.kill).toHaveBeenCalledOnce();
      expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
      await expect(f.service).rejects.toThrow("Spawning notification failed");
    } finally { sending.mockRestore(); }
  });

  it.each([
    { types: ["spawning"], message: "Unexpected supervisor spawning receipt" },
    { types: ["creating", "spawning", "spawning"], message: "Unexpected supervisor spawning receipt" },
    { types: ["creating", "ready"], message: "Supervisor readiness preceded native invocation" },
  ])("rejects an invalid authenticated creation sequence: $types", async ({ types, message }) => {
    const launch = (_entry: string, _modules: string, generation: string): ChildProcess => {
      const controls = new PassThrough(), events = new PassThrough(), diagnostics = new PassThrough(), liveness = new PassThrough();
      const child = Object.assign(new EventEmitter(), { pid: 314159, stdin: controls, stdout: events, stderr: diagnostics,
        stdio: [controls, events, diagnostics, liveness], kill: vi.fn(() => true) }) as unknown as ChildProcess;
      liveness.once("data", (key: Buffer) => {
        const channel = new MxcExtensionChannel(controls, events, generation, key, "supervisor");
        controls.once("data", () => {
          void (async () => {
            for (const type of types) {
              if (type === "ready") await channel.send({ type, id: 42, nodeVersion: process.versions.node, nativeModules: [], nativeModuleCount: 0, nativeModulesTruncated: false, ownerHandle: "271828" });
              else await channel.send({ type: type as "creating" | "spawning" });
            }
            await channel.end();
          })().catch(() => {}).finally(() => { events.destroy(); child.emit("close", 1, null); });
        });
      });
      return child;
    };
    const error: unknown = await _spawnMxcExtensionProcessForTest(createMxcExtensionRequest(), "unit-modules", "unit-entry", launch).catch((error: unknown) => error);
    const causes = error instanceof MxcProcessCleanupError && error.cause instanceof AggregateError ? error.cause.errors : [error];
    expect(causes).toContainEqual(expect.objectContaining({ name: "MxcProcessContractError", message }));
  });

});
