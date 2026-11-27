import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import type { ContainerRequest, MxcProcess, ProbeOutput } from "@microsoft/mxc-sdk/v1";
import { describe, expect, it, vi } from "vitest";
import * as backendEvidence from "../windows-confinement-evidence.js";
import { createMxcExtensionRequest, createMxcNativeProcess } from "../../__tests__/support/mxc-supervisor.js";
import { _spawnMxcExtensionProcessForTest, spawnMxcExtensionProcess, spawnMxcExtensionProcessForDiagnostics, type OwnedMxcExtensionProcess, type MxcProcessLifecycleEvent } from "../mxc-extension-process.js";
import { MxcExtensionChannel } from "../mxc-extension-channel.js";
import { MXC_STREAM_CHUNK_BYTES, mxcRequestDigest } from "../mxc-extension-protocol.js";
import { serveMxcSupervisor } from "../mxc-supervisor-service.js";
import { MxcIntegrityError } from "../../../scripts/lib/mxc-sdk-integrity.mjs";
import { MxcCapabilityUnavailableError, MxcProcessCleanupError, MxcProcessContractError, MxcSupervisorLostError } from "../mxc-extension-errors.js";
import type { MxcSupervisorRuntime } from "../mxc-supervisor-bootstrap.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMxcReleaseGate } from "../mxc-release-gate.js";
import { holdWindowsDirectory } from "../../shared/windows-path-facts.js";
import { adoptMxcSupervisorDirectoryHold } from "../mxc-supervisor-cwd-hold.js";
import { deferred } from "../../__tests__/support/deferred.js";

vi.mock("../../main/host-resources.js", () => ({ getHostResources: () => ({ resourcePath: join(process.cwd(), "resources"), isPackaged: false }) }));
vi.mock("../../main/managed-child-processes.js", () => ({ spawnManaged: vi.fn() }));

function transportFixture(request = createMxcExtensionRequest(), holdStartWrite?: (complete: () => void) => void) {
  const fixture = createMxcNativeProcess();
  const probe = vi.fn(() => ({ tier: "base-container", needsDaclAugmentation: false, probes: { baseContainerSupportsEnumeratePaths: true } } as ProbeOutput));
  const spawn = vi.fn(async () => fixture.native as unknown as MxcProcess);
  const runtime: MxcSupervisorRuntime = { ownerHandle: "271828", pinProcess: vi.fn(() => ({ value: "161803", close: vi.fn() })), sdk: { probe, spawn }, auditModules: vi.fn(() => ["verified-unit-path"]) };
  const bootstrap = vi.fn(async () => runtime);
  let child!: ChildProcess;
  let liveness!: PassThrough;
  let events!: PassThrough;
  let service!: Promise<void>;
  const fatal = vi.fn();
  const spawnSupervisor = vi.fn((_entry: string, _modules: string, generation: string) => {
    const controls = new PassThrough(); events = new PassThrough(); liveness = new PassThrough();
    if (holdStartWrite) {
      vi.spyOn(controls, "_write").mockImplementationOnce((chunk, _encoding, callback) => {
        controls.push(chunk);
        holdStartWrite(() => callback());
      });
    }
    const diagnostics = new PassThrough();
    child = Object.assign(new EventEmitter(), {
      pid: 314159, stdin: controls, stdout: events, stderr: diagnostics, stdio: [controls, events, diagnostics, liveness],
      kill: vi.fn(() => { liveness.end(); events.destroy(); child.emit("close", 1, null); return true; }),
    }) as unknown as ChildProcess;
    service = new Promise<Buffer>((resolve) => liveness.once("data", resolve))
      .then((key) => serveMxcSupervisor(new MxcExtensionChannel(controls, events, generation, key, "supervisor", "windows-extension"), liveness, bootstrap, fatal));
    void service.then(() => child.emit("close", 0, null), () => child.emit("close", 1, null));
    return child;
  });
  const launch = (signal?: AbortSignal, onLifecycle?: (event: MxcProcessLifecycleEvent) => void, beforeSpawn?: () => void, onOwned?: (owned: OwnedMxcExtensionProcess) => void,
    preparation?: Parameters<typeof _spawnMxcExtensionProcessForTest>[8]) => _spawnMxcExtensionProcessForTest(request, "unit-modules", "unit-entry", spawnSupervisor, signal, onLifecycle, beforeSpawn, onOwned, preparation);
  return { fixture, probe, spawn, bootstrap, runtime, launch, spawnSupervisor, fatal, get child() { return child; }, get liveness() { return liveness; }, get service() { return service; } };
}

async function collect(stream: PassThrough): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe("supervisor transport and lifecycle with an injected SDK (unit only)", () => {
  it.runIf(process.platform === "win32").each(["stable", "cancel", "pre-start loss", "before-ready loss"] as const)(
    "owns real directory handles across the SDK creation boundary (%s)",
    async (scenario) => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), "mxc-supervisor-cwd-")));
      const cwd = join(root, "cwd");
      const marker = join(cwd, "marker");
      mkdirSync(cwd);
      writeFileSync(marker, "admitted");
      const hold = await holdWindowsDirectory(cwd, true);
      const entered = deferred<void>();
      const pending = deferred<MxcProcess>();
      const controller = new AbortController();
      const request = createMxcExtensionRequest();
      request.workingDirectory = cwd;
      request.environment = { ...request.environment, PWD: cwd };
      request.filesystem = { ...request.filesystem, readonlyPaths: [...(request.filesystem?.readonlyPaths ?? []), root] };
      const f = transportFixture(request);
      const { default: ffi } = await import("koffi");
      const kernel = ffi.load("kernel32.dll");
      f.runtime.holdDirectory = (source) => adoptMxcSupervisorDirectoryHold(kernel, source);
      if (scenario !== "pre-start loss") f.spawn.mockImplementation(() => { entered.resolve(); return pending.promise; });
      let launch: Promise<OwnedMxcExtensionProcess | undefined> | undefined;
      let adopted: OwnedMxcExtensionProcess | undefined;
      try {
        if (hold?.source === undefined) throw new Error("Fixture cwd hold is unavailable");
        const release = createMxcReleaseGate(root, [cwd], hold.source);
        if (scenario === "pre-start loss") await hold.release();
        launch = f.launch(controller.signal, undefined, undefined, (owned) => { adopted = owned; }, {
          release,
          beforeReady: () => {
            if (scenario === "before-ready loss" && !hold.isHeld()) throw new MxcProcessContractError("Working directory hold lost");
          },
        });
        void launch.catch(() => {});
        if (scenario === "pre-start loss") {
          await expect(launch).rejects.toThrow(/hold could not be adopted/u);
          expect(f.spawn).not.toHaveBeenCalled();
          return;
        }
        await Promise.race([entered.promise, launch]);
        if (scenario === "cancel") controller.abort();
        await hold.release();
        expect(() => renameSync(cwd, join(root, "replacement"))).toThrow();
        expect(readFileSync(marker, "utf8")).toBe("admitted");
        pending.resolve(f.fixture.native as unknown as MxcProcess);
        if (scenario === "cancel") await expect(launch).rejects.toThrow(/cancelled/u);
        else if (scenario === "before-ready loss") {
          await expect(launch).rejects.toThrow("Working directory hold lost");
          expect(adopted?.startEvidence).toBeUndefined();
        } else {
          const owned = await launch;
          expect(owned?.startEvidence?.requestDigest).toBe(mxcRequestDigest(request));
          await owned?.dispose();
        }
        expect(f.fixture.native.kill).toHaveBeenCalledOnce();
        expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
        renameSync(cwd, join(root, "retired"));
      } finally {
        controller.abort();
        pending.resolve(f.fixture.native as unknown as MxcProcess);
        await launch?.catch(() => {});
        await hold?.release();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("refuses an expired preparation before starting a supervisor", async () => {
    const f = transportFixture();
    const child = await f.launch(undefined, undefined, undefined, undefined, {
      beforeSupervisor: () => { throw new MxcProcessContractError("Holder withdrew admission"); },
    }).catch(() => undefined);
    await child?.dispose();
    expect(f.spawnSupervisor).not.toHaveBeenCalled();
  });

  it.each(["revoked authorization", "replaced filesystem identity", "current authorization"])("checks %s at the SDK call after authenticated delivery", async (change) => {
    const root = mkdtempSync(join(tmpdir(), "mxc-release-"));
    try {
      const granted = join(root, "grant");
      writeFileSync(granted, "granted");
      const release = createMxcReleaseGate(root, [granted]);
      const f = transportFixture();
      const child = await f.launch(undefined, event => {
        if (event.type !== "creating") return;
        const controls = f.child.stdin as PassThrough;
        vi.spyOn(controls, "_write").mockImplementationOnce((bytes, _encoding, callback) => {
          controls.push(bytes);
          if (change === "revoked authorization") release.revoke();
          if (change === "replaced filesystem identity") {
            renameSync(granted, join(root, "retired-grant"));
            writeFileSync(granted, "granted");
          }
          callback();
        });
      }, undefined, undefined, { release }).catch(() => undefined);
      await child?.dispose();
      expect(f.spawn).toHaveBeenCalledTimes(change === "current authorization" ? 1 : 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("requires the supported platform and a packaged installation on the public path", async () => {
    await expect(spawnMxcExtensionProcess(createMxcExtensionRequest(), {
      beforeSpawn: () => {}, beforeSupervisor: () => {}, paths: [], watchRelease: () => () => {},
      cwdHold: {} as Parameters<typeof spawnMxcExtensionProcess>[1]["cwdHold"],
    })).rejects.toBeInstanceOf(MxcCapabilityUnavailableError);
    await expect(spawnMxcExtensionProcessForDiagnostics(createMxcExtensionRequest())).rejects.toBeInstanceOf(MxcCapabilityUnavailableError);
  });

  it("refuses a production native spawn that carries no row-2 admission at the spawn boundary", async () => {
    const unadmitted = { signal: new AbortController().signal } as unknown as Parameters<typeof spawnMxcExtensionProcess>[1];
    await expect(spawnMxcExtensionProcess(createMxcExtensionRequest(), unadmitted)).rejects.toThrow(/requires row-2 admission/);
  });

  it.each([
    ["request refusal", "none", true, true, true],
    ["denied base containment fallback", "base-container", true, true, true],
    ["extension-only path queries", "base-container", false, false, true],
    ["a missing common backend", "none", false, true, false],
  ] as const)("reports shared backend loss for %s only on measured platform absence", async (_name, tier, enumerate, needsDaclAugmentation, baseContainerApiPresent) => {
    const reportLoss = vi.spyOn(backendEvidence, "reportWindowsBackendLoss");
    try {
      const f = transportFixture();
      f.probe.mockReturnValue({ tier, needsDaclAugmentation, probes: { baseContainerSupportsEnumeratePaths: enumerate, baseContainerApiPresent } } as ProbeOutput);
      await expect(f.launch()).rejects.toBeInstanceOf(MxcCapabilityUnavailableError);
      expect(f.spawn).not.toHaveBeenCalled();
      expect(reportLoss).toHaveBeenCalledTimes(baseContainerApiPresent ? 0 : 1);
    } finally { reportLoss.mockRestore(); }
  });

  it("does not revoke receipts when native creation fails with an ambiguous backend error", async () => {
    const reportLoss = vi.spyOn(backendEvidence, "reportWindowsBackendLoss");
    try {
      const f = transportFixture();
      f.spawn.mockRejectedValue(Object.assign(new Error("Base containment was withdrawn"), { code: "backend_unavailable" }));
      await expect(f.launch()).rejects.toBeInstanceOf(MxcProcessCleanupError);
      expect(reportLoss).not.toHaveBeenCalled();
    } finally { reportLoss.mockRestore(); }
  });

  it.each([
    ["shell", true, false], ["extension", false, true], ["common", true, true],
  ] as const)("revokes only the evidence measured by a %s loss", async (scope, shellLost, extensionLost) => {
    const shell = backendEvidence.WINDOWS_BACKEND_EVIDENCE.container;
    const shellObservation = shell.observe();
    const loss = backendEvidence.observeWindowsBackend("container", scope);
    const lossEpoch = backendEvidence.getWindowsContainerBackendLossEpoch();
    expect(backendEvidence.reportWindowsBackendLoss(loss)).toBe(true);
    expect(shell.isObserved(shellObservation)).toBe(!shellLost);
    expect(backendEvidence.getWindowsContainerBackendLossEpoch()).toBe(lossEpoch + Number(extensionLost));
  });

  it("checks the input fence at every frame and still stops after a refusal", async () => {
    const f = transportFixture();
    let received = 0;
    f.fixture.stdin.on("data", (bytes: Buffer) => { received += bytes.length; });
    const owned = await f.launch();
    let checks = 0;
    owned.fenceInput(() => { if (++checks > 2) throw new Error("superseded"); });
    const refused = new Promise<Error | null | undefined>((resolve) => owned.stdin.write(Buffer.alloc(4 * MXC_STREAM_CHUNK_BYTES, 7), resolve));
    expect((await refused)?.message).toBe("superseded");
    await owned.dispose();
    expect(checks).toBe(3);
    expect(received).toBe(2 * MXC_STREAM_CHUNK_BYTES);
    expect(f.fixture.native.kill).toHaveBeenCalledOnce();
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

  it("checks fenced application EOF independently of teardown", async () => {
    const f = transportFixture();
    const owned = await f.launch();
    const ended = vi.fn();
    f.fixture.stdin.once("finish", ended);
    let live = true;
    owned.fenceInput(() => { if (!live) throw new Error("admission expired"); });
    try {
      const eof = new Promise<Error | null | undefined>(resolve => owned.stdin.end(resolve));
      live = false;
      expect((await eof)?.message).toBe("admission expired");
      expect(ended).not.toHaveBeenCalled();
    } finally { await owned.dispose(); }
    expect(f.fixture.native.kill).toHaveBeenCalledOnce();
  });

  it("revalidates admission after bootstrap and native probing before authorizing spawn", async () => {
    const f = transportFixture();
    const beforeSpawn = vi.fn(() => {
      expect(f.bootstrap).toHaveBeenCalledOnce();
      expect(f.probe).toHaveBeenCalledOnce();
      expect(f.runtime.auditModules).toHaveBeenCalledOnce();
      expect(f.spawn).not.toHaveBeenCalled();
    });
    const owned = await f.launch(undefined, undefined, beforeSpawn);
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledOnce();
    await owned.dispose();
  });

  it("refuses roots changed during native bootstrap without creating a container", async () => {
    const f = transportFixture();
    let valid = true;
    f.bootstrap.mockImplementation(async () => { valid = false; return f.runtime; });
    const beforeSpawn = vi.fn(() => { if (!valid) throw new Error("Admitted root identity changed"); });
    await expect(f.launch(undefined, undefined, beforeSpawn)).rejects.toMatchObject({
      name: "MxcProcessContractError", message: "Extension admission revalidation failed",
    });
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(f.spawn).not.toHaveBeenCalled();
    await f.service;
    expect(f.fatal).not.toHaveBeenCalled();
  });

  it("refuses superseded admission while authorization waits for the start write", async () => {
    let completeStart!: () => void;
    let current = true;
    const f = transportFixture(createMxcExtensionRequest(), (complete) => { completeStart = complete; });
    const beforeSpawn = vi.fn(() => { if (!current) throw new Error("Admission superseded"); });
    const outcome = f.launch(undefined, (event) => {
      if (event.type === "creating") queueMicrotask(() => {
        current = false;
        completeStart();
      });
    }, beforeSpawn).then(async (owned) => { await owned.dispose(); return undefined; }, (error: unknown) => error);
    expect(await outcome).toMatchObject({ message: "Extension admission revalidation failed" });
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(f.spawn).not.toHaveBeenCalled();
    await f.service;
    expect(f.child.kill).not.toHaveBeenCalled();
    expect(f.fatal).not.toHaveBeenCalled();
  });
  it("refuses asynchronous admission checks without creating a container", async () => {
    const f = transportFixture();
    await expect(f.launch(undefined, undefined, async () => {})).rejects.toBeInstanceOf(MxcProcessContractError);
    expect(f.spawn).not.toHaveBeenCalled();
    await f.service;
  });

  it("hands ownership to the caller before bootstrap or startup cleanup can fail", async () => {
    const f = transportFixture();
    const onOwned = vi.fn((owned: OwnedMxcExtensionProcess) => {
      expect(owned.dispose).toBeTypeOf("function");
      expect(f.bootstrap).not.toHaveBeenCalled();
    });
    f.bootstrap.mockRejectedValue(new MxcIntegrityError("Rejected runtime"));
    await expect(f.launch(undefined, undefined, undefined, onOwned)).rejects.toBeInstanceOf(MxcIntegrityError);
    expect(onOwned).toHaveBeenCalledOnce();
    expect(f.spawn).not.toHaveBeenCalled();
    await f.service.catch(() => {});
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

  it.each(["owner-eof", "channel-eof", "stop-then-channel-eof", "channel-eof-before-native", "owner-eof-before-native"] as const)("releases an unacknowledged native process on %s without the watchdog", async (action) => {
    const f = transportFixture();
    const controls = new PassThrough(), events = new PassThrough(), liveness = new PassThrough();
    const key = Buffer.alloc(32, 7), generation = "a".repeat(64);
    const host = new MxcExtensionChannel(events, controls, generation, key, "host", "windows-extension");
    const closePin = vi.fn();
    f.runtime.pinProcess = vi.fn(() => ({ value: "161803", close: closePin }));
    let arrive!: (native: MxcProcess) => void;
    const delayed = action === "channel-eof-before-native" || action === "owner-eof-before-native";
    if (delayed) f.spawn.mockImplementation(() => new Promise((resolve) => { arrive = resolve; }));
    const service = serveMxcSupervisor(new MxcExtensionChannel(controls, events, generation, key, "supervisor", "windows-extension"), liveness, f.bootstrap, f.fatal);
    void service.catch(() => {});
    const frames = host.frames();
    try {
      await host.send({ type: "start", request: createMxcExtensionRequest() });
      expect((await frames.next()).value?.type).toBe("creating");
      expect(f.spawn).not.toHaveBeenCalled();
      await host.send({ type: "spawn-authorized" });
      expect((await frames.next()).value?.type).toBe("spawning");
      if (delayed) {
        if (action === "channel-eof-before-native") await host.end();
        else liveness.end();
        await new Promise<void>((resolve) => setImmediate(resolve));
        arrive(f.fixture.native as unknown as MxcProcess);
      }
      expect((await frames.next()).value?.type).toBe("native-created");
      if (!delayed) expect(closePin).not.toHaveBeenCalled();
      // Deliberately never send native-observed: loss of the host must settle
      // the native owner, rather than waiting for the process-exit watchdog.
      if (action === "owner-eof") liveness.end();
      else if (!delayed) {
        if (action === "stop-then-channel-eof") await host.send({ type: "stop" });
        await host.end();
      }
      expect((await frames.next()).value).toMatchObject({ type: "stopped", spawnPendingAtCancellation: delayed });
      await expect(service).resolves.toBeUndefined();
      expect(f.fixture.native.kill).toHaveBeenCalledOnce();
      expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
      expect(closePin).toHaveBeenCalledOnce();
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      controls.destroy(); events.destroy(); liveness.destroy();
      await frames.return(undefined);
    }
  }, TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs / 2);

  it("cancels while awaiting final admission authorization without native creation", async () => {
    const f = transportFixture();
    const controls = new PassThrough(), events = new PassThrough(), liveness = new PassThrough();
    const key = Buffer.alloc(32, 7), generation = "a".repeat(64);
    const host = new MxcExtensionChannel(events, controls, generation, key, "host", "windows-extension");
    const service = serveMxcSupervisor(new MxcExtensionChannel(controls, events, generation, key, "supervisor", "windows-extension"), liveness, f.bootstrap, f.fatal);
    const frames = host.frames();
    try {
      await host.send({ type: "start", request: createMxcExtensionRequest() });
      expect((await frames.next()).value?.type).toBe("creating");
      await host.send({ type: "stop" });
      expect((await frames.next()).value).toMatchObject({ type: "stopped", spawnPendingAtCancellation: false });
      await expect(service).resolves.toBeUndefined();
      expect(f.spawn).not.toHaveBeenCalled();
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      controls.destroy(); events.destroy(); liveness.destroy();
      await frames.return(undefined);
    }
  });

  it("retains the pin when connected cancellation arrives between creation and observation", async () => {

    const f = transportFixture();
    const controls = new PassThrough(), events = new PassThrough(), liveness = new PassThrough();
    const key = Buffer.alloc(32, 7), generation = "a".repeat(64);
    const host = new MxcExtensionChannel(events, controls, generation, key, "host", "windows-extension");
    const closePin = vi.fn();
    f.runtime.pinProcess = vi.fn(() => ({ value: "161803", close: closePin }));
    const service = serveMxcSupervisor(new MxcExtensionChannel(controls, events, generation, key, "supervisor", "windows-extension"), liveness, f.bootstrap, f.fatal);
    void service.catch(() => {});
    const frames = host.frames();
    try {
      await host.send({ type: "start", request: createMxcExtensionRequest() });
      expect((await frames.next()).value?.type).toBe("creating");
      await host.send({ type: "spawn-authorized" });
      for (const type of ["spawning", "native-created"]) expect((await frames.next()).value?.type).toBe(type);
      await host.send({ type: "stop" });
      await vi.waitFor(() => expect(f.fixture.native.dispose).toHaveBeenCalledOnce());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closePin).not.toHaveBeenCalled();
      expect(controls.destroyed).toBe(false);
      expect(liveness.destroyed).toBe(false);
      await host.send({ type: "native-observed", id: 42 });
      expect((await frames.next()).value).toMatchObject({ type: "stopped" });
      await expect(service).resolves.toBeUndefined();
      expect(closePin).toHaveBeenCalledOnce();
      expect(f.fixture.native.kill).toHaveBeenCalledOnce();
      expect(f.fatal).not.toHaveBeenCalled();
    } finally {
      controls.destroy(); events.destroy(); liveness.destroy();
      await frames.return(undefined);
    }
  }, TOOL_TIMEOUT_POLICY.windowsProcessTreeKillMs / 2);

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
    expect(events).toEqual([{ type: "supervisor-started", pid: 314159 }, { type: "creating" }, { type: "spawning" }, { type: "native-created", id: 42, processHandle: "161803", supervisorPid: 314159 }, { type: "stopped", spawnPendingAtCancellation: true }]);
    await f.service;
  });

  it("reports this start's own evidence on the ready frame: the request it started and fields 1-5", async () => {
    const request = createMxcExtensionRequest();
    const f = transportFixture(request);
    const owned = await f.launch();
    expect(owned.startEvidence).toEqual({ requestDigest: mxcRequestDigest(request), evidence: {
      installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
      uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true } });
    expect(Object.isFrozen(owned.startEvidence)).toBe(true);
    await owned.dispose();
    await f.service;
  });

  it("refuses a request without ancestor queries before native creation when the probe lacks them", async () => {
    const request: ContainerRequest = { ...createMxcExtensionRequest(),
      containment: { type: "processcontainer", config: { filesystem: { enumeratePaths: [] } } } };
    const f = transportFixture(request);
    f.probe.mockReturnValue({ tier: "base-container", needsDaclAugmentation: false, probes: { baseContainerSupportsEnumeratePaths: false } } as ProbeOutput);
    await expect(f.launch()).rejects.toBeInstanceOf(MxcCapabilityUnavailableError);
    expect(f.spawn).not.toHaveBeenCalled();
    await f.service.catch(() => {});
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
    const sending = vi.spyOn(MxcExtensionChannel.prototype, "send").mockImplementation(function (this: MxcExtensionChannel, frame, admit) {
      if (frame.type === "stop") return Promise.reject(new Error("Control pipe closed"));
      return send.call(this, frame, admit);
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
    expect(events).toEqual([{ type: "supervisor-started", pid: 314159 }, { type: "creating" }, { type: "spawning" }, { type: "native-created", id: 42, processHandle: "161803", supervisorPid: 314159 }]);
    expect(f.probe).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0]).toHaveLength(1);
    await owned.dispose();
  });

  it.each(["supervisor-started", "creating", "spawning", "native-created", "stopped"] as const)("cleans up when the %s lifecycle observer throws", async (type) => {
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
    const close = vi.fn();
    f.runtime.pinProcess = vi.fn(() => ({ value: "161803", close }));
    let duplicated = false;
    const launched = f.launch(controller.signal, (event) => {
      events.push(event);
      if (event.type === "spawning") controller.abort();
      if (event.type === "native-created") {
        expect(f.runtime.pinProcess).toHaveBeenCalledWith(42);
        expect(close).not.toHaveBeenCalled();
        expect(f.fixture.native.kill).not.toHaveBeenCalled();
        // Unit model of the synchronous observer duplication. No Windows
        // process-object or kernel death observation is claimed by this test.
        duplicated = true;
      }
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(controller.signal.aborted).toBe(true));
    expect(f.spawn).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setImmediate(resolve));
    arrive(f.fixture.native as unknown as MxcProcess);
    expect(await launched).toBeInstanceOf(MxcProcessContractError);
    expect(events).toEqual([{ type: "supervisor-started", pid: 314159 }, { type: "creating" }, { type: "spawning" }, { type: "native-created", id: 42, processHandle: "161803", supervisorPid: 314159 }, { type: "stopped", spawnPendingAtCancellation: true }]);
    expect(f.fixture.native.kill).toHaveBeenCalledOnce();
    expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
    expect(duplicated).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    await f.service;
  });

  it.each(["native-created", "native-observed"] as const)("retains container identity across cancellation while %s delivery is held", async (heldType) => {
    const f = transportFixture();
    let arrive!: (native: MxcProcess) => void;
    f.spawn.mockImplementation(() => new Promise((resolve) => { arrive = resolve; }));
    const controller = new AbortController();
    const order: string[] = [];
    let pinClosed = false, nativeTerminated = false;
    let pinnedIdentity: { id: number; processHandle: string } | undefined;
    const close = vi.fn(() => { pinClosed = true; });
    f.runtime.pinProcess = vi.fn(() => ({ value: "161803", close }));
    const wait = f.fixture.native.wait.getMockImplementation()!;
    f.fixture.native.wait.mockImplementation(() => wait().then((result) => { nativeTerminated = true; return result; }));
    let release: (() => Promise<void>) | undefined;
    const send = MxcExtensionChannel.prototype.send;
    const sending = vi.spyOn(MxcExtensionChannel.prototype, "send").mockImplementation(function (this: MxcExtensionChannel, frame, admit) {
      if (frame.type === heldType) {
        release = () => { order.push(`${heldType}-delivered`); return send.call(this, frame, admit); };
        // Model a pipe write completing before the peer reads its bytes.
        return Promise.resolve();
      }
      return send.call(this, frame, admit);
    });
    const launched = f.launch(controller.signal, (event) => {
      order.push(event.type);
      if ((heldType === "native-created" && event.type === "spawning")
        || (heldType === "native-observed" && event.type === "native-created")) {
        order.push("cancel-requested"); controller.abort();
      }
      if (event.type === "native-created") {
        // Unit model of DuplicateHandle: the supervisor must still retain the
        // source object. Native object identity/death needs the Windows peer.
        if (pinClosed) throw new Error("Cannot duplicate measured process handle");
        pinnedIdentity = { id: event.id, processHandle: event.processHandle };
      }
    }).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
      arrive(f.fixture.native as unknown as MxcProcess);
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(controller.signal.aborted).toBe(true);
      expect(f.liveness.writableEnded).toBe(false);
      expect(close).not.toHaveBeenCalled();
      if (heldType === "native-observed") {
        expect(pinnedIdentity).toEqual({ id: 42, processHandle: "161803" });
        expect(order.indexOf("native-created")).toBeLessThan(order.indexOf("cancel-requested"));
      }
      await release!(); release = undefined;
      const failure = await launched;
      expect(failure).toBeInstanceOf(MxcProcessContractError);
      expect((failure as Error).message).toBe("Extension start was cancelled");
      await expect(f.service).resolves.toBeUndefined();
      expect(pinnedIdentity).toEqual({ id: 42, processHandle: "161803" });
      expect(nativeTerminated).toBe(true);
      expect(f.fixture.native.kill).toHaveBeenCalledOnce();
      expect(f.fixture.native.dispose).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(f.child.kill).not.toHaveBeenCalled();
      expect(f.fatal).not.toHaveBeenCalled();
      expect(order.at(-1)).toBe("stopped");
    } finally {
      await release?.().catch(() => {});
      await launched; await f.service.catch(() => {});
      sending.mockRestore();
    }
  });

  it("adopts and disposes a late native handle when the spawning notification fails", async () => {
    const f = transportFixture();
    let arrive!: (native: MxcProcess) => void;
    f.spawn.mockImplementation(() => new Promise((resolve) => { arrive = resolve; }));
    const send = MxcExtensionChannel.prototype.send;
    const sending = vi.spyOn(MxcExtensionChannel.prototype, "send").mockImplementation(function (this: MxcExtensionChannel, frame, admit) {
      if (frame.type === "spawning") return Promise.reject(new Error("Spawning notification failed"));
      return send.call(this, frame, admit);
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
    { types: ["creating", "spawning", "ready"], message: "Supervisor readiness lacks its native process receipt" },
    { types: ["native-created"], message: "Unexpected native process receipt" },
  ])("rejects an invalid authenticated creation sequence: $types", async ({ types, message }) => {
    const launch = (_entry: string, _modules: string, generation: string): ChildProcess => {
      const controls = new PassThrough(), events = new PassThrough(), diagnostics = new PassThrough(), liveness = new PassThrough();
      const child = Object.assign(new EventEmitter(), { pid: 314159, stdin: controls, stdout: events, stderr: diagnostics,
        stdio: [controls, events, diagnostics, liveness], kill: vi.fn(() => true) }) as unknown as ChildProcess;
      liveness.once("data", (key: Buffer) => {
        const channel = new MxcExtensionChannel(controls, events, generation, key, "supervisor", "windows-extension");
        controls.once("data", () => {
          void (async () => {
            for (const type of types) {
              if (type === "ready") await channel.send({ type, id: 42, nodeVersion: process.versions.node, nativeModules: [], nativeModuleCount: 0, nativeModulesTruncated: false, ownerHandle: "271828",
                requestDigest: mxcRequestDigest(createMxcExtensionRequest()), startEvidence: { installedPayloadVerified: true, baseContainerReady: true,
                  exactRequestAccepted: true, uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true } });
              else if (type === "native-created") await channel.send({ type, id: 42, processHandle: "161803" });
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
