import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chmod, mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink } from "node:fs/promises";
import { spawn, spawnSync, execFile } from "node:child_process";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedDocumentEngineInstallation } from "../../main/document-engine-installation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";

const residentStartup = { publish: true };
const javaFixture = vi.hoisted(() => ({ home: undefined as string | undefined, broken: false, registrationFails: false }));
// win32 chmod maps only the read-only attribute, so a 0o400 create reads back as 0o444 (r--r--r--).
const READ_ONLY_FILE_MODE = process.platform === "win32" ? 0o444 : 0o400;

vi.mock("../../permissions/offline-process-sandbox.js", () => ({ wrapOfflineProcess: vi.fn(async input => ({
  argv: [input.command, ...input.args], env: input.env, release: vi.fn(),
})) }));
vi.mock("../../main/managed-child-processes.js", () => ({ spawnManaged: vi.fn(), forceKillManagedChildProcess: vi.fn() }));
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
import { spawnManaged, forceKillManagedChildProcess } from "../../main/managed-child-processes.js";
import { wrapOfflineProcess } from "../../permissions/offline-process-sandbox.js";
import { configureHostResources } from "../../main/host-resources.js";
import { fakeFixtureAclTransport, installFixtureAclTransport } from "../../__tests__/support/native-executable.js";
import { _setWindowsAclTransportForTest } from "../../main/windows-acl-host.js";

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
  // On win32 the private-temp ownership claim resolves the path-kind helper through host resources and
  // spawns the ACL host; configure the resources and route the host through the fixture transport so the
  // claim resolves deterministically without the real PowerShell host. POSIX claims via chmod/chown and
  // needs neither, so this is scoped to win32 to keep POSIX behaviour unchanged.
  if (process.platform === "win32") {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    installFixtureAclTransport(fakeFixtureAclTransport(execFile));
  }
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
  vi.mocked(spawnManaged).mockImplementation((command, args) => {
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
    else if (command.endsWith(join("bin", "java"))) queueMicrotask(() => { emitter.stderr.write(javaFixture.broken ? "runtime cannot start" : 'openjdk version "17.0.1"'); emitter.end(javaFixture.broken ? 1 : 0); });
    else if (args.includes("add") || args.includes("list")) queueMicrotask(() => {
      if (javaFixture.registrationFails) { emitter.stderr.write("ERROR: unopkg failed."); emitter.end(1); return; }
      emitter.stdout.write("H2Orestart registered");
      emitter.end();
    });
    return emitter as unknown as ChildProcess;
  });
  vi.mocked(forceKillManagedChildProcess).mockImplementation(child => { (child as unknown as ProcessFixture).end(null, "SIGKILL"); });
  pool = new LibreOfficeSessionPool();
});

afterEach(async () => { await pool.dispose(); _setWindowsAclTransportForTest(undefined); await rm(directory, { recursive: true, force: true }); });

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
