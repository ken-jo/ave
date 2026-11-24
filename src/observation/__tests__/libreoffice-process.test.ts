import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chmod, mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import childProcess, { spawn, spawnSync, execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedDocumentEngineInstallation } from "../../main/document-engine-installation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";
import { TableDocumentError } from "../../tools/table-document-error.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { afterQueuedCallbacks, deferred } from "../../__tests__/support/deferred.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const HOST_PLATFORM = process.platform;
const residentStartup = { publish: true };
const javaFixture = vi.hoisted(() => ({ home: undefined as string | undefined, broken: false, registrationFails: false }));
const engineRegistration = vi.hoisted(() => ({ beforeRetain: undefined as (() => void) | undefined }));
// win32 chmod maps only the read-only attribute, so a 0o400 create reads back as 0o444 (r--r--r--).
const READ_ONLY_FILE_MODE = process.platform === "win32" ? 0o444 : 0o400;

vi.mock("../../permissions/offline-process-sandbox.js", async (original) => ({
  ...await original<typeof import("../../permissions/offline-process-sandbox.js")>(),
  wrapOfflineProcess: vi.fn<typeof import("../../permissions/offline-process-sandbox.js").wrapOfflineProcess>(async input => ({
    argv: [input.command, ...input.args], env: input.env,
  })),
}));
vi.mock("../../main/managed-child-processes.js", async original => {
  const actual = await original<typeof import("../../main/managed-child-processes.js")>();
  return {
    ...actual,
    spawnManaged: vi.fn(),
    forceKillManagedChildProcess: vi.fn(),
    observeManagedProcessGroup: (child: ChildProcess, scope?: Parameters<typeof actual.observeManagedProcessGroup>[1]) => {
      const group = actual.observeManagedProcessGroup(child, scope);
      if (child.pid !== undefined) return group;
      return { ...group, confirmExit: (reason: string) => {
        (child as unknown as ProcessFixture).end(null, "SIGKILL");
        return group.confirmExit(reason);
      } };
    },
  };
});
vi.mock("../../main/process-group-reaper.js", () => ({
  createProcessGroupReaper: () => ({ retain: () => engineRegistration.beforeRetain?.(), release: () => {}, shutdown: () => {} }),
}));
vi.mock("../../main/codex-executable-location.js", async original => ({
  ...await original<typeof import("../../main/codex-executable-location.js")>(),
  createPrivateTempDirectory: () => mkdtemp(join(directory, "session-")),
}));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  // A regular fixture file stands in for the instance's private UNIX socket.
  return { ...actual, lstat: vi.fn(async (path, ...args) => String(path).includes("OSL_PIPE_")
    ? Object.assign(await actual.lstat(path), { isSocket: (): boolean => true, isFile: (): boolean => false })
    : actual.lstat(path, ...args)),
    realpath: vi.fn(async (path, ...args) => javaFixture.home && String(path).includes("fixture-java")
      ? javaFixture.home : actual.realpath(path, ...args)),
    readdir: vi.fn(async (path, ...args) => ["/Library/Java/JavaVirtualMachines", "/usr/lib/jvm", "/usr/java"].includes(String(path))
      ? javaFixture.home ? [{ name: "fixture-java", isDirectory: (): boolean => true, isSymbolicLink: (): boolean => false }] : []
      : actual.readdir(path, ...args)),
  };
});

import { LibreOfficeSessionPool, sweepStaleDocumentEngineRuntimes } from "../libreoffice-process.js";
import { __resetManagedChildProcessesForTest, spawnManaged, forceKillManagedChildProcess, recordManagedCleanup } from "../../main/managed-child-processes.js";
import { OfflineScanExitUnconfirmedError, wrapOfflineProcess } from "../../permissions/offline-process-sandbox.js";
import { fakeFixtureAclTransport, installFixtureAclTransport } from "../../__tests__/support/native-executable.js";
import { _setWindowsAclTransportForTest } from "../../main/windows-acl-host.js";

const managed = await vi.importActual<typeof import("../../main/managed-child-processes.js")>("../../main/managed-child-processes.js");

interface ConversionJob { source: string; outputDirectory: string; extension: string; filter: string; inputFilter?: string }

interface ProcessFixture extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  ended: boolean;
  args: readonly string[];
  profile: string;
  ipc: string;
  resident: boolean;
  holder?: string;
  job?: ConversionJob;
  end(code?: number | null, signal?: NodeJS.Signals | null): void;
}

let directory: string;
let installation: VerifiedDocumentEngineInstallation;
let pool: LibreOfficeSessionPool;
let children: ProcessFixture[];
let createProcessFixture: (command: string, args: readonly string[]) => ProcessFixture;
let conversion: (client: ProcessFixture, resident: ProcessFixture) => Promise<void>;
let readiness: (client: ProcessFixture, resident: ProcessFixture) => Promise<void>;

const residents = (): ProcessFixture[] => children.filter(child => child.resident);
const jobs = (): ProcessFixture[] => children.filter(child => child.job && !child.job.source.endsWith(".fodt"));
const probes = (): ProcessFixture[] => children.filter(child => child.job?.source.endsWith(".fodt"));

function destination(job: ConversionJob): string {
  return join(job.outputDirectory, basename(job.source).replace(/\.[^.]+$/u, `.${job.extension}`));
}

/** The forwarding client exits after the resident prints its receipt and writes the export. */
async function publish(client: ProcessFixture, resident: ProcessFixture): Promise<void> {
  const job = client.job!;
  resident.stdout.write(`convert ${job.source} as a Writer document -> ${destination(job)} using filter : ${job.filter}\n`);
  await writeFile(destination(job), job.extension === "pdf" ? "%PDF-1.4\nprivate preview\n" : `${job.extension} export`);
  client.end();
}

function parseJob(args: readonly string[]): ConversionJob {
  const conversionIndex = args.indexOf("--convert-to");
  const [extension, filter] = args[conversionIndex + 1]!.split(/:(.*)/su);
  const inputFilter = args.find(argument => argument.startsWith("--infilter="))?.slice("--infilter=".length);
  return { source: args.at(-1)!, outputDirectory: args[args.indexOf("--outdir") + 1]!, extension: extension!, filter: filter!,
    ...(inputFilter ? { inputFilter } : {}) };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Expected process boundary was not reached.");
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (HOST_PLATFORM === "win32") installFixtureAclTransport(fakeFixtureAclTransport(execFile));
  javaFixture.home = undefined;
  javaFixture.broken = false;
  javaFixture.registrationFails = false;
  residentStartup.publish = true;
  directory = await mkdtemp(join(tmpdir(), "engine-process-contract-"));
  const root = join(directory, "runtime");
  await mkdir(root);
  installation = {
    root, executable: join(root, "soffice"), unopkg: join(root, "unopkg"), version: "26.8.1",
    extensionPath: join(root, "importer.oxt"), extensionSha256: "0".repeat(64),
    assertCurrent: vi.fn(), verifyBeforeSpawn: vi.fn(async signal => { signal.throwIfAborted(); }),
  };
  children = [];
  conversion = publish;
  readiness = publish;
  createProcessFixture = (command, args) => {
    const emitter = new EventEmitter() as ProcessFixture;
    emitter.stdout = new PassThrough();
    emitter.stderr = new PassThrough();
    emitter.args = args;
    emitter.ended = false;
    const profileArgument = args.find(argument => argument.startsWith("-env:UserInstallation="));
    emitter.profile = profileArgument ? fileURLToPath(profileArgument.slice("-env:UserInstallation=".length)) : children[0]?.profile ?? "";
    emitter.ipc = args.find(argument => argument.startsWith("-env:OSL_SOCKET_PATH="))?.slice("-env:OSL_SOCKET_PATH=".length) ?? "";
    emitter.resident = command === installation.executable && !args.includes("--convert-to") && args.at(-1)!.endsWith(".fodt");
    emitter.end = (code = 0, signal = null) => {
      if (emitter.ended) return;
      emitter.ended = true;
      emitter.emit("close", code, signal);
    };
    children.push(emitter);
    if (emitter.resident) {
      // The real instance publishes its private single-instance pipe (the lstat mock reports it as a socket) and
      // locks the holder document once that document is in a frame.
      emitter.holder = args.at(-1)!;
      if (residentStartup.publish) void Promise.all([writeFile(join(emitter.ipc, "OSL_PIPE_501_SingleOfficeIPC_fixture"), ""),
        writeFile(join(dirname(emitter.holder), `.~lock.${basename(emitter.holder)}#`), "")]);
    } else if (command === installation.executable && args.includes("--convert-to")) {
      emitter.job = parseJob(args);
      queueMicrotask(() => {
        const resident = [...residents()].reverse().find(candidate => candidate.profile === emitter.profile && !candidate.ended);
        if (!resident) { emitter.stderr.write("no resident"); emitter.end(1); return; }
        const handler = emitter.job!.source.endsWith(".fodt") ? readiness : conversion;
        void handler(emitter, resident).catch(error => { emitter.stderr.write(String(error)); emitter.end(1); });
      });
    }
    else if (command.endsWith(sep + join("bin", "java"))) queueMicrotask(() => { emitter.stderr.write(javaFixture.broken ? "runtime cannot start" : 'openjdk version "17.0.1"'); emitter.end(javaFixture.broken ? 1 : 0); });
    else if (args.includes("add") || args.includes("list")) queueMicrotask(() => {
      if (javaFixture.registrationFails) { emitter.stderr.write("ERROR: unopkg failed."); emitter.end(1); return; }
      emitter.stdout.write("H2Orestart registered");
      emitter.end();
    });
    return emitter;
  };
  vi.mocked(spawnManaged).mockImplementation((command, args, _options, _track, acquire) => {
    const child = createProcessFixture(command, args) as unknown as ChildProcess;
    acquire?.(child);
    return child;
  });
  vi.mocked(forceKillManagedChildProcess).mockImplementation(child => { (child as unknown as ProcessFixture).end(null, "SIGKILL"); });
  pool = new LibreOfficeSessionPool();
});

afterEach(async () => { await pool.dispose(); if (HOST_PLATFORM === "win32") _setWindowsAclTransportForTest(undefined); await rm(directory, { recursive: true, force: true }); });

function mockManagedEngineGroup(startResident = false) {
  setProcessPlatform("linux");
  const groupPid = 14002;
  const launched = deferred<EventEmitter>();
  let child: EventEmitter | undefined;
  let groupAlive = true;
  const nativeKill = process.kill;
  const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (Math.abs(pid) !== groupPid) return nativeKill(pid, signal);
    if (!groupAlive) throw Object.assign(new Error("Group exited"), { code: "ESRCH" });
    if (signal === 0) return true;
    throw Object.assign(new Error("Group still running"), { code: "EPERM" });
  });
  vi.mocked(spawnManaged).mockImplementationOnce((...args) => {
    const acquired = Object.assign(startResident ? createProcessFixture(args[0], args[1]) : new EventEmitter(), {
      pid: groupPid, spawnfile: "/fixture-engine", exitCode: null, signalCode: null,
    });
    child = acquired;
    const spawnFixture = vi.spyOn(childProcess, "spawn").mockReturnValueOnce(acquired as unknown as ChildProcess);
    syncBuiltinESMExports();
    try { return managed.spawnManaged(...args); }
    finally {
      spawnFixture.mockRestore();
      syncBuiltinESMExports();
      launched.resolve(acquired);
    }
  });
  const wrap = vi.fn();
  vi.mocked(wrapOfflineProcess).mockImplementationOnce(async input => {
    recordManagedCleanup(input.resources, wrap);
    return { argv: [input.command, ...input.args], env: input.env };
  });
  const markGroupGone = (): void => { groupAlive = false; };
  return { pid: groupPid, launched, kill, wrap, markGroupGone, restore: async () => {
    markGroupGone();
    child?.emit("close", null, "SIGKILL");
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processGroupPollMs);
    await pool.dispose().catch(() => {});
    pool = new LibreOfficeSessionPool();
    engineRegistration.beforeRetain = undefined;
    __resetManagedChildProcessesForTest();
    kill.mockRestore();
    setProcessPlatform(HOST_PLATFORM);
    vi.useRealTimers();
  } };
}

describe("private conversion process ownership", () => {
  it("keeps one resident profile and revalidates each launch while preserving the immutable input", async () => {
    const input = Buffer.from("admitted bytes");
    let received: Buffer | undefined;
    conversion = async (client, resident) => {
      const source = client.job!.source;
      received = await readFile(source);
      expect((await stat(source)).mode & 0o777).toBe(READ_ONLY_FILE_MODE);
      await publish(client, resident);
    };
    expect((await pool.convert(installation, "one", input, "docx", new AbortController().signal)).pdf.toString()).toContain("%PDF-");
    await pool.convert(installation, "one", input, "pptx", new AbortController().signal);
    expect(received).toEqual(input);
    expect(input.toString()).toBe("admitted bytes");
    expect(residents()).toHaveLength(1);
    expect(children.some(child => child.args.some(arg => arg.startsWith("--accept=")))).toBe(false);
    expect(children[1].job).toMatchObject({ extension: "pdf", filter: "writer_pdf_Export" });
    expect(probes()).toHaveLength(1);
    expect(jobs().map(child => child.job!.filter)).toEqual(["writer_pdf_Export", "impress_pdf_Export"]);
    expect(new Set(children.map(child => child.profile)).size).toBe(1);
    expect(installation.verifyBeforeSpawn).toHaveBeenCalledTimes(5);
    // One synchronous boundary check per launch, after confinement wrapping and immediately before spawn.
    expect(installation.assertCurrent).toHaveBeenCalledTimes(4);
    const profile = children[0].profile;
    const settings = await readFile(join(profile, "user", "registrymodifications.xcu"), "utf8");
    expect(settings).toMatch(/Security\/Scripting">(?:(?!<\/item>)[\s\S])*<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true<\/value><\/prop>/);
    expect(JSON.parse(await readFile(join(dirname(dirname(profile)), "owner.json"), "utf8")))
      .toEqual({ kind: "ave-document-engine-runtime", pid: process.pid });
    for (const call of vi.mocked(wrapOfflineProcess).mock.calls) {
      expect(call[0].inputDirectory).not.toBe(call[0].outputDirectory);
      expect(call[0].env.HOME).toBe(call[0].outputDirectory);
      expect(call[0].env.SAL_USE_VCLPLUGIN).toBe("svp");
    }
  });

  it("waits for the resident's readiness probe before staging admitted bytes", async () => {
    let resume!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    readiness = async (client, resident) => { await hold; if (!client.ended) await publish(client, resident); };
    const pending = pool.convert(installation, "one", Buffer.from("bytes"), "docx", new AbortController().signal);
    await eventually(() => probes().length === 1);
    expect(jobs()).toHaveLength(0);
    resume();
    await pending;
    expect(jobs()).toHaveLength(1);
  });

  it("forwards nothing until the resident's holder document is framed and its pipe exists", async () => {
    residentStartup.publish = false;
    const pending = pool.convert(installation, "one", Buffer.from("bytes"), "docx", new AbortController().signal);
    await eventually(() => residents().length === 1);
    const resident = residents()[0];
    await writeFile(join(resident.ipc, "OSL_PIPE_501_SingleOfficeIPC_fixture"), "");
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(probes()).toHaveLength(0);
    await writeFile(join(dirname(resident.holder!), `.~lock.${basename(resident.holder!)}#`), "");
    await pending;
    expect(probes()).toHaveLength(1);
    expect(dirname(resident.holder!)).toBe(join(dirname(resident.ipc), "holder"));
  });

  it("forwards host-selected recalculation exports for workbooks", async () => {
    const xlsx = await pool.convert(installation, "one", Buffer.from("xlsx"), "xlsx", new AbortController().signal);
    const ods = await pool.convert(installation, "one", Buffer.from("ods"), "ods", new AbortController().signal);
    expect(xlsx).toMatchObject({ pdf: Buffer.alloc(0) });
    expect(xlsx.recalculated?.toString()).toBe("xlsx export");
    expect(ods.recalculated?.toString()).toBe("ods export");
    expect(jobs().map(child => child.job!.filter)).toEqual(["Calc MS Excel 2007 XML", "calc8"]);
    expect(residents()).toHaveLength(1);
  });

  it("serializes one session while independent sessions keep separate profiles", async () => {
    let resume!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    let requests = 0;
    conversion = async (client, resident) => { if (++requests === 1) await hold; if (!client.ended) await publish(client, resident); };
    const first = pool.convert(installation, "one", Buffer.from("first"), "docx", new AbortController().signal);
    await eventually(() => requests === 1);
    const second = pool.convert(installation, "one", Buffer.from("second"), "docx", new AbortController().signal);
    const other = pool.convert(installation, "two", Buffer.from("other"), "docx", new AbortController().signal);
    await other;
    expect(requests).toBe(2);
    expect(new Set(children.map(child => child.profile)).size).toBe(2);
    resume();
    await Promise.all([first, second]);
    expect(requests).toBe(3);
  });

  it("drops a cancelled queued request before a second launch and preserves the active request", async () => {
    let resume!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    conversion = async (client, resident) => { await hold; if (!client.ended) await publish(client, resident); };
    const active = pool.convert(installation, "one", Buffer.from("active"), "docx", new AbortController().signal);
    await eventually(() => jobs().length === 1);
    const controller = new AbortController();
    const queued = pool.convert(installation, "one", Buffer.from("queued"), "docx", controller.signal);
    controller.abort(new Error("queued request cancelled"));
    await expect(queued).rejects.toThrow("queued request cancelled");
    expect(forceKillManagedChildProcess).not.toHaveBeenCalled();
    resume();
    await active;
    expect(children).toHaveLength(3);
  });

  it("rebuilds private process state after an ordinary superseding cancellation", async () => {
    let resume!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    conversion = async (client, resident) => { await hold; if (!client.ended) await publish(client, resident); };
    const controller = new AbortController();
    const first = pool.convert(installation, "one", Buffer.from("old"), "docx", controller.signal);
    await eventually(() => jobs().length === 1);
    const oldProfile = children[0].profile;
    controller.abort(new Error("superseded"));
    await expect(first).rejects.toThrow("superseded");
    resume();
    conversion = publish;
    await pool.convert(installation, "one", Buffer.from("new"), "docx", new AbortController().signal);
    expect(residents()[1].profile).not.toBe(oldProfile);
    expect(children[0].ended).toBe(true);
    await expect(stat(oldProfile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports an unexpected resident exit and does not silently restart it", async () => {
    await pool.convert(installation, "one", Buffer.from("bytes"), "docx", new AbortController().signal);
    children[0].end(1);
    await expect(pool.convert(installation, "one", Buffer.from("bytes"), "docx", new AbortController().signal))
      .rejects.toMatchObject({ code: "engine-failed" });
    expect(children).toHaveLength(3);
  });

  it("rejects a forwarded conversion whose promised document output is missing", async () => {
    conversion = async (client, resident) => {
      const job = client.job!;
      resident.stdout.write(`convert ${job.source} as a Writer document -> ${destination(job)} using filter : ${job.filter}\n`);
      client.end();
    };
    await expect(pool.convert(installation, "one", Buffer.from("bytes"), "docx", new AbortController().signal))
      .rejects.toMatchObject({ code: "engine-failed", message: "Document engine did not produce the expected output." });
    expect(children[0].ended).toBe(true);
    expect(children).toHaveLength(3);
  });

  it("rejects a conversion the resident reported as failed even though the client exited cleanly", async () => {
    conversion = async (client, resident) => {
      resident.stderr.write("Error: Please verify input parameters... (SfxBaseModel::impl_store failed)\n");
      await publish(client, resident);
    };
    await expect(pool.convert(installation, "one", Buffer.from("bytes"), "docx", new AbortController().signal))
      .rejects.toMatchObject({ code: "engine-failed", message: "Document engine rejected the conversion." });
  });

  it("refuses a client that performed the conversion itself instead of forwarding it", async () => {
    conversion = async client => {
      const job = client.job!;
      client.stdout.write(`convert ${job.source} as a Writer document -> ${destination(job)} using filter : ${job.filter}\n`);
      await writeFile(destination(job), "%PDF-1.4\n");
      client.end();
    };
    await expect(pool.convert(installation, "one", Buffer.from("bytes"), "docx", new AbortController().signal))
      .rejects.toMatchObject({ code: "engine-failed", message: "Document engine conversion bypassed the session instance." });
  });

  it("requires the resident's receipt before accepting a forwarded export", async () => {
    conversion = async client => {
      await writeFile(destination(client.job!), "%PDF-1.4\n");
      client.end();
    };
    await expect(pool.convert(installation, "one", Buffer.from("bytes"), "docx", new AbortController().signal))
      .rejects.toMatchObject({ code: "engine-failed", message: "Document engine session instance did not acknowledge the conversion." });
  });

  it("rejects an unavailable importer runtime explicitly and still permits another format", async () => {
    await expect(pool.convert(installation, "one", Buffer.from("hwp"), "hwp", new AbortController().signal))
      .rejects.toMatchObject({ code: "engine-runtime-unavailable" });
    await pool.convert(installation, "one", Buffer.from("docx"), "docx", new AbortController().signal);
    expect(residents()).toHaveLength(2);
  });

  it("registers the pinned importer only from a read-only private input copy", async () => {
    const home = join(directory, "java");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(join(home, "bin", "java"), "test runtime", { mode: 0o500 });
    await writeFile(join(home, "release"), 'JAVA_VERSION="17.0.1"\n');
    javaFixture.home = home;
    const extension = Buffer.from("authenticated import extension");
    await writeFile(installation.extensionPath, extension);
    installation = { ...installation, extensionSha256: createHash("sha256").update(extension).digest("hex") };
    const result = await pool.convert(installation, "one", Buffer.from("HWP admitted bytes"), "hwp", new AbortController().signal);
    expect(result.pdf.toString()).toContain("%PDF-");
    expect(result.structured?.toString()).toBe("odt export");
    expect(jobs().map(child => [child.job!.extension, child.job!.inputFilter])).toEqual([["pdf", "Hwp2002_Reader"], ["odt", "Hwp2002_Reader"]]);
    const add = vi.mocked(wrapOfflineProcess).mock.calls.find(call => call[0].args.includes("add"))![0];
    const staged = add.args.at(-1)!;
    expect(dirname(staged)).toBe(add.inputDirectory);
    expect(staged).not.toBe(installation.extensionPath);
    expect((await stat(staged)).mode & 0o777).toBe(READ_ONLY_FILE_MODE);
    expect(await readFile(staged)).toEqual(extension);
    expect(add.runtimeDirectories).toEqual([installation.root, home]);
    expect(add.env.UNO_JAVA_JFW_JREHOME).toMatch(/^file:/u);
  });

  it("reports a broken importer runtime and recovers ordinary conversion on the next request", async () => {
    const home = join(directory, "java");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(join(home, "bin", "java"), "test runtime", { mode: 0o500 });
    await writeFile(join(home, "release"), 'JAVA_VERSION="17.0.1"\n');
    javaFixture.home = home;
    javaFixture.broken = true;
    await expect(pool.convert(installation, "one", Buffer.from("hwp"), "hwp", new AbortController().signal))
      .rejects.toMatchObject({ code: "engine-runtime-unavailable" });
    await pool.convert(installation, "one", Buffer.from("docx"), "docx", new AbortController().signal);
    expect(residents()).toHaveLength(2);
  });

  it("reports failed importer registration as an unavailable runtime without poisoning the session", async () => {
    const home = join(directory, "java");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(join(home, "bin", "java"), "test runtime", { mode: 0o500 });
    await writeFile(join(home, "release"), 'JAVA_VERSION="17.0.1"\n');
    javaFixture.home = home;
    javaFixture.registrationFails = true;
    const extension = Buffer.from("authenticated import extension");
    await writeFile(installation.extensionPath, extension);
    installation = { ...installation, extensionSha256: createHash("sha256").update(extension).digest("hex") };
    await expect(pool.convert(installation, "one", Buffer.from("hwp"), "hwp", new AbortController().signal))
      .rejects.toMatchObject({ code: "engine-runtime-unavailable", message: "Document importer registration failed in the private profile." });
    await pool.convert(installation, "one", Buffer.from("docx"), "docx", new AbortController().signal);
    expect(residents()).toHaveLength(2);
  });

  it("does not spawn an engine when offline setup refuses the scan", async () => {
    const refusal = new TableDocumentError("engine-confinement-unavailable", "Offline scan did not complete.");
    vi.mocked(wrapOfflineProcess).mockRejectedValueOnce(refusal);
    await expect(pool.prepare(installation, "one", "docx", new AbortController().signal)).rejects.toBe(refusal);
    expect(wrapOfflineProcess).toHaveBeenCalledTimes(1);
    expect(spawnManaged).not.toHaveBeenCalled();
  });

  it("keeps an existing runtime when an aborted preflight has unconfirmed termination", async () => {
    const controller = new AbortController();
    await pool.prepare(installation, "one", "docx", controller.signal);
    const childCount = children.length;
    const refusal = new OfflineScanExitUnconfirmedError();
    let scratch: string | undefined;
    vi.mocked(wrapOfflineProcess).mockImplementationOnce(async input => {
      scratch = await mkdtemp(join(dirname(input.inputDirectory), ".offline-scan-"));
      controller.abort(new Error("Stopped during the scan"));
      throw refusal;
    });
    try {
      await expect(pool.convert(installation, "one", Buffer.from("bytes"), "docx", controller.signal)).rejects.toBe(refusal);
      expect(children).toHaveLength(childCount);
      expect(scratch).toBeDefined();
      if (!scratch) throw new Error("Expected retained scan scratch.");
      expect((await stat(scratch)).isDirectory()).toBe(true);
      await expect(pool.releaseSession("one")).rejects.toBe(refusal);
      expect((await stat(scratch)).isDirectory()).toBe(true);
    } finally {
      await pool.dispose().catch(() => {});
      if (scratch) await rm(dirname(scratch), { recursive: true, force: true });
      pool = new LibreOfficeSessionPool();
    }
  });

  it.each(["startup", "existing runtime"] as const)("retains the wrap and files after live-group registration failure during %s", async entry => {
    const controller = new AbortController();
    if (entry === "existing runtime") await pool.prepare(installation, "one", "docx", controller.signal);
    const group = mockManagedEngineGroup();
    engineRegistration.beforeRetain = () => {
      if (entry === "existing runtime") controller.abort(new Error("Stopped during registration"));
      throw new Error("Injected engine registration failure");
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const request = entry === "startup"
      ? pool.prepare(installation, "one", "docx", controller.signal)
      : pool.convert(installation, "one", Buffer.from("retained input"), "docx", controller.signal);
    const settlement = request.catch((error: unknown) => error);
    try {
      const child = await group.launched.promise;
      child.emit("close", null, "SIGKILL");
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processTreeKillMs);
      const verdict = await settlement;
      expect(verdict).toMatchObject({ code: "engine-confinement-unavailable", message: "Document engine termination was not confirmed." });
      expect(group.kill).toHaveBeenCalledWith(-group.pid, 0);
      expect(group.wrap).not.toHaveBeenCalled();
      const launch = vi.mocked(wrapOfflineProcess).mock.calls.at(-1)?.[0];
      if (!launch) throw new Error("Expected an acquired engine launch.");
      expect((await stat(dirname(launch.inputDirectory))).isDirectory()).toBe(true);
      if (entry === "existing runtime") {
        const input = launch.args.at(-1);
        if (!input) throw new Error("Expected a staged document.");
        expect(await readFile(input, "utf8")).toBe("retained input");
      }
      await expect(pool.releaseSession("one")).rejects.toBe(verdict);
    } finally { await group.restore(); }
  });

  it.each(["missing close", "leader close with a surviving group"] as const)("reports unconfirmed shutdown after %s", async exit => {
    const group = mockManagedEngineGroup(true);
    try {
      await pool.prepare(installation, "one", "docx", new AbortController().signal);
      const child = await group.launched.promise;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      if (exit !== "missing close") child.emit("close", 0, null);
      let verdict: unknown;
      const release = pool.releaseSession("one").catch((error: unknown) => { verdict = error; });
      if (exit === "missing close") group.markGroupGone();
      await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.processTreeKillMs - 1);
      expect(verdict).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await afterQueuedCallbacks();
      expect(verdict).toMatchObject({ code: "engine-confinement-unavailable", message: "Document engine termination was not confirmed." });
      expect(group.kill).toHaveBeenCalledWith(-group.pid, "SIGKILL");
      expect(group.wrap).not.toHaveBeenCalled();
      const holder = residents()[0]?.holder;
      if (!holder) throw new Error("Expected the resident holder file.");
      expect((await stat(holder)).isFile()).toBe(true);
      await release;
    } finally { await group.restore(); }
  });

  it.each(["conversion", "readiness"] as const)("retains staged files when wrap cleanup fails during %s", async entry => {
    const group = mockManagedEngineGroup(true);
    const cleanupFailure = new Error("Injected mount ownership descriptor release failure");
    const signal = new AbortController().signal;
    const staged = deferred<ConversionJob>();
    const failForwarding = async (client: ProcessFixture): Promise<void> => {
      if (!client.job) throw new Error("Expected a forwarding job.");
      staged.resolve(client.job);
      client.end(1);
    };
    const failingWrap = async (input: Parameters<typeof wrapOfflineProcess>[0]) => {
      recordManagedCleanup(input.resources, () => { throw cleanupFailure; });
      return { argv: [input.command, ...input.args], env: input.env };
    };
    try {
      if (entry === "conversion") {
        await pool.prepare(installation, "one", "docx", signal);
        conversion = failForwarding;
      } else {
        readiness = failForwarding;
      }
      vi.mocked(wrapOfflineProcess).mockImplementationOnce(failingWrap);
      const request = entry === "conversion"
        ? pool.convert(installation, "one", Buffer.from("retained input"), "docx", signal)
        : pool.prepare(installation, "one", "docx", signal);
      const settlement = request.catch((error: unknown) => error);
      const [resident, job] = await Promise.all([group.launched.promise, staged.promise]);
      const original = await readFile(job.source, "utf8").catch((error: NodeJS.ErrnoException) => error.code);
      resident.emit("close", 0, null);
      const verdict = await settlement;
      expect(verdict).toMatchObject({
        code: "engine-confinement-unavailable", message: "Document engine termination was not confirmed.",
      });
      expect(original).toEqual(entry === "conversion" ? "retained input" : expect.stringContaining("office:document"));
      expect(await readFile(job.source, "utf8")).toBe(original);
      expect((await stat(job.outputDirectory)).isDirectory()).toBe(true);
      expect(group.wrap).not.toHaveBeenCalled();
    } finally { await group.restore(); }
  });

  it("refuses empty and over-budget requests without starting a process", async () => {
    await expect(pool.convert(installation, "one", Buffer.alloc(0), "xlsx", new AbortController().signal))
      .rejects.toMatchObject({ code: "corrupt-document" });
    await expect(pool.convert(installation, "one", Buffer.alloc(PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1), "xlsx", new AbortController().signal))
      .rejects.toMatchObject({ code: "too-large" });
    expect(spawnManaged).not.toHaveBeenCalled();
  });
});

describe("stale private runtime directories", () => {
  async function runtimeDirectory(root: string, name: string, pid: number | undefined, mode = 0o700): Promise<string> {
    const path = join(root, name);
    await mkdir(join(path, "input"), { recursive: true });
    await writeFile(join(path, "input", "source.docx"), "admitted copy", { mode: 0o400 });
    if (pid !== undefined) await writeFile(join(path, "owner.json"), JSON.stringify({ kind: "ave-document-engine-runtime", pid }), { mode: 0o600 });
    await chmod(path, mode);
    return path;
  }

  it("removes only this user's marked directories whose owning process no longer runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "ave-runtime-sweep-"));
    try {
      if (process.platform === "win32") {
        // No POSIX owner identity and no converter runtime on Windows: the sweep owns nothing there.
        await runtimeDirectory(root, "avd-dead", 2 ** 30);
        expect(await sweepStaleDocumentEngineRuntimes(root)).toEqual([]);
        return;
      }
      const exited = spawnSync(process.execPath, ["-e", ""], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
      expect(exited.status).toBe(0);
      const dead = await runtimeDirectory(root, "avd-dead", exited.pid);
      const live = await runtimeDirectory(root, "avd-live", process.ppid);
      const self = await runtimeDirectory(root, "avd-self", process.pid);
      const unmarked = await runtimeDirectory(root, "avd-unmarked", undefined);
      const shared = await runtimeDirectory(root, "avd-shared", exited.pid, 0o755);
      const unrelated = await runtimeDirectory(root, "other-dead", exited.pid);
      const target = await runtimeDirectory(root, "link-target", exited.pid);
      await symlink(target, join(root, "avd-link"));
      // The crashed owner's confined resident outlives it; it is recognised only by that directory's unique profile.
      const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `-env:UserInstallation=${pathToFileURL(join(dead, "output", "profile")).href}`],
        { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
      const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "--", `-env:UserInstallation=${pathToFileURL(join(live, "output", "profile")).href}`],
        { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
      const exitOf = (child: typeof orphan) => new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
      const orphanExit = exitOf(orphan);
      try {
        await vi.waitFor(() => expect(orphan.pid).toBeTypeOf("number"));
        expect(await sweepStaleDocumentEngineRuntimes(root)).toEqual([dead]);
        expect(await orphanExit).toBe("SIGKILL");
        expect(bystander.exitCode).toBeNull();
        expect(bystander.signalCode).toBeNull();
      } finally { orphan.kill("SIGKILL"); bystander.kill("SIGKILL"); }
      await expect(stat(dead)).rejects.toMatchObject({ code: "ENOENT" });
      for (const kept of [live, self, unmarked, shared, unrelated, target]) expect((await stat(kept)).isDirectory()).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
