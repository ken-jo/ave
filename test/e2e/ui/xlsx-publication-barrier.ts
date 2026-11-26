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

export interface FixtureDeadlines {
  readonly shutdownMs: number;
  readonly closeMs: number;
  readonly launchMs: number;
  readonly removeMs: number;
}
export const FIXTURE_DEADLINES: FixtureDeadlines & { readonly startupMs: number; readonly diagnosticMs: number;
  readonly serverMs: number; readonly bodyMs: number } = Object.freeze({ startupMs: 90_000, shutdownMs: 30_000,
  closeMs: 15_000, launchMs: 15_000, removeMs: 10_000, diagnosticMs: 5_000, serverMs: 5_000, bodyMs: 180_000 });
/** The longest settle() takes with a profile and home seeded: close, launch settlement, then each removal. */
export const FIXTURE_CLEANUP_MS = FIXTURE_DEADLINES.shutdownMs + FIXTURE_DEADLINES.closeMs + FIXTURE_DEADLINES.launchMs
  + 3 * FIXTURE_DEADLINES.removeMs;
/** settle(), then the model server's close and the workspace removal. */
export const FIXTURE_TEARDOWN_MS = FIXTURE_CLEANUP_MS + FIXTURE_DEADLINES.serverMs + FIXTURE_DEADLINES.removeMs;

export interface TestBudget {
  readonly bodyMs: number;
  readonly diagnosticMs: number;
  readonly teardownMs: number;
}
/** Body, its diagnostics, then teardown, each under its own deadline. */
export const FIXTURE_TEST_BUDGET: TestBudget = Object.freeze({ bodyMs: FIXTURE_DEADLINES.bodyMs,
  diagnosticMs: 3 * FIXTURE_DEADLINES.diagnosticMs, teardownMs: FIXTURE_TEARDOWN_MS });

/**
 * Runs the body under its own deadline, then diagnostics and teardown under theirs. At the deadline the body's signal
 * aborts, so every step that checks it stops before launch, state, model reply or approval work.
 */
export async function runBoundedTest(steps: { body(signal: AbortSignal): Promise<void>; diagnose(error: unknown): Promise<void>;
  teardown(): Promise<unknown[]> }, budget: TestBudget = FIXTURE_TEST_BUDGET): Promise<void> {
  let bodyFailure: { error: unknown } | undefined;
  const body = new AbortController();
  try { await withinDeadline(Promise.resolve().then(() => steps.body(body.signal)), budget.bodyMs, "Workbook test body"); }
  catch (error) {
    body.abort(error);
    bodyFailure = { error };
    await withinDeadline(Promise.resolve().then(() => steps.diagnose(error)), budget.diagnosticMs, "Workbook diagnostics")
      .catch(() => {});
  }
  let failures: unknown[];
  try { failures = await withinDeadline(Promise.resolve().then(() => steps.teardown()), budget.teardownMs, "Workbook teardown"); }
  catch (error) { failures = [error]; }
  if (failures.length) {
    throw new AggregateError(bodyFailure ? [bodyFailure.error, ...failures] : failures, "Workbook observation cleanup failed");
  }
  if (bodyFailure) throw bodyFailure.error;
}

interface ModelServer {
  readonly listening: boolean;
  closeAllConnections(): void;
  close(callback: (error?: Error) => void): unknown;
}

/** Releases and settles the fixture, closes the model server, and removes the workspace only after a confirmed close. */
export async function teardownWorkbookTest(fixture: { release(): void;
  settle(deadlines: FixtureDeadlines): Promise<{ closed: boolean; failures: unknown[] }> } | undefined,
  server: ModelServer, workspace: string, deadlines: FixtureDeadlines & { readonly serverMs: number } = FIXTURE_DEADLINES): Promise<unknown[]> {
  const failures: unknown[] = [];
  const step = async (action: () => void | Promise<void>) => {
    try { await action(); } catch (error) { failures.push(error); }
  };
  await step(() => fixture?.release());
  const settled = fixture ? await fixture.settle(deadlines) : { closed: true, failures: [] };
  failures.push(...settled.failures);
  await step(() => server.closeAllConnections());
  await step(() => server.listening ? withinDeadline(new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())), deadlines.serverMs, "Workbook model server close") : undefined);
  if (settled.closed) await step(() => rmSync(workspace, { recursive: true, force: true, maxRetries: 5 }));
  return failures;
}

/** The handles a launch supplies: graceful close, and the process it started. */
export interface OwnedApp {
  close(): Promise<void>;
  process(): ChildProcess;
}

/** A close listener the launcher armed when it first held the process, so an earlier close is not missed. */
export interface CloseReceipt {
  closed: Promise<void>;
  isClosed(): boolean;
}

interface OwnedLifetime {
  app: OwnedApp;
  child: ChildProcess;
  closed: Promise<void>;
  isClosed(): boolean;
}

function ownLifetime(app: OwnedApp, receipt?: CloseReceipt): OwnedLifetime {
  const child = app.process();
  if (receipt) return { app, child, closed: receipt.closed, isClosed: receipt.isClosed };
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
  const seededPaths: { path: string; remove: () => void | Promise<void> }[] = [];
  let launch: { settled: Promise<void>; pending: boolean } | undefined;
  let started = false;
  let owned: OwnedLifetime | undefined;
  let phase: "open" | "settling" | "settled" = "open";
  let settleDeadlines: FixtureDeadlines = FIXTURE_DEADLINES;
  let arrivalClose: Promise<unknown[]> | undefined;
  const lateArrivals: Promise<unknown[]>[] = [];
  const retainedPaths = () => [root, ...seededPaths.map((entry) => entry.path), workspace].filter((path) => existsSync(path)).join(", ");
  const reportLate = (message: string, failures: unknown[] = []): void => { console.error(message, ...failures); };
  const fence = (operation: string): void => {
    if (phase !== "open") throw new Error(`The workbook fixture was settled before ${operation}`);
  };
  return {
    root,
    workspace,
    mainEntry: join(root, "dist", "src", "main", "main.js"),
    scriptPath,
    argv(runtime: string, workbookPath: string, requestPath: string): string[] {
      fence("its command was built");
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
      fence("its launch");
      if (launch) throw new Error("The workbook fixture serves exactly one launch");
      const started = Promise.resolve().then(start);
      const state = { pending: true, settled: Promise.resolve() };
      state.settled = started.then(() => { state.pending = false; }, () => { state.pending = false; });
      launch = state;
      return withinDeadline(started, startupMs, "Workbook app startup");
    },
    /** Record each seeded path the moment it exists, with its remover; it goes with the copy. */
    seeded(path: string, remove: () => void | Promise<void> = () => io.remove(path)): void {
      seededPaths.push({ path, remove });
      if (phase === "settled") {
        const failure = new Error(`Workbook app seeded after its fixture was settled; retained paths: ${retainedPaths()}`);
        reportLate(failure.message);
        lateArrivals.push(Promise.resolve([failure]));
      }
    },
    /** A child may exist from now on, so nothing is removed without an owned close. */
    starting(): void {
      started = true;
    },
    /**
     * Register the handles launch supplies, with the launcher's close receipt when it has one. An arrival during settle
     * is closed within that settle's budget; one after it is closed through its handles and its outcome reported.
     */
    own(app: OwnedApp, receipt?: CloseReceipt): void {
      if (phase === "settled") {
        const failure = new Error(`Workbook app arrived after its fixture was settled; retained paths: ${retainedPaths()}`);
        reportLate(failure.message);
        const lifetime = ownLifetime(app, receipt);
        lateArrivals.push(closeOwned(lifetime).then((failures) => {
          reportLate(`Late workbook app close ${lifetime.isClosed() ? "confirmed" : "not confirmed"}; retained paths: ${retainedPaths()}`, failures);
          return [failure, ...failures];
        }));
        throw failure;
      }
      if (owned) throw new Error("The workbook fixture already owns an app");
      owned = ownLifetime(app, receipt);
      if (phase === "settling") arrivalClose = closeOwned(owned, settleDeadlines);
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
      if (phase !== "open") throw new Error("The workbook fixture settles once");
      phase = "settling";
      settleDeadlines = deadlines;
      const end = Date.now() + deadlines.shutdownMs + deadlines.closeMs + deadlines.launchMs;
      const remaining = () => Math.max(0, end - Date.now());
      const failures: unknown[] = [];
      if (owned) failures.push(...await closeOwned(owned, deadlines));
      if (launch?.pending) {
        try { await withinDeadline(launch.settled, Math.min(deadlines.launchMs, remaining()), "Workbook app launch settlement"); }
        catch (error) { failures.push(error); }
      }
      if (arrivalClose) {
        try { failures.push(...await withinDeadline(arrivalClose, remaining(), "Workbook app close after a late arrival")); }
        catch (error) { failures.push(error); }
      }
      phase = "settled";
      const reason = launch?.pending ? "the launch is still in progress"
        : started && !owned ? "a child may exist without an owned app"
          : owned && !owned.isClosed() ? "the owned app did not close" : undefined;
      if (reason) {
        failures.push(new Error(`Workbook fixture paths retained because ${reason}: ${retainedPaths()}`));
        const pending = owned;
        if (pending && !pending.isClosed()) {
          void pending.closed.then(() => reportLate(`Workbook app closed after its fixture settled; retained paths: ${retainedPaths()}`));
        }
        return { closed: false, failures };
      }
      for (const entry of seededPaths) {
        try { await withinDeadline(Promise.resolve().then(entry.remove), deadlines.removeMs, `Removal of ${entry.path}`); }
        catch (error) { failures.push(new Error(`Workbook fixture path left at ${entry.path}`, { cause: error })); }
      }
      try { dispose(); } catch (error) { failures.push(new Error(`Workbook fixture path left at ${root}`, { cause: error })); }
      return { closed: true, failures };
    },
  };
}
