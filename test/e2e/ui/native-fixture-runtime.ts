import type { ElectronApplication } from "playwright";
import type { ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { quitElectron, REPO_ROOT } from "./seeded-electron.js";

interface NativeFixturePaths {
  runtime: string;
  assets: string;
}

const allocations = new WeakMap<ElectronApplication, { paths: NativeFixturePaths; child: ChildProcess }>();

async function removePaths(paths: NativeFixturePaths): Promise<void> {
  await Promise.all(Object.values(paths).map(path => fs.rm(path, { recursive: true, force: true })));
}

async function checkoutOutputDirectory(outputDir: string): Promise<string> {
  const root = await fs.realpath(REPO_ROOT);
  const requested = resolve(root, outputDir);
  let ancestor = requested;
  let canonical: string;
  for (;;) {
    try { canonical = resolve(await fs.realpath(ancestor), relative(ancestor, requested)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(ancestor) === ancestor) throw error;
      ancestor = dirname(ancestor);
    }
  }
  const assertInsideCheckout = (path: string) => {
    const fromRoot = relative(root, path);
    if (isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new Error("Native fixture output must stay inside the checkout");
    }
  };
  assertInsideCheckout(canonical);
  await fs.mkdir(canonical, { recursive: true });
  const actual = await fs.realpath(canonical);
  assertInsideCheckout(actual);
  return actual;
}

export async function launchNativeFixture(
  prefix: string,
  buildAndLaunch: (paths: NativeFixturePaths) => Promise<ElectronApplication>,
  outputDir: string,
): Promise<ElectronApplication> {
  const invocationOutput = await checkoutOutputDirectory(outputDir);
  const runtime = await fs.mkdtemp(join(tmpdir(), prefix));
  let assets: string | undefined;
  let app: ElectronApplication | undefined;
  try {
    assets = await fs.mkdtemp(join(invocationOutput, prefix));
    const paths = { runtime, assets };
    app = await buildAndLaunch(paths);
    allocations.set(app, { paths, child: app.process() });
    return app;
  } catch (error) {
    // A returned process retains its files until confirmed termination.
    if (!app) {
      const paths = assets ? [runtime, assets] : [runtime];
      const cleanup = await Promise.allSettled(paths.map(path => fs.rm(path, { recursive: true, force: true })));
      const failures = cleanup.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError([error, ...failures], "Native fixture acquisition and cleanup failed");
    }
    throw error;
  }
}

export function nativeFixturePaths(app: ElectronApplication): NativeFixturePaths {
  const allocation = allocations.get(app);
  if (!allocation) throw new Error("Native fixture runtime is unavailable");
  return allocation.paths;
}

export async function cleanupNativeFixture(app: ElectronApplication): Promise<void> {
  const allocation = allocations.get(app);
  if (!allocation) throw new Error("Native fixture runtime is unavailable");
  if (allocation.child.exitCode === null && allocation.child.signalCode === null) {
    throw new Error("Native fixture process must exit before runtime cleanup");
  }
  await removePaths(allocation.paths);
  allocations.delete(app);
}

export async function closeNativeFixture(app: ElectronApplication, dispose: () => Promise<unknown>): Promise<void> {
  const allocation = allocations.get(app);
  if (!allocation) throw new Error("Native fixture runtime is unavailable");
  const errors: unknown[] = [];
  if (allocation.child.exitCode === null && allocation.child.signalCode === null) {
    try { await dispose(); }
    catch (error) { errors.push(error); }
  }
  try { await quitElectron(app); }
  catch (error) { errors.push(error); }
  if (allocation.child.exitCode !== null || allocation.child.signalCode !== null) {
    try { await cleanupNativeFixture(app); }
    catch (error) { errors.push(error); }
  } else {
    errors.push(new Error("Native fixture process did not exit; runtime files were preserved"));
  }
  if (errors.length) throw new AggregateError(errors, "Native fixture teardown failed");
}
