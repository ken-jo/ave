import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { VerifiedDocumentEngineInstallation } from "../main/document-engine-installation.js";
import { createPrivateTempDirectory, assertCodexLocations } from "../main/codex-executable-location.js";
import { forceKillManagedChildProcess, spawnManaged } from "../main/managed-child-processes.js";
import { wrapOfflineProcess, type OfflineProcessWrap } from "../permissions/offline-process-sandbox.js";
import { buildSandboxedChildEnv } from "../tools/safe-env.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../shared/preview-document.js";
import { readPreviewDocumentInput } from "../tools/preview-document-input.js";
import { TableDocumentError } from "../tools/table-document-error.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { sleep } from "../shared/abortable-deadline.js";
import { DOCUMENT_ENGINE_IMPORTER } from "../shared/document-engine-importer.js";

type ConversionFormat = "docx" | "odt" | "pptx" | "xlsx" | "ods" | "hwp" | "hwpx";
export interface ConvertedObservationDocument { pdf: Buffer; recalculated?: Buffer; structured?: Buffer }

const ENGINE_PROCESS_LIMITS = Object.freeze({
  sessions: 16, queuedJobs: 4, queuedBytes: 40 * 1024 * 1024,
  temporaryBytes: 256 * 1024 * 1024, temporaryEntries: 4096,
  diagnosticBytes: 64 * 1024, pollMs: 100, treePollMs: 250, forwardReceiptMs: 2_000,
});

interface ExportTarget { extension: "pdf" | "odt" | "xlsx" | "ods"; filter: string }

/** Host-selected export per admitted format; the request never carries a caller-chosen filter. */
const EXPORTS: Readonly<Record<ConversionFormat, readonly ExportTarget[]>> = Object.freeze({
  docx: [{ extension: "pdf", filter: "writer_pdf_Export" }],
  odt: [{ extension: "pdf", filter: "writer_pdf_Export" }],
  pptx: [{ extension: "pdf", filter: "impress_pdf_Export" }],
  xlsx: [{ extension: "xlsx", filter: "Calc MS Excel 2007 XML" }],
  ods: [{ extension: "ods", filter: "calc8" }],
  hwp: [{ extension: "pdf", filter: "writer_pdf_Export" }, { extension: "odt", filter: "writer8" }],
  hwpx: [{ extension: "pdf", filter: "writer_pdf_Export" }, { extension: "odt", filter: "writer8" }],
});

/** Host-authored readiness document: proves the forwarded conversion path before any admitted bytes are staged. */
const READINESS_PROBE = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text"><office:body><office:text><text:p>Ave</text:p></office:text></office:body></office:document>
`;

/** Keeps the resident's frame list non-empty so a completed forwarded conversion does not terminate it. */
const RESIDENT_FRAME_HOLDER = "private:factory/swriter";

const PROFILE_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting">
<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
<prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>
<prop oor:name="SecureURL" oor:op="fuse"><value/></prop>
</item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update">
<prop oor:name="Link" oor:op="fuse"><value>1</value></prop>
</item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update">
<prop oor:name="Link" oor:op="fuse"><value>2</value></prop>
</item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load">
<prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop>
<prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop>
</item>
<item oor:path="/org.openoffice.Office.Common/Misc">
<prop oor:name="FirstRun" oor:op="fuse"><value>false</value></prop>
</item>
</oor:items>
`;

interface RunningProcess {
  child: ChildProcess;
  completion: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
  ended: boolean;
  /** Diagnostic text since the last job boundary; the resident's window restarts for each forwarded job. */
  output: string;
  diagnosticBytes: number;
  failure?: Error;
  release(): void;
  drain?: Promise<void>;
}

interface SessionRuntime {
  directory: string;
  input: string;
  output: string;
  profile: string;
  ipc: string;
  env: NodeJS.ProcessEnv;
  runtimeDirectories: string[];
  resident?: RunningProcess;
  children: Set<RunningProcess>;
  importerReady: boolean;
  javaHome?: string;
}

interface EngineSession {
  id: string;
  installation: VerifiedDocumentEngineInstallation;
  controller: AbortController;
  tail: Promise<void>;
  queuedJobs: number;
  queuedBytes: number;
  runtime?: SessionRuntime;
  failure?: Error;
  closing?: Promise<void>;
}

function failure(message: string): TableDocumentError { return new TableDocumentError("engine-failed", message); }
function aborted(signal: AbortSignal): void { signal.throwIfAborted(); }

function childEnvironment(output: string): NodeJS.ProcessEnv {
  return {
    ...buildSandboxedChildEnv({}), PATH: "/usr/bin:/bin", HOME: output,
    TMPDIR: output, TMP: output, TEMP: output, PWD: output, XDG_CACHE_HOME: join(output, "cache"),
    XDG_CONFIG_HOME: join(output, "config"), XDG_DATA_HOME: join(output, "data"),
    SAL_USE_VCLPLUGIN: "svp", SAL_DISABLE_OPENCL: "1", LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8",
  };
}

/** One private profile and writer queue per host session; conversion never receives a source path. */
export class LibreOfficeSessionPool {
  private readonly sessions = new Map<string, EngineSession>();
  private disposed = false;

  async convert(installation: VerifiedDocumentEngineInstallation, sessionId: string, bytes: Buffer,
    format: ConversionFormat, signal: AbortSignal): Promise<ConvertedObservationDocument> {
    aborted(signal);
    if (!["docx", "odt", "pptx", "xlsx", "ods", "hwp", "hwpx"].includes(format)) {
      throw new Error("Invalid document engine request.");
    }
    if (bytes.length === 0) throw new TableDocumentError("corrupt-document", "Document engine input is empty.");
    if (bytes.length > PREVIEW_DOCUMENT_LIMITS.maxFileBytes) {
      throw new TableDocumentError("too-large", "Document engine input exceeds its byte limit.");
    }
    return this.enqueue(installation, sessionId, bytes,
      (session, runtime, accepted, activeSignal) => this.convertOne(session, runtime, accepted, format, activeSignal), signal);
  }

  async prepare(installation: VerifiedDocumentEngineInstallation, sessionId: string, format: ConversionFormat, signal: AbortSignal): Promise<void> {
    if (!["docx", "odt", "pptx", "xlsx", "ods", "hwp", "hwpx"].includes(format)) throw new Error("Invalid document engine preparation.");
    return this.enqueue(installation, sessionId, Buffer.alloc(0), async (session, runtime, _accepted, activeSignal) => {
      if (format === "hwp" || format === "hwpx") await this.ensureImporter(session, runtime, activeSignal);
    }, signal);
  }

  private async enqueue<T>(installation: VerifiedDocumentEngineInstallation, sessionId: string, bytes: Buffer,
    operation: (session: EngineSession, runtime: SessionRuntime, accepted: Buffer, signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    aborted(signal);
    if (this.disposed) throw new Error("Document engine pool is disposed.");
    if (!sessionId || sessionId.length > 256) throw new Error("Invalid document engine session.");
    let session = this.sessions.get(sessionId);
    if (!session) {
      if (this.sessions.size >= ENGINE_PROCESS_LIMITS.sessions) throw new TableDocumentError("busy", "Document engine session limit exceeded.");
      session = { id: sessionId, installation, controller: new AbortController(), tail: Promise.resolve(), queuedJobs: 0, queuedBytes: 0 };
      this.sessions.set(sessionId, session);
    }
    if (session.installation.root !== installation.root || session.installation.version !== installation.version) {
      throw new Error("Document engine installation changed during a session.");
    }
    if (session.failure) throw session.failure;
    if (session.closing) throw failure("Document engine session is closing.");
    if (session.queuedJobs >= ENGINE_PROCESS_LIMITS.queuedJobs || session.queuedBytes + bytes.length > ENGINE_PROCESS_LIMITS.queuedBytes) {
      throw new TableDocumentError("busy", "Document engine queue limit exceeded.");
    }
    const accepted = Buffer.from(bytes);
    session.queuedJobs += 1;
    session.queuedBytes += accepted.length;
    const owner = session;
    let started = false;
    let reservationReleased = false;
    let queuedFailure: Error | undefined;
    const releaseReservation = (): void => {
      if (reservationReleased) return;
      reservationReleased = true;
      accepted.fill(0);
      owner.queuedJobs -= 1;
      owner.queuedBytes -= accepted.length;
    };
    let rejectQueued!: (error: Error) => void;
    const queueInterrupted = new Promise<never>((_resolve, reject) => { rejectQueued = reject; });
    const cancelQueued = (error: Error): void => {
      if (started || queuedFailure) return;
      queuedFailure = error;
      releaseReservation();
      rejectQueued(error);
    };
    const onQueuedAbort = (): void => cancelQueued(signal.reason instanceof Error ? signal.reason : failure("Document engine queued request was cancelled."));
    signal.addEventListener("abort", onQueuedAbort, { once: true });
    const queueTimer = setTimeout(() => cancelQueued(new TableDocumentError("parse-limit", "Document engine queue wait timed out.")),
      TOOL_TIMEOUT_POLICY.documentEngineConversionMs);
    const run = owner.tail.then(async () => {
      started = true;
      clearTimeout(queueTimer);
      signal.removeEventListener("abort", onQueuedAbort);
      if (queuedFailure) throw queuedFailure;
      aborted(signal);
      aborted(owner.controller.signal);
      if (owner.failure) throw owner.failure;
      const controller = new AbortController();
      const onCallerAbort = (): void => controller.abort(signal.reason);
      const onSessionAbort = (): void => controller.abort(owner.controller.signal.reason);
      signal.addEventListener("abort", onCallerAbort, { once: true });
      owner.controller.signal.addEventListener("abort", onSessionAbort, { once: true });
      const timer = setTimeout(() => controller.abort(new TableDocumentError("parse-limit", "Document engine conversion timed out.")),
        TOOL_TIMEOUT_POLICY.documentEngineConversionMs);
      if (signal.aborted) onCallerAbort();
      if (owner.controller.signal.aborted) onSessionAbort();
      try {
        owner.runtime ??= await this.createRuntime(owner, controller.signal);
        return await operation(owner, owner.runtime, accepted, controller.signal);
      } catch (error) {
        const cause = error instanceof Error ? error : failure("Document engine conversion failed.");
        const recoverable = !owner.failure && (signal.aborted
          || (cause instanceof TableDocumentError && cause.code === "engine-runtime-unavailable"));
        if (!recoverable && !owner.controller.signal.aborted) {
          owner.failure ??= cause;
          owner.controller.abort(cause);
        }
        await this.stopRuntime(owner.runtime);
        if (recoverable && owner.runtime) {
          await rm(owner.runtime.directory, { recursive: true, force: true });
          owner.runtime = undefined;
        }
        throw cause;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onCallerAbort);
        owner.controller.signal.removeEventListener("abort", onSessionAbort);
      }
    }).finally(() => {
      clearTimeout(queueTimer);
      signal.removeEventListener("abort", onQueuedAbort);
      releaseReservation();
    });
    owner.tail = run.then(() => {}, () => {});
    if (signal.aborted) onQueuedAbort();
    return Promise.race([run, queueInterrupted]);
  }

  async releaseSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closing ??= (async () => {
      session.controller.abort(failure("Document engine session was released."));
      await this.stopRuntime(session.runtime);
      await session.tail;
      await this.stopRuntime(session.runtime);
      if (session.runtime) await rm(session.runtime.directory, { recursive: true, force: true });
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId);
    })();
    return session.closing;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.sessions.keys()].map(id => this.releaseSession(id)));
  }

  private async createRuntime(session: EngineSession, signal: AbortSignal): Promise<SessionRuntime> {
    await session.installation.verifyBeforeSpawn(signal);
    const runtimeDirectory = await realpath(session.installation.root);
    signal.throwIfAborted();
    const directory = await createPrivateTempDirectory(process.platform === "darwin" ? "/private/tmp/avd-" : "/tmp/avd-");
    const output = join(directory, "output");
    const input = join(directory, "input");
    const profile = join(output, "profile");
    const ipc = join(output, "ipc");
    const runtime: SessionRuntime = {
      directory, input, output, profile, ipc, env: { ...childEnvironment(output), OSL_SOCKET_PATH: ipc },
      runtimeDirectories: [runtimeDirectory], children: new Set(), importerReady: false,
    };
    // Publish ownership before any child starts, so cancellation can always drain it.
    session.runtime = runtime;
    try {
      await mkdir(input, { mode: 0o700 });
      await mkdir(join(profile, "user"), { recursive: true, mode: 0o700 });
      await mkdir(ipc, { mode: 0o700 });
      await writeFile(join(profile, "user", "registrymodifications.xcu"), PROFILE_SETTINGS, { flag: "wx", mode: 0o600 });
      aborted(signal);
      await this.startResident(session, runtime, signal);
      return runtime;
    } catch (error) {
      await this.stopRuntime(runtime);
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private baseArguments(runtime: SessionRuntime): string[] {
    return [`-env:UserInstallation=${pathToFileURL(runtime.profile).href}`, `-env:OSL_SOCKET_PATH=${runtime.ipc}`,
      "--headless", "--norestore", "--nodefault", "--nofirststartwizard", "--nologo"];
  }

  /**
   * The resident owns the session profile and its private single-instance pipe. It opens no UNO acceptor:
   * conversion clients forward fixed command lines through that pipe, and the resident performs the work.
   */
  private async startResident(session: EngineSession, runtime: SessionRuntime, signal: AbortSignal): Promise<void> {
    const resident = await this.spawn(session, runtime, session.installation.executable,
      [...this.baseArguments(runtime), RESIDENT_FRAME_HOLDER], signal);
    runtime.resident = resident;
    await this.awaitInstancePipe(runtime, resident, signal);
    await this.probeReadiness(session, runtime, signal);
    if (resident.ended) throw resident.failure ?? failure("Document engine exited before it was ready.");
  }

  /** A client started before the pipe exists would become a second office on this profile instead of forwarding. */
  private async awaitInstancePipe(runtime: SessionRuntime, resident: RunningProcess, signal: AbortSignal): Promise<void> {
    const expires = Date.now() + TOOL_TIMEOUT_POLICY.documentEngineStartupMs;
    for (;;) {
      aborted(signal);
      if (resident.ended) throw resident.failure ?? failure("Document engine exited before its private pipe was ready.");
      for (const name of await readdir(runtime.ipc)) {
        if (!name.startsWith("OSL_PIPE_")) continue;
        const entry = await lstat(join(runtime.ipc, name));
        if (entry.isSocket()) return;
      }
      if (Date.now() >= expires) throw new TableDocumentError("parse-limit", "Document engine startup timed out.");
      await sleep(ENGINE_PROCESS_LIMITS.pollMs, signal);
    }
  }

  private async probeReadiness(session: EngineSession, runtime: SessionRuntime, signal: AbortSignal): Promise<void> {
    const id = randomUUID();
    const source = join(runtime.input, `${id}.fodt`);
    const output = join(runtime.output, id);
    await mkdir(output, { mode: 0o700 });
    try {
      await writeFile(source, READINESS_PROBE, { flag: "wx", mode: 0o400 });
      const pdf = await this.dispatch(session, runtime, source, output, { extension: "pdf", filter: "writer_pdf_Export" }, undefined, signal);
      if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw failure("Document engine readiness probe did not produce a PDF document.");
    } finally {
      await rm(source, { force: true });
      await rm(output, { recursive: true, force: true });
    }
  }

  /**
   * Forward one fixed conversion to the resident and return its output. The forwarding client exits 0 even when
   * the resident's conversion failed, so success requires the resident's own receipt line and the expected file.
   */
  private async dispatch(session: EngineSession, runtime: SessionRuntime, source: string, outputDirectory: string,
    target: ExportTarget, inputFilter: string | undefined, signal: AbortSignal): Promise<Buffer> {
    const resident = runtime.resident;
    if (!resident || resident.ended) throw failure("Document engine resident is unavailable.");
    resident.output = "";
    resident.diagnosticBytes = 0;
    const stem = basename(source).replace(/\.[^.]+$/u, "");
    const destination = join(outputDirectory, `${stem}.${target.extension}`);
    const client = await this.run(session, runtime, session.installation.executable, [...this.baseArguments(runtime),
      ...(inputFilter ? [`--infilter=${inputFilter}`] : []),
      "--convert-to", `${target.extension}:${target.filter}`, "--outdir", outputDirectory, source], signal);
    const receipt = (text: string): boolean => text.split("\n").some(line => line.startsWith(`convert ${source}`)
      && line.endsWith(` -> ${destination} using filter : ${target.filter}`));
    if (receipt(client.output)) throw failure("Document engine conversion bypassed the session instance.");
    const expires = Date.now() + ENGINE_PROCESS_LIMITS.forwardReceiptMs;
    while (!receipt(resident.output)) {
      if (resident.ended) throw resident.failure ?? failure("Document engine resident exited during a conversion.");
      if (Date.now() >= expires) {
        const missing = failure("Document engine session instance did not acknowledge the conversion.");
        Object.defineProperty(missing, "cause", { value: { resident: resident.output, client: client.output } });
        throw missing;
      }
      await sleep(ENGINE_PROCESS_LIMITS.pollMs, signal);
    }
    if (/^Error:/mu.test(resident.output)) {
      const rejected = failure("Document engine rejected the conversion.");
      Object.defineProperty(rejected, "cause", { value: { resident: resident.output } });
      throw rejected;
    }
    return this.readConvertedOutput(destination, signal);
  }

  private async spawn(session: EngineSession, runtime: SessionRuntime, command: string,
    args: readonly string[], signal: AbortSignal): Promise<RunningProcess> {
    aborted(signal);
    await session.installation.verifyBeforeSpawn(signal);
    session.installation.assertCurrent();
    let wrapped: OfflineProcessWrap | undefined;
    try {
      wrapped = await wrapOfflineProcess({ command, args, inputDirectory: runtime.input, outputDirectory: runtime.output,
        ipcDirectory: runtime.ipc, runtimeDirectories: runtime.runtimeDirectories, env: runtime.env, signal });
      aborted(signal);
      session.installation.assertCurrent();
      const wrap = wrapped;
      const child = spawnManaged(wrap.argv[0], wrap.argv.slice(1), {
        env: wrap.env, cwd: runtime.output, stdio: ["ignore", "pipe", "pipe"], detached: true, shell: false,
      }, { label: "document-engine", killProcessGroup: true });
      let resolveCompletion!: (result: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => void;
      const process: RunningProcess = { child, ended: false, output: "", diagnosticBytes: 0, release: wrap.release,
        completion: new Promise(resolve => { resolveCompletion = resolve; }) };
      runtime.children.add(process);
      const collect = (chunk: Buffer): void => {
        process.diagnosticBytes += chunk.length;
        if (process.diagnosticBytes > ENGINE_PROCESS_LIMITS.diagnosticBytes) {
          process.failure = failure("Document engine diagnostic output exceeds its limit.");
          void forceKillManagedChildProcess(child, "document engine diagnostic limit");
          return;
        }
        process.output += chunk.toString("utf8");
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.once("error", error => { process.failure = failure("Document engine process failed to start.");
        if (child.pid === undefined) { process.ended = true; wrap.release(); runtime.children.delete(process); resolveCompletion({ code: null, signal: null, error }); } });
      child.once("close", (code, childSignal) => {
        process.ended = true;
        resolveCompletion({ code, signal: childSignal });
        if (runtime.resident === process && !session.controller.signal.aborted) {
          session.failure ??= process.failure ?? failure(`Document engine resident process exited unexpectedly (code=${String(code)}, signal=${String(childSignal)}).`);
          session.controller.abort(session.failure);
        }
      });
      return process;
    } catch (error) { wrapped?.release(); throw error; }
  }

  private async run(session: EngineSession, runtime: SessionRuntime, command: string,
    args: readonly string[], signal: AbortSignal): Promise<RunningProcess> {
    const process = await this.spawn(session, runtime, command, args, signal);
    const onAbort = (): void => { void forceKillManagedChildProcess(process.child, "document engine request cancelled"); };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      const result = await process.completion;
      aborted(signal);
      if (process.failure) throw process.failure;
      if (result.error || result.code !== 0 || result.signal !== null) {
        const failed = failure(`Document engine conversion process failed (code=${String(result.code)}, signal=${String(result.signal)}).`);
        Object.defineProperty(failed, "cause", { value: { exitCode: result.code, terminationSignal: result.signal,
          diagnostic: process.output, ...(result.error ? { error: result.error } : {}) } });
        throw failed;
      }
      return process;
    } finally { signal.removeEventListener("abort", onAbort); await this.finishProcess(runtime, process); }
  }

  private async convertOne(session: EngineSession, runtime: SessionRuntime, bytes: Buffer,
    format: ConversionFormat, signal: AbortSignal): Promise<ConvertedObservationDocument> {
    if (!runtime.resident || runtime.resident.ended) throw failure("Document engine resident is unavailable.");
    if (format === "hwp" || format === "hwpx") await this.ensureImporter(session, runtime, signal);
    const id = randomUUID();
    const source = join(runtime.input, `${id}.${format}`);
    const output = join(runtime.output, id);
    await mkdir(output, { mode: 0o700 });
    const handle = await open(source, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    let monitoring = true;
    let monitorFailure: Error | undefined;
    const monitor = (async (): Promise<void> => {
      while (monitoring && !signal.aborted) {
        await this.assertTemporaryBudget(runtime.output);
        await sleep(ENGINE_PROCESS_LIMITS.treePollMs, signal);
      }
    })().catch(error => {
      if (!signal.aborted && monitoring) {
        monitorFailure = error instanceof Error ? error : failure("Document engine temporary output failed validation.");
        session.failure = monitorFailure;
        session.controller.abort(monitorFailure);
      }
    });
    try {
      // Spreadsheet caches are recomputed on load by the profile's always-recalculate policy, then exported.
      const inputFilter = format === "hwp" || format === "hwpx" ? DOCUMENT_ENGINE_IMPORTER.filter : undefined;
      const outputs: Buffer[] = [];
      for (const target of EXPORTS[format]) {
        outputs.push(await this.dispatch(session, runtime, source, output, target, inputFilter, signal));
      }
      let result: ConvertedObservationDocument;
      if (format === "xlsx" || format === "ods") {
        result = { pdf: Buffer.alloc(0), recalculated: outputs[0] };
      } else {
        const pdf = outputs[0]!;
        if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw failure("Document engine did not produce a PDF document.");
        result = { pdf };
        if (format === "hwp" || format === "hwpx") result.structured = outputs[1];
      }
      if (monitorFailure) throw monitorFailure;
      await this.assertTemporaryBudget(runtime.output);
      if (!bytes.equals(await readPreviewDocumentInput(source, signal))) throw failure("Document engine altered its read-only input.");
      aborted(signal);
      return result;
    } finally {
      monitoring = false;
      await monitor;
      await rm(source, { force: true });
      await rm(output, { recursive: true, force: true });
    }
  }

  private async readConvertedOutput(path: string, signal: AbortSignal): Promise<Buffer> {
    return readPreviewDocumentInput(path, signal).catch((cause: unknown) => {
      signal.throwIfAborted();
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      const missing = failure("Document engine did not produce the expected output.");
      Object.defineProperty(missing, "cause", { value: cause });
      throw missing;
    });
  }

  private async ensureImporter(session: EngineSession, runtime: SessionRuntime, signal: AbortSignal): Promise<void> {
    if (runtime.importerReady) return;
    const javaHome = await this.findJavaHome(signal);
    runtime.javaHome = javaHome;
    runtime.runtimeDirectories.push(javaHome);
    runtime.env = { ...runtime.env, JAVA_HOME: javaHome, JRE_HOME: javaHome,
      UNO_JAVA_JFW_JREHOME: pathToFileURL(javaHome).href };
    // A profile's extension registry is never changed while its resident is using it.
    await this.stopRuntime(runtime);
    const java = await this.run(session, runtime, join(javaHome, "bin", "java"), ["-version"], signal).catch((error: unknown) => {
      signal.throwIfAborted();
      if (!(error instanceof TableDocumentError) || error.code !== "engine-failed") throw error;
      const unavailable = new TableDocumentError("engine-runtime-unavailable", "The isolated Java runtime could not start.");
      Object.defineProperty(unavailable, "cause", { value: error });
      throw unavailable;
    });
    const version = /(?:openjdk|java)\s+(?:version\s+)?"?(\d+)/u.exec(java.output)?.[1];
    if (!version || Number(version) < 11) {
      throw new TableDocumentError("engine-runtime-unavailable", "The isolated Java runtime does not satisfy the required version.");
    }
    const extension = await readPreviewDocumentInput(session.installation.extensionPath, signal, 1024 * 1024);
    if (createHash("sha256").update(extension).digest("hex") !== session.installation.extensionSha256) {
      throw new TableDocumentError("engine-integrity-failed", "Document importer integrity verification failed.");
    }
    const importer = join(runtime.input, "importer.oxt");
    await writeFile(importer, extension, { flag: "wx", mode: 0o400 });
    await this.run(session, runtime, session.installation.unopkg,
      [`-env:UserInstallation=${pathToFileURL(runtime.profile).href}`, `-env:OSL_SOCKET_PATH=${runtime.ipc}`,
        "add", "--force", importer], signal);
    const registered = await this.run(session, runtime, session.installation.unopkg,
      [`-env:UserInstallation=${pathToFileURL(runtime.profile).href}`, `-env:OSL_SOCKET_PATH=${runtime.ipc}`, "list"], signal);
    if (!registered.output.includes("H2Orestart")) throw new TableDocumentError("engine-runtime-unavailable", "Document importer did not register in the private profile.");
    await this.startResident(session, runtime, signal);
    runtime.importerReady = true;
  }

  private async findJavaHome(signal: AbortSignal): Promise<string> {
    const candidates: string[] = [];
    const roots = process.platform === "darwin" ? ["/Library/Java/JavaVirtualMachines"] : ["/usr/lib/jvm", "/usr/java"];
    for (const root of roots) {
      let entries;
      try { entries = await readdir(root, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (entries.length > 32) throw new TableDocumentError("engine-runtime-unavailable", "System Java discovery exceeds its limit.");
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        candidates.push(join(root, entry.name, ...(process.platform === "darwin" ? ["Contents", "Home"] : [])));
      }
    }
    const rejected: unknown[] = [];
    for (const candidate of candidates) {
      aborted(signal);
      const home = await realpath(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!home) continue;
      const release = await lstat(join(home, "release")).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!release) continue;
      if (!release.isFile() || release.isSymbolicLink() || release.size > 16_384) continue;
      const metadata = await readFile(join(home, "release"), "utf8");
      const major = /^JAVA_VERSION="(?:1\.)?(\d+)/mu.exec(metadata)?.[1];
      if (!major || Number(major) < 11) continue;
      // Discovery picks the first admitted runtime in sorted order; a user-writable link is never trusted by location.
      try {
        await assertCodexLocations([{ path: home, kind: "directory", routeKind: "native" },
          { path: join(home, "bin", "java"), kind: "executable", routeKind: "native" }]);
      } catch (cause) {
        rejected.push(cause);
        continue;
      }
      return home;
    }
    if (rejected.length > 0) {
      const unavailable = new TableDocumentError("engine-runtime-unavailable", "The system Java runtime did not pass executable admission.");
      Object.defineProperty(unavailable, "cause", { value: new AggregateError(rejected) });
      throw unavailable;
    }
    throw new TableDocumentError("engine-runtime-unavailable", "A trusted system Java runtime version 11 or newer is required for this document format.");
  }

  private async assertTemporaryBudget(root: string): Promise<void> {
    let bytes = 0;
    let entries = 0;
    const directories = [root];
    while (directories.length) {
      const directory = directories.pop()!;
      for (const name of await readdir(directory)) {
        if (++entries > ENGINE_PROCESS_LIMITS.temporaryEntries) throw failure("Document engine temporary entry limit exceeded.");
        const path = join(directory, name);
        const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!entry) continue;
        if (!entry.isSymbolicLink() && !entry.isFile() && !entry.isDirectory() && !entry.isSocket()) {
          throw failure(`Document engine produced an unsupported temporary entry: ${path.slice(root.length + 1, root.length + 257)}.`);
        }
        // Cache links consume an entry and bytes but are never traversed; deliverables still use no-follow reads.
        if (entry.isDirectory()) directories.push(path);
        else bytes += entry.size;
        if (bytes > ENGINE_PROCESS_LIMITS.temporaryBytes) throw new TableDocumentError("parse-limit", "Document engine temporary byte limit exceeded.");
      }
    }
  }

  private async stopRuntime(runtime: SessionRuntime | undefined): Promise<void> {
    if (!runtime) return;
    const processes = [...runtime.children];
    runtime.resident = undefined;
    await Promise.all(processes.map(async process => {
      if (!process.ended) await forceKillManagedChildProcess(process.child, "document engine cleanup");
      await this.finishProcess(runtime, process);
    }));
  }

  private finishProcess(runtime: SessionRuntime, running: RunningProcess): Promise<void> {
    running.drain ??= (async () => {
      await running.completion;
      const expires = Date.now() + TOOL_TIMEOUT_POLICY.documentEngineShutdownMs;
      const pid = running.child.pid;
      if (pid !== undefined) for (;;) {
        let gone = false;
        try { process.kill(-pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          gone = true;
        }
        if (gone) break;
        if (Date.now() >= expires) throw failure("Document engine process group did not terminate.");
        await sleep(ENGINE_PROCESS_LIMITS.pollMs);
      }
      running.release();
      runtime.children.delete(running);
    })();
    return running.drain;
  }
}
