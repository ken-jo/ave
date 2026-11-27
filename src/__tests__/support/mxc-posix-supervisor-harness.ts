import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { MxcExtensionChannel, type MxcFramePayload } from "../../permissions/mxc-extension-channel.js";
import type { MxcShellRuntime, MxcShellSdk } from "../../permissions/mxc-shell-supervisor-bootstrap.js";
import { createMxcNativeProcess } from "./mxc-supervisor.js";

const GENERATION = "b".repeat(64);
const KEY = Buffer.alloc(32, 7);

/** A minimal staged macOS request that the supervisor services accept and map. */
export function stageSeatbeltWire(directory: string, overrides: { readonly timeout?: number; readonly cwd?: string } = {}) {
  const wire = {
    version: "1.0.0", containment: "seatbelt",
    process: { commandLine: "/usr/bin/true", cwd: overrides.cwd ?? directory, timeout: overrides.timeout ?? 1_000, inheritDefaultEnv: false, env: ["PATH=/usr/bin:/bin"] },
    filesystem: { readwritePaths: [directory], readonlyPaths: [], deniedPaths: [] },
    network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
    runtimeConfig: { networkProxy: "http://127.0.0.1:9" },
    seatbelt: { profileOverride: "(version 1)\n(deny default)\n", nestedPty: false },
    ui: { disable: true, clipboard: "none", injection: false },
  };
  const bytes = Buffer.from(JSON.stringify(wire));
  const requestPath = join(directory, `request-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(requestPath, bytes, { mode: 0o600 });
  const cwd = statSync(wire.process.cwd, { bigint: true });
  return {
    requestPath, requestSha256: createHash("sha256").update(bytes).digest("hex"),
    cwdIdentity: { realpath: wire.process.cwd, dev: String(cwd.dev), ino: String(cwd.ino) },
  };
}

/**
 * One in-process macOS supervisor service over paired streams, with a scripted SDK. The host side reads every
 * receipt the service sends; `natives` holds each process the fake SDK handed out.
 */
export function createPosixSupervisorHarness() {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-mxc-posix-service-")));
  const toSupervisor = new PassThrough(), toHost = new PassThrough();
  const host = new MxcExtensionChannel(toHost, toSupervisor, GENERATION, KEY, "host");
  const supervisor = new MxcExtensionChannel(toSupervisor, toHost, GENERATION, KEY, "supervisor");
  const liveness = new PassThrough();
  const stdout = new PassThrough(), stderr = new PassThrough();
  const natives: ReturnType<typeof createMxcNativeProcess>[] = [];
  const spawned: unknown[] = [];
  let spawnGate: Promise<void> = Promise.resolve();
  let releaseSpawn: (() => void) | undefined;
  // What the scripted workload's cwd prelude reports first on stdout, and whether the host side grants the run.
  let verdict: "R" | "C" | "" = "R";
  let grantOnVerified = true;
  class MxcError extends Error {
    constructor(readonly code: string) { super(code); }
  }
  const sdk = {
    MxcError,
    spawn: async (request: unknown) => {
      spawned.push(request);
      await spawnGate;
      const fixture = createMxcNativeProcess();
      natives.push(fixture);
      if (verdict !== "") fixture.stdout.write(verdict);
      return fixture.native;
    },
  } as unknown as MxcShellSdk;
  const frames: MxcFramePayload[] = [];
  const received = (async () => {
    for await (const frame of host.frames()) {
      const { version: _v, generation: _g, sequence: _s, ...payload } = frame;
      frames.push(payload as MxcFramePayload);
      if (payload.type === "shell-cwd-verified" && grantOnVerified) await host.send({ type: "spawn-authorized" });
    }
  })().catch(() => {});
  let fatal = 0;
  let libraryInPlace = true;
  return {
    directory, host, supervisor, liveness, stdout, stderr, sdk, natives, spawned, frames, received,
    bootstrap: (): Promise<MxcShellRuntime> => Promise.resolve({ sdk, assertLibraryInPlace: () => {
      if (!libraryInPlace) throw new Error("library replaced");
    } }),
    replaceLibrary() { libraryInPlace = false; },
    reportVerdict(value: "R" | "C" | "") { verdict = value; },
    withholdGrant() { grantOnVerified = false; },
    onFatal: () => { fatal += 1; },
    get fatal() { return fatal; },
    holdSpawn() { spawnGate = new Promise((resolve) => { releaseSpawn = resolve; }); },
    releaseSpawn() { releaseSpawn?.(); },
    async waitFor(type: MxcFramePayload["type"]) {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const frame = frames.find((entry) => entry.type === type);
        if (frame !== undefined) return frame;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`No ${type} frame`);
    },
    dispose() { rmSync(directory, { recursive: true, force: true }); },
  };
}
