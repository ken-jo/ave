import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

function removeRuntimeMarker(target, key) {
  if (Reflect.deleteProperty(target, key)) return;
  throw new Error(
    `[electron-node-normalization-failed] could not remove process.${String(key)}`,
  );
}

export function normalizeElectronNodeRuntime(target = process) {
  if (target.env?.ELECTRON_RUN_AS_NODE !== "1") return false;
  if (target.versions && typeof target.versions === "object") {
    removeRuntimeMarker(target.versions, "electron");
    removeRuntimeMarker(target.versions, "chrome");
  }
  removeRuntimeMarker(target, "resourcesPath");
  removeRuntimeMarker(target, "helperExecPath");
  return true;
}

const CONSOLE_SPAWNERS = Object.freeze([
  "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync",
]);

/**
 * The same call with `windowsHide: true` unless the caller chose a value.
 * The caller's options object is copied, never mutated, so a test that spies
 * on these functions still sees exactly what the code under test passed.
 */
export function withHiddenConsole(args) {
  const at = args.findIndex((arg, i) =>
    i > 0 && arg !== null && typeof arg === "object" && !Array.isArray(arg));
  if (at >= 0) {
    if (args[at].windowsHide !== undefined) return args;
    const next = [...args];
    next[at] = { ...args[at], windowsHide: true };
    return next;
  }
  // No options: they go before the callback, or last — every one of these
  // signatures accepts an options object in that position.
  const callback = args.findIndex((arg, i) => i > 0 && typeof arg === "function");
  const next = [...args];
  const end = callback >= 0 ? callback : next.length;
  if (end > 1 && next[end - 1] == null) {
    next[end - 1] = { windowsHide: true };
  } else {
    next.splice(end, 0, { windowsHide: true });
  }
  return next;
}

/**
 * Electron's executable is a GUI-subsystem program, so under it a console
 * child (git, tsc, powershell, cmd) that is not spawned with `windowsHide`
 * gets a console window of its own. A full Windows suite spawns thousands of
 * them — a storm of windows that flash open and shut and take the desktop
 * away while the suite runs. Production code passes `windowsHide` itself;
 * tests and fixtures need not, so the default is set here, for the test
 * runtime only, where every Electron-as-Node test process loads this module.
 */
export function hideChildConsoles({
  target = process,
  module = childProcess,
  sync = syncBuiltinESMExports,
} = {}) {
  if (target.platform !== "win32" || target.env?.ELECTRON_RUN_AS_NODE !== "1") return false;
  for (const name of CONSOLE_SPAWNERS) {
    const original = module[name];
    if (typeof original !== "function" || original.aveHidesConsole) continue;
    const wrapped = function (...args) {
      return original.apply(this, withHiddenConsole(args));
    };
    const statics = Object.getOwnPropertyDescriptors(original);
    // exec/execFile's promisified form calls the unwrapped function directly.
    const promisified = original[promisify.custom];
    delete statics[promisify.custom];
    Object.defineProperties(wrapped, statics);
    if (typeof promisified === "function") {
      Object.defineProperty(wrapped, promisify.custom, {
        value: (...args) => promisified(...withHiddenConsole(args)),
      });
    }
    Object.defineProperty(wrapped, "aveHidesConsole", { value: true });
    module[name] = wrapped;
  }
  sync();
  return true;
}

normalizeElectronNodeRuntime();
hideChildConsoles();
