import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VerifiedDocumentEngineInstallation } from "../../main/document-engine-installation.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../shared/preview-document.js";

const javaFixture = vi.hoisted(() => ({ home: undefined as string | undefined, broken: false }));

vi.mock("../../permissions/offline-process-sandbox.js", () => ({ wrapOfflineProcess: vi.fn(async input => ({
  argv: [input.command, ...input.args], env: input.env, release: vi.fn(),
})) }));
vi.mock("../../main/managed-child-processes.js", () => ({ spawnManaged: vi.fn(), forceKillManagedChildProcess: vi.fn() }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(async (path, ...args) => String(path).includes("OSL_PIPE_")
    ? { isSocket: (): boolean => true } : actual.lstat(path, ...args)),
    realpath: vi.fn(async (path, ...args) => javaFixture.home && String(path).includes("fixture-java")
      ? javaFixture.home : actual.realpath(path, ...args)),
    readdir: vi.fn(async (path, ...args) => ["/Library/Java/JavaVirtualMachines", "/usr/lib/jvm", "/usr/java"].includes(String(path))
      ? javaFixture.home ? [{ name: "fixture-java", isDirectory: (): boolean => true, isSymbolicLink: (): boolean => false }] : []
      : actual.readdir(path, ...args)),
  };
});

import { LibreOfficeSessionPool } from "../libreoffice-process.js";
import { spawnManaged, forceKillManagedChildProcess } from "../../main/managed-child-processes.js";
import { wrapOfflineProcess } from "../../permissions/offline-process-sandbox.js";

interface ProcessFixture extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  ended: boolean;
  args: readonly string[];
  profile: string;
  request?: { operation: "ready" | "convert"; source: string; outputDirectory: string; format: string };
  end(code?: number | null, signal?: NodeJS.Signals | null): void;
}

let directory: string;
let installation: VerifiedDocumentEngineInstallation;
let pool: LibreOfficeSessionPool;
let children: ProcessFixture[];
let conversion: (child: ProcessFixture) => Promise<void>;
let readiness: (child: ProcessFixture) => Promise<void>;

async function publish(child: ProcessFixture): Promise<void> {
  const { source, outputDirectory: destination, format } = child.request!;
  const name = basename(source).replace(/\.[^.]+$/u, format === "xlsx" || format === "ods" ? "." + format : ".pdf");
  await writeFile(join(destination, name), format === "xlsx" || format === "ods" ? "recalculated workbook" : "%PDF-1.4\nprivate preview\n");
  if (format === "hwp" || format === "hwpx") await writeFile(join(destination, basename(source).replace(/\.[^.]+$/u, ".odt")), "structured import");
  child.stdout.write(JSON.stringify({ version: 1, converted: true }));
  child.end();
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
  javaFixture.home = undefined;
  javaFixture.broken = false;
  directory = await mkdtemp(join(tmpdir(), "engine-process-contract-"));
  const root = join(directory, "runtime");
  await mkdir(root);
  const python = join(root, "Contents", "Frameworks", "LibreOfficePython.framework", "Versions", "3.13", "Resources", "Python.app", "Contents", "MacOS");
  await mkdir(python, { recursive: true });
  await writeFile(join(python, "LibreOfficePython"), "fixture runtime", { mode: 0o500 });
  await mkdir(join(root, "program"));
  await writeFile(join(root, "program", "python.exe"), "fixture runtime", { mode: 0o500 });
  installation = {
    root, executable: join(root, "soffice"), unopkg: join(root, "unopkg"), version: "26.8.1",
    extensionPath: join(root, "importer.oxt"), extensionSha256: "0".repeat(64),
    assertCurrent: vi.fn(), verifyBeforeSpawn: vi.fn(async signal => { signal.throwIfAborted(); }),
  };
  children = [];
  conversion = publish;
  readiness = async child => { child.stdout.write(JSON.stringify({ version: 1, ready: true })); child.end(); };
  vi.mocked(spawnManaged).mockImplementation((command, args) => {
    const emitter = new EventEmitter() as ProcessFixture;
    emitter.stdout = new PassThrough();
    emitter.stderr = new PassThrough();
    emitter.args = args;
    emitter.ended = false;
    const profileArgument = args.find(argument => argument.startsWith("-env:UserInstallation="));
    emitter.profile = profileArgument ? fileURLToPath(profileArgument.slice("-env:UserInstallation=".length)) : children[0]?.profile ?? "";
    emitter.end = (code = 0, signal = null) => {
      if (emitter.ended) return;
      emitter.ended = true;
      emitter.emit("close", code, signal);
    };
    children.push(emitter);
    if (args.some(argument => argument.endsWith("uno-bridge.py"))) queueMicrotask(() => {
      void readFile(args.at(-1)!, "utf8").then(async raw => {
        emitter.request = JSON.parse(raw);
        if (emitter.request!.operation === "ready") await readiness(emitter);
        else await conversion(emitter);
      }).catch(error => { emitter.stderr.write(String(error)); emitter.end(1); });
    });
    else if (command.endsWith("/bin/java")) queueMicrotask(() => { emitter.stderr.write(javaFixture.broken ? "runtime cannot start" : 'openjdk version "17.0.1"'); emitter.end(javaFixture.broken ? 1 : 0); });
    else if (args.includes("add") || args.includes("list")) queueMicrotask(() => { emitter.stdout.write("H2Orestart registered"); emitter.end(); });
    return emitter as unknown as ChildProcess;
  });
  vi.mocked(forceKillManagedChildProcess).mockImplementation(child => { (child as unknown as ProcessFixture).end(null, "SIGKILL"); });
  pool = new LibreOfficeSessionPool();
});

afterEach(async () => { await pool.dispose(); await rm(directory, { recursive: true, force: true }); });

describe("private conversion process ownership", () => {
  it("keeps one resident profile and revalidates each launch while preserving the immutable input", async () => {
    const input = Buffer.from("admitted bytes");
    let received: Buffer | undefined;
    conversion = async child => {
      const source = child.request!.source;
      received = await readFile(source);
      expect((await stat(source)).mode & 0o777).toBe(0o400);
      await publish(child);
    };
    expect((await pool.convert(installation, "one", input, "docx", new AbortController().signal)).pdf.toString()).toContain("%PDF-");
    await pool.convert(installation, "one", input, "pptx", new AbortController().signal);
    expect(received).toEqual(input);
    expect(input.toString()).toBe("admitted bytes");
    expect(children.filter(child => child.args.some(arg => arg.startsWith("--accept=")))).toHaveLength(1);
    expect(children[1].request).toMatchObject({ operation: "ready" });
    expect(new Set(children.map(child => child.profile)).size).toBe(1);
    expect(installation.verifyBeforeSpawn).toHaveBeenCalledTimes(5);
    expect(installation.assertCurrent).toHaveBeenCalledTimes(8);
    for (const call of vi.mocked(wrapOfflineProcess).mock.calls) {
      expect(call[0].inputDirectory).not.toBe(call[0].outputDirectory);
      expect(call[0].env.HOME).toBe(call[0].outputDirectory);
      expect(call[0].env.SAL_USE_VCLPLUGIN).toBe("svp");
    }
  });

  it("waits for the private API readiness receipt before converting", async () => {
    let resume!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    readiness = async child => { await hold; if (!child.ended) { child.stdout.write(JSON.stringify({ version: 1, ready: true })); child.end(); } };
    const pending = pool.convert(installation, "one", Buffer.from("bytes"), "docx", new AbortController().signal);
    await eventually(() => children.some(child => child.request?.operation === "ready"));
    expect(children.some(child => child.request?.operation === "convert")).toBe(false);
    resume();
    await pending;
    expect(children.filter(child => child.request?.operation === "convert")).toHaveLength(1);
  });

  it("serializes one session while independent sessions keep separate profiles", async () => {
    let resume!: () => void;
    const hold = new Promise<void>(resolve => { resume = resolve; });
    let requests = 0;
    conversion = async child => { if (++requests === 1) await hold; if (!child.ended) await publish(child); };
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
    conversion = async child => { await hold; if (!child.ended) await publish(child); };
    const active = pool.convert(installation, "one", Buffer.from("active"), "docx", new AbortController().signal);
    await eventually(() => children.some(child => child.request?.operation === "convert"));
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
    conversion = async child => { await hold; if (!child.ended) await publish(child); };
    const controller = new AbortController();
    const first = pool.convert(installation, "one", Buffer.from("old"), "docx", controller.signal);
    await eventually(() => children.some(child => child.request?.operation === "convert"));
    const oldProfile = children[0].profile;
    controller.abort(new Error("superseded"));
    await expect(first).rejects.toThrow("superseded");
    resume();
    conversion = publish;
    await pool.convert(installation, "one", Buffer.from("new"), "docx", new AbortController().signal);
    expect(children.filter(child => child.args.some(arg => arg.startsWith("--accept=")))[1].profile).not.toBe(oldProfile);
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

  it("rejects a successful process that omits its promised document output", async () => {
    conversion = async child => { child.stdout.write(JSON.stringify({ version: 1, converted: true })); child.end(); };
    await expect(pool.convert(installation, "one", Buffer.from("bytes"), "docx", new AbortController().signal))
      .rejects.toMatchObject({ code: "engine-failed", message: "Document engine did not produce the expected output." });
    expect(children[0].ended).toBe(true);
    expect(children).toHaveLength(3);
  });

  it("rejects an unavailable importer runtime explicitly and still permits another format", async () => {
    await expect(pool.convert(installation, "one", Buffer.from("hwp"), "hwp", new AbortController().signal))
      .rejects.toMatchObject({ code: "engine-runtime-unavailable" });
    await pool.convert(installation, "one", Buffer.from("docx"), "docx", new AbortController().signal);
    expect(children.filter(child => child.args.some(arg => arg.startsWith("--accept=")))).toHaveLength(2);
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
    expect(result.structured?.length).toBeGreaterThan(0);
    const add = vi.mocked(wrapOfflineProcess).mock.calls.find(call => call[0].args.includes("add"))![0];
    const staged = add.args.at(-1)!;
    expect(staged.startsWith(`${add.inputDirectory}/`)).toBe(true);
    expect(staged).not.toBe(installation.extensionPath);
    expect((await stat(staged)).mode & 0o777).toBe(0o400);
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
    expect(children.filter(child => child.args.some(arg => arg.startsWith("--accept=")))).toHaveLength(2);
  });

  it("refuses empty and over-budget requests without starting a process", async () => {
    await expect(pool.convert(installation, "one", Buffer.alloc(0), "xlsx", new AbortController().signal))
      .rejects.toMatchObject({ code: "corrupt-document" });
    await expect(pool.convert(installation, "one", Buffer.alloc(PREVIEW_DOCUMENT_LIMITS.maxFileBytes + 1), "xlsx", new AbortController().signal))
      .rejects.toMatchObject({ code: "too-large" });
    expect(spawnManaged).not.toHaveBeenCalled();
  });
});
