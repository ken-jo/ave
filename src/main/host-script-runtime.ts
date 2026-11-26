import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { getConfiguredHostResources, type HostResources } from "./host-resources.js";
import { windowsPathKindHelperIn } from "./windows-path-kind-launcher.js";

interface ScriptRuntimePaths { javascriptRuntime: string; bundledScriptsDirectory: string }
interface ScriptRootSnapshot { device: bigint; inode: bigint; manifestDigest: string }
const runtimePaths = new WeakMap<HostResources, ScriptRuntimePaths>();
const rootSnapshots = new WeakMap<ScriptRuntimePaths, ScriptRootSnapshot>();

/** Shipped commands use the host's runtime; no PATH lookup or package installation. */
export function hostScriptRuntimePaths(): ScriptRuntimePaths | undefined {
  const resources = getConfiguredHostResources();
  if (!resources) return undefined;
  const existing = runtimePaths.get(resources);
  if (existing) return existing;
  let directory = resources.isPackaged ? join(resources.resourcePath, "skill-scripts")
    : join(resources.resourcePath, "..", "dist", "skill-scripts");
  try {
    if (!lstatSync(directory).isSymbolicLink()) directory = realpathSync.native(directory);
  } catch { /* Missing outputs remain unverified. */ }
  const paths = Object.freeze({
    javascriptRuntime: process.execPath,
    bundledScriptsDirectory: directory,
  });
  runtimePaths.set(resources, paths);
  try {
    const info = lstatSync(directory, { bigint: true });
    const manifest = join(directory, "manifest.json");
    if (info.isDirectory() && !info.isSymbolicLink() && lstatSync(manifest).size <= 64 * 1024) {
      rootSnapshots.set(paths, { device: info.dev, inode: info.ino,
        manifestDigest: createHash("sha256").update(readFileSync(manifest)).digest("hex") });
    }
  } catch { /* Missing build outputs never acquire execution authority in this host generation. */ }
  return paths;
}

export function hostScriptWriteDenyPaths(): readonly string[] {
  const resources = getConfiguredHostResources();
  const paths = hostScriptRuntimePaths();
  if (!paths || !resources) return [];
  const denied = [paths.bundledScriptsDirectory, paths.javascriptRuntime];
  if (process.platform === "win32") denied.push(windowsPathKindHelperIn(resources.resourcePath));
  for (const path of [...denied]) {
    try { denied.push(realpathSync.native(path)); } catch { /* Missing resources stay denied by name. */ }
  }
  return [...new Set(denied)];
}

function sameFile(left: string, right: string): boolean {
  try { return realpathSync.native(left) === realpathSync.native(right); }
  catch { return false; }
}

/** Only direct, unchanged build outputs are executable resources. Links never qualify. */
export function isVerifiedHostScript(path: string): boolean {
  const paths = hostScriptRuntimePaths();
  if (!paths || !isAbsolute(path)) return false;
  const name = relative(paths.bundledScriptsDirectory, path);
  if (!/^[a-z][a-z0-9-]*\.cjs$/.test(name) || path !== join(paths.bundledScriptsDirectory, name)) return false;
  try {
    const snapshot = rootSnapshots.get(paths);
    const rootInfo = lstatSync(paths.bundledScriptsDirectory, { bigint: true });
    if (!snapshot || rootInfo.isSymbolicLink() || rootInfo.dev !== snapshot.device || rootInfo.ino !== snapshot.inode) return false;
    const root = realpathSync.native(paths.bundledScriptsDirectory);
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4 * 1024 * 1024
      || dirname(realpathSync.native(path)) !== root) return false;
    const manifestPath = join(root, "manifest.json");
    const manifestInfo = lstatSync(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.nlink !== 1 || manifestInfo.size > 64 * 1024) return false;
    const manifestBytes = readFileSync(manifestPath);
    if (createHash("sha256").update(manifestBytes).digest("hex") !== snapshot.manifestDigest) return false;
    const manifest: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
    const record = manifest as Record<string, unknown>;
    if (record.version !== 1 || !record.scripts || typeof record.scripts !== "object" || Array.isArray(record.scripts)) return false;
    const digest = (record.scripts as Record<string, unknown>)[name];
    return typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)
      && createHash("sha256").update(readFileSync(path)).digest("hex") === digest;
  } catch { return false; }
}

/** The verified runtime/script pair receives only its shipped executable dependencies. */
export function hostScriptInvocationReadPaths(
  argv: readonly (string | undefined)[],
  environment: Readonly<Record<string, string | undefined>> = {},
): readonly string[] {
  const paths = hostScriptRuntimePaths();
  const [runtime, script] = argv;
  if (environment.ELECTRON_RUN_AS_NODE !== "1"
    || Object.entries(environment).some(([name, value]) => value !== undefined
      && /^(?:NODE_|LD_|DYLD_)/i.test(name))) return [];
  if (!paths || !runtime || !script || runtime !== paths.javascriptRuntime || !isAbsolute(runtime) || !sameFile(runtime, paths.javascriptRuntime)
    || !isVerifiedHostScript(script)) return [];
  const runtimePath = realpathSync.native(runtime);
  const allowed = [runtime, runtimePath, dirname(runtimePath), script];
  const resources = getConfiguredHostResources();
  if (process.platform === "win32" && resources && basename(script) === "edit-xlsx.cjs") {
    try {
      const helper = windowsPathKindHelperIn(realpathSync.native(resources.resourcePath));
      const info = lstatSync(helper);
      if (info.isFile() && info.nlink === 1 && realpathSync.native(helper) === helper) allowed.push(helper);
    } catch { /* Missing helper grants no read access. */ }
  }
  return [...new Set(allowed)];
}

export function isHostScriptReadPath(path: string): boolean {
  const paths = hostScriptRuntimePaths();
  return paths !== undefined && (sameFile(path, paths.javascriptRuntime) || isVerifiedHostScript(path));
}
