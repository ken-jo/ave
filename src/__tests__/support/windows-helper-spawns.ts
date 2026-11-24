import type * as ChildProcess from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const HELPER = "ave-path-kind.exe";
const launches: string[] = [];

/** Pass-through child_process that records each launch of the native path helper by its first argument; launches from worker threads are not seen. */
export function countingChildProcess(actual: typeof ChildProcess): typeof ChildProcess {
  const counted = <F extends (...args: never[]) => unknown>(launch: F): F => {
    const wrapped = ((...args: Parameters<F>) => {
      const [file, argv] = args as unknown as [unknown, unknown];
      if (typeof file === "string" && basename(file).toLowerCase() === HELPER) {
        launches.push(Array.isArray(argv) && typeof argv[0] === "string" ? argv[0] : "");
      }
      return launch(...args);
    }) as F;
    const custom = (launch as { [promisify.custom]?: unknown })[promisify.custom];
    if (typeof custom === "function") Object.assign(wrapped, { [promisify.custom]: counted(custom as (...args: never[]) => unknown) });
    return wrapped;
  };
  const overrides = {
    execFile: counted(actual.execFile),
    execFileSync: counted(actual.execFileSync),
    spawn: counted(actual.spawn),
    spawnSync: counted(actual.spawnSync),
  };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } } as typeof ChildProcess;
}

/** Launches since the last call, grouped by verb (a drive letter for drive queries). */
export function takeWindowsHelperLaunches(): Record<string, number> {
  const byVerb: Record<string, number> = {};
  for (const verb of launches.splice(0)) {
    const key = /^[A-Za-z]:$/u.test(verb) ? "<drive>" : verb;
    byVerb[key] = (byVerb[key] ?? 0) + 1;
  }
  return byVerb;
}
