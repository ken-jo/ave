import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { MxcProcess, ProbeOutput } from "@microsoft/mxc-sdk/v1";
import { describe, expect, it, vi } from "vitest";
import { createMxcExtensionRequest, createMxcNativeProcess } from "../../__tests__/support/mxc-supervisor.js";
import { _spawnMxcExtensionProcessForTest, spawnMxcExtensionProcess, type OwnedMxcExtensionProcess } from "../mxc-extension-process.js";
import { MxcExtensionChannel } from "../mxc-extension-channel.js";
import { serveMxcSupervisor } from "../mxc-supervisor-service.js";
import { MxcProcessCleanupError, MxcProcessContractError, MxcSupervisorLostError } from "../mxc-extension-errors.js";
import type { MxcSupervisorRuntime } from "../mxc-supervisor-bootstrap.js";

vi.mock("../../main/host-resources.js", () => ({ getHostResources: () => ({ resourcePath: "unit-resources", isPackaged: false }) }));
vi.mock("../../main/managed-child-processes.js", () => ({ spawnManaged: vi.fn() }));

function transportFixture() {
  const fixture = createMxcNativeProcess();
  const probe = vi.fn(() => ({ tier: "base-container", needsDaclAugmentation: false, probes: { baseContainerSupportsEnumeratePaths: true } } as ProbeOutput));
  const spawn = vi.fn(async () => fixture.native as unknown as MxcProcess);
  const runtime: MxcSupervisorRuntime = { sdk: { probe, spawn }, auditModules: vi.fn(() => ["verified-unit-path"]) };
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
      stdin: controls, stdout: events, stderr: diagnostics, stdio: [controls, events, diagnostics, liveness],
      kill: vi.fn(() => { liveness.end(); events.destroy(); child.emit("close", 1, null); return true; }),
    }) as unknown as ChildProcess;
    service = new Promise<Buffer>((resolve) => liveness.once("data", resolve))
      .then((key) => serveMxcSupervisor(new MxcExtensionChannel(controls, events, generation, key, "supervisor"), liveness, bootstrap, fatal));
    void service.then(() => child.emit("close", 0, null), () => child.emit("close", 1, null));
    return child;
  });
  const launch = (signal?: AbortSignal) => _spawnMxcExtensionProcessForTest(createMxcExtensionRequest(), "unit-modules", "unit-entry", spawnSupervisor, signal);
  return { fixture, probe, spawn, bootstrap, runtime, launch, fatal, get child() { return child; }, get liveness() { return liveness; }, get service() { return service; } };
}

async function collect(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("supervisor transport and lifecycle with an injected SDK (unit only)", () => {
  it("requires the supported platform and a packaged installation on the public path", async () => {
    await expect(spawnMxcExtensionProcess(createMxcExtensionRequest())).rejects.toBeInstanceOf(MxcProcessContractError);
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
    const launched = f.launch(controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.bootstrap).toHaveBeenCalledOnce());
    controller.abort();
    await new Promise<void>((yes) => setImmediate(yes));
    resolve(f.runtime);
    expect(await launched).toBeInstanceOf(MxcProcessContractError);
    expect(f.spawn).not.toHaveBeenCalled();
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
    const launched = f.launch(controller.signal).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    controller.abort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    arrive(f.fixture.native as unknown as MxcProcess);
    expect(await launched).toBeInstanceOf(MxcProcessContractError);
    expect(f.fixture.native.kill).toHaveBeenCalledOnce();
    expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
    await f.service;
  });

  it("refuses unsupported enumeration without SDK spawn or fallback", async () => {
    const f = transportFixture();
    f.probe.mockReturnValue({ tier: "base-container", needsDaclAugmentation: false, probes: { baseContainerSupportsEnumeratePaths: false } } as ProbeOutput);
    await expect(f.launch()).rejects.toBeInstanceOf(MxcProcessCleanupError);
    expect(f.spawn).not.toHaveBeenCalled();
    await f.service.catch(() => {});
  });
});
