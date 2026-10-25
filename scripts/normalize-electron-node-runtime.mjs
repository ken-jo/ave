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

// Default console children to hidden without mutating caller options or overriding an explicit choice.
export function withHiddenConsole(args) {
  const at = args.findIndex((arg, i) =>
    i > 0 && arg !== null && typeof arg === "object" && !Array.isArray(arg));
  if (at >= 0) {
    if (args[at].windowsHide !== undefined) return args;
    const next = [...args];
    next[at] = { ...args[at], windowsHide: true };
    return next;
  }
  // Insert options before the callback, after dropping trailing undefined arguments.
  const callback = args.findIndex((arg, i) => i > 0 && typeof arg === "function");
  const next = [...args];
  if (callback < 0) {
    while (next.length > 1 && next[next.length - 1] === undefined) next.pop();
  }
  const end = callback >= 0 ? callback : next.length;
  if (end > 1 && next[end - 1] == null) {
    next[end - 1] = { windowsHide: true };
  } else {
    next.splice(end, 0, { windowsHide: true });
  }
  return next;
}

// Test-runtime children need hidden consoles because the parent executable uses the GUI subsystem.
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
    // Promisified calls bypass the public wrapper and need the same default.
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
