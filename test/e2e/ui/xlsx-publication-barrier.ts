import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PUBLICATION_BARRIER_PRELUDE = String.raw`"use strict";
(() => {
  const fileSystem = require("node:fs");
  if (process.argv.length === 4) return;
  const [readyPath, releasePath] = process.argv.splice(4, 2);
  if (!readyPath || !releasePath || process.argv.length !== 4) throw new Error("Expected workbook publication markers");
  const nativeWrite = fileSystem.writeSync;
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  let pending = true;
  fileSystem.writeSync = function(descriptor, bytes, ...args) {
    if (pending && Buffer.isBuffer(bytes) && bytes.length >= 4 && (args[0] ?? 0) === 0
        && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      pending = false;
      fileSystem.writeFileSync(readyPath, "ready\n", { flag: "wx", mode: 0o600 });
      while (!fileSystem.existsSync(releasePath)) Atomics.wait(waiter, 0, 0, 10);
      fileSystem.writeSync = nativeWrite;
    }
    return Reflect.apply(nativeWrite, fileSystem, [descriptor, bytes, ...args]);
  };
})();
`;

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface FixtureBuildIo {
  canonical(path: string): string;
  copy(source: string, target: string): void;
  write(path: string, bytes: Uint8Array): void;
  remove(path: string): void;
}

export const fileSystemIo: FixtureBuildIo = {
  canonical: (path) => realpathSync.native(path),
  copy: (source, target) => cpSync(source, target, { recursive: true, errorOnExist: true, force: false }),
  write: (path, bytes) => writeFileSync(path, bytes, { flag: "wx" }),
  remove: (path) => rmSync(path, { recursive: true, force: true, maxRetries: 5 }),
};

export interface FixtureDeadlines { readonly shutdownMs: number; readonly closeMs: number; readonly launchMs: number }
export const FIXTURE_DEADLINES: FixtureDeadlines & { readonly startupMs: number; readonly diagnosticMs: number } =
  Object.freeze({ startupMs: 90_000, shutdownMs: 30_000, closeMs: 15_000, launchMs: 15_000, diagnosticMs: 5_000 });
/** The longest settle() can take, to reserve beyond a test body's own budget. */
export const FIXTURE_CLEANUP_MS = FIXTURE_DEADLINES.shutdownMs + FIXTURE_DEADLINES.closeMs + FIXTURE_DEADLINES.launchMs;

/** The handles a launch supplies: graceful close, and the process it started. */
export interface OwnedApp {
  close(): Promise<void>;
  process(): ChildProcess;
}

interface OwnedLifetime {
  app: OwnedApp;
  child: ChildProcess;
  closed: Promise<void>;
  isClosed(): boolean;
}

function ownLifetime(app: OwnedApp): OwnedLifetime {
  const child = app.process();
  let closed = false;
  const closing = new Promise<void>((resolve) => child.once("close", () => { closed = true; resolve(); }));
  return { app, child, closed: closing, isClosed: () => closed };
}

// Only the owned handles act: graceful close, then the child handle's kill. Each step is best effort and bounded.
async function closeOwned(owned: OwnedLifetime, deadlines: FixtureDeadlines = FIXTURE_DEADLINES): Promise<unknown[]> {
  const failures: unknown[] = [];
  if (owned.isClosed()) return failures;
  try { await withinDeadline(Promise.resolve().then(() => owned.app.close()), deadlines.shutdownMs, "Workbook app close"); }
  catch (error) { failures.push(error); }
  if (!owned.isClosed() && owned.child.exitCode === null && owned.child.signalCode === null) {
    try { owned.child.kill(); } catch (error) { failures.push(error); }
  }
  if (!owned.isClosed()) {
    try { await withinDeadline(owned.closed, deadlines.closeMs, "Workbook app pipe closure"); }
    catch (error) { failures.push(error); }
  }
  return failures;
}

/** Best-effort diagnostics: the fallback on failure or once the deadline passes, so cleanup always starts. */
export function boundedDiagnostic<T>(work: () => Promise<T>, fallback: T, ms = FIXTURE_DEADLINES.diagnosticMs): Promise<T> {
  return withinDeadline(Promise.resolve().then(work), ms, "Workbook diagnostic").catch(() => fallback);
}

/** Rejects once `ms` pass; a late settlement of `work` is then ignored. */
export function withinDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  work.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
  });
  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

/** The PowerShell or POSIX command the model sends for this argv. */
export function renderWorkbookCommand(platform: NodeJS.Platform, argv: readonly string[]): string {
  return platform === "win32"
    ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${argv.map((value) => `'${value.replaceAll("'", "''")}'`).join(" ")}`
    : `ELECTRON_RUN_AS_NODE=1 ${argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ")}`;
}

/**
 * Copy the checkout's build into a disposable root that only one application instance runs, then install the
 * publication prelude there. The checkout's build is only read. Leftover roots stay in the checkout's ignored cache.
 */
export function prepareWorkbookPublicationBuild(checkout: string, workspace: string, io: FixtureBuildIo = fileSystemIo) {
  const sharedScripts = join(checkout, "dist", "skill-scripts");
  const manifest = JSON.parse(readFileSync(join(sharedScripts, "manifest.json"), "utf8")) as { version: number; scripts: Record<string, string> };
  const name = "edit-xlsx.cjs";
  const producer = readFileSync(join(sharedScripts, name));
  if (manifest.version !== 1 || manifest.scripts[name] !== digest(producer)) {
    throw new Error("Workbook producer does not match its resource manifest");
  }
  // The host verifier's script name shape: a direct basename, so no copy can leave the disposable root.
  const invalid = Object.keys(manifest.scripts).find((entry) => !/^[a-z][a-z0-9-]*\.cjs$/.test(entry));
  if (invalid !== undefined) throw new Error(`Resource manifest names a script outside its directory: ${JSON.stringify(invalid)}`);
  const script = Buffer.concat([Buffer.from(PUBLICATION_BARRIER_PRELUDE), producer]);
  const preparedManifest = Buffer.from(`${JSON.stringify({ ...manifest,
    scripts: { ...manifest.scripts, [name]: digest(script) } }, null, 2)}\n`);
  const outputs = join(checkout, ".cache");
  mkdirSync(outputs, { recursive: true });
  let root = mkdtempSync(join(outputs, "xlsx-publication-build-"));
  const scriptsDirectory = () => join(root, "dist", "skill-scripts");
  try {
    root = io.canonical(root);
    io.copy(join(checkout, "dist", "src"), join(root, "dist", "src"));
    io.copy(join(checkout, "resources"), join(root, "resources"));
    if (existsSync(join(checkout, "build"))) io.copy(join(checkout, "build"), join(root, "build"));
    mkdirSync(scriptsDirectory());
    for (const entry of Object.keys(manifest.scripts)) {
      if (entry !== name) io.copy(join(sharedScripts, entry), join(scriptsDirectory(), entry));
    }
    io.write(join(scriptsDirectory(), name), script);
    io.write(join(scriptsDirectory(), "manifest.json"), preparedManifest);
  } catch (error) {
    try { io.remove(root); } catch { /* A leftover root is never consumed by another instance. */ }
    throw error;
  }
  const scriptPath = join(scriptsDirectory(), name);
  const readyPath = join(workspace, "publication-ready");
  const releasePath = join(workspace, "publication-release");
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    io.remove(root);
    disposed = true;
  };
  const seededSets: { paths: readonly string[]; remove: () => void | Promise<void> }[] = [];
  let launch: { settled: Promise<void>; pending: boolean } | undefined;
  let owned: OwnedLifetime | undefined;
  let settling = false;
  const lateArrivals: Promise<unknown[]>[] = [];
  const retainedPaths = () => [root, ...seededSets.flatMap((set) => set.paths), workspace].join(", ");
  const reportLate = (failure: Error): void => { console.error(failure.message); };
  return {
    root,
    workspace,
    mainEntry: join(root, "dist", "src", "main", "main.js"),
    scriptPath,
    argv(runtime: string, workbookPath: string, requestPath: string): string[] {
      return [runtime, scriptPath, workbookPath, requestPath, readyPath, releasePath];
    },
    readyPath,
    releasePath,
    release(): void {
      try { writeFileSync(releasePath, "release\n", { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(releasePath, "utf8") !== "release\n") throw error;
      }
    },
    /** Call only after the owned application and its command process have closed. */
    dispose,
    /** Start the one launch this copy serves; settle() keeps every path while it is still in progress. */
    launch<T>(start: () => Promise<T>, startupMs = FIXTURE_DEADLINES.startupMs): Promise<T> {
      if (settling || launch) throw new Error("The workbook fixture serves exactly one launch before settle");
      const started = Promise.resolve().then(start);
      const state = { pending: true, settled: Promise.resolve() };
      state.settled = started.then(() => { state.pending = false; }, () => { state.pending = false; });
      launch = state;
      return withinDeadline(started, startupMs, "Workbook app startup");
    },
    /** Record the seeded profile and home as soon as they exist, with their remover; they go with the copy. */
    seeded(paths: readonly string[], remove: () => void | Promise<void> = () => { for (const path of paths) io.remove(path); }): void {
      seededSets.push({ paths, remove });
      if (settling) {
        const failure = new Error(`Workbook app seeded after its fixture was settled: ${paths.join(", ")}`);
        reportLate(failure);
        lateArrivals.push(Promise.resolve([failure]));
      }
    },
    /** Register the handles launch supplies. An arrival after settle is closed through them and reported. */
    own(app: OwnedApp): void {
      if (settling) {
        const failure = new Error(`Workbook app arrived after its fixture was settled; paths: ${retainedPaths()}`);
        reportLate(failure);
        lateArrivals.push(Promise.resolve().then(async () => [failure, ...await closeOwned(ownLifetime(app))]));
        throw failure;
      }
      if (owned) throw new Error("The workbook fixture already owns an app");
      owned = ownLifetime(app);
    },
    /** Reports from arrivals after settle, each bounded by the close deadlines. */
    async late(): Promise<unknown[]> {
      return (await Promise.all(lateArrivals)).flat();
    },
    /**
     * Close the owned app through its handles within deadlines. The copy, profile and home are removed only after the
     * launch settled and the owned process closed (exit and pipe closure); otherwise every retained path is reported.
     */
    async settle(deadlines: FixtureDeadlines = FIXTURE_DEADLINES): Promise<{ closed: boolean; failures: unknown[] }> {
      settling = true;
      const failures: unknown[] = [];
      if (owned) failures.push(...await closeOwned(owned, deadlines));
      if (launch?.pending) {
        try { await withinDeadline(launch.settled, deadlines.launchMs, "Workbook app launch settlement"); }
        catch (error) { failures.push(error); }
      }
      const reason = launch?.pending ? "the launch is still in progress"
        : launch && !owned ? "the launch supplied no owned app"
          : owned && !owned.isClosed() ? "the owned app did not close" : undefined;
      if (reason) {
        failures.push(new Error(`Workbook fixture paths retained because ${reason}: ${retainedPaths()}`));
        return { closed: false, failures };
      }
      for (const set of seededSets) {
        try { await set.remove(); }
        catch (error) { failures.push(new Error(`Workbook fixture path left at ${set.paths.join(", ")}`, { cause: error })); }
      }
      try { dispose(); } catch (error) { failures.push(new Error(`Workbook fixture path left at ${root}`, { cause: error })); }
      return { closed: true, failures };
    },
  };
}
