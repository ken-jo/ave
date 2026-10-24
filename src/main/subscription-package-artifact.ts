import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../shared/is-record.js";
import { copyAdmittedExecutableFile, hashExecutableFile, openExecutableFile } from "./codex-executable-artifact.js";
import { assertCodexLocations, claimPrivateOwnership, type CodexLocationRequest } from "./codex-executable-location.js";

const MAX_PACKAGE_ENTRIES = 20_000;
const MAX_PACKAGES = 512;
const PACKAGE_NAME_PATTERN = /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

interface PackageGraph {
  readonly roots: readonly string[];
  readonly identity: string;
  readonly files: ReadonlyMap<string, string>;
}

interface PackageEntry {
  readonly path: string;
  readonly isDirectory: boolean;
}

export interface SubscriptionPackageArtifact {
  readonly args: readonly string[];
  readonly identity: string;
  readonly verify: () => Promise<void>;
}

function locationRequests(entries: Iterable<PackageEntry>, directoryKind: CodexLocationRequest["kind"]): CodexLocationRequest[] {
  return [...entries].map(({ path, isDirectory }) => ({ path, kind: isDirectory ? directoryKind : "executable", routeKind: "guarded-script" }));
}

async function fileHash(path: string): Promise<string> {
  const file = await openExecutableFile(path);
  try { return await hashExecutableFile(file); } finally { await file.close(); }
}

async function packageMetadata(root: string): Promise<{ metadata: Record<string, unknown>; hash: string }> {
  const file = await openExecutableFile(join(root, "package.json"));
  try {
    const bytes = await file.readFile();
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed)) throw new Error("Invalid subscription package metadata");
    return { metadata: parsed, hash: createHash("sha256").update(bytes).digest("hex") };
  } finally { await file.close(); }
}

function packageDependencies(metadata: Record<string, unknown>): Map<string, boolean> {
  const dependencies = new Map<string, boolean>();
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    const values = metadata[field];
    if (values === undefined) continue;
    if (!isRecord(values)) throw new Error("Invalid subscription package dependencies");
    for (const [name, version] of Object.entries(values)) {
      if (!PACKAGE_NAME_PATTERN.test(name) || name.split("/").some((part) => part === "." || part === "..")
        || typeof version !== "string") throw new Error("Invalid subscription package dependency");
      const peerMeta = isRecord(metadata.peerDependenciesMeta) ? metadata.peerDependenciesMeta[name] : null;
      dependencies.set(name, field === "optionalDependencies"
        || (field === "peerDependencies" && isRecord(peerMeta) && peerMeta.optional === true));
    }
  }
  return dependencies;
}

async function resolvePackageDependency(
  root: string,
  name: string,
  optional: boolean,
  requests: CodexLocationRequest[],
): Promise<string | null> {
  for (let directory = root;; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", ...name.split("/"));
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid subscription dependency directory");
      const resolved = await fs.realpath(candidate);
      requests.push({ path: candidate, kind: "directory", routeKind: "guarded-script" });
      return resolved;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (dirname(directory) === directory) break;
  }
  if (optional) return null;
  throw new Error("Subscription package dependency is unavailable");
}

// Only lists the tree; callers admit every listed path in one batch before
// opening any file in it.
async function packageFiles(root: string, declaredPackage = false): Promise<PackageEntry[]> {
  const entries: PackageEntry[] = [];
  let count = 0;
  const walk = async (directory: string): Promise<void> => {
    entries.push({ path: directory, isDirectory: true });
    for (const name of (await fs.readdir(directory)).sort()) {
      // Dependency roots are admitted from package metadata, not directory presence.
      if (declaredPackage && name === "node_modules") continue;
      if (++count > MAX_PACKAGE_ENTRIES) throw new Error("Subscription package is too large");
      const path = join(directory, name);
      const entry = await fs.lstat(path);
      if (entry.isSymbolicLink()) throw new Error("Subscription package contains a symbolic link");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) entries.push({ path, isDirectory: false });
      else throw new Error("Invalid subscription package entry");
    }
  };
  await walk(root);
  return entries;
}

/** Callers may add locations of their own to the graph's single admission batch. */
async function packageGraph(root: string, extra: readonly CodexLocationRequest[] = []): Promise<PackageGraph> {
  const roots = new Set<string>();
  const entries = new Map<string, PackageEntry>();
  const metadataHashes = new Map<string, string>();
  const dependencyRequests: CodexLocationRequest[] = [];
  const collect = async (directory: string): Promise<void> => {
    if (roots.has(directory)) return;
    if (roots.size >= MAX_PACKAGES) throw new Error("Subscription dependency graph is too large");
    roots.add(directory);
    const { metadata, hash } = await packageMetadata(directory);
    metadataHashes.set(join(directory, "package.json"), hash);
    for (const entry of await packageFiles(directory, true)) {
      if (!entries.has(entry.path)) entries.set(entry.path, entry);
      if (entries.size > MAX_PACKAGE_ENTRIES) throw new Error("Subscription package is too large");
    }
    for (const [name, optional] of packageDependencies(metadata)) {
      const dependency = await resolvePackageDependency(directory, name, optional, dependencyRequests);
      if (dependency) await collect(dependency);
    }
  };
  await collect(root);
  // Metadata names the dependencies before admission, so the admitted bytes
  // must be the ones that were read; no other file is opened before admission.
  await assertCodexLocations([...extra, ...dependencyRequests, ...locationRequests(entries.values(), "directory")]);
  const files = new Map<string, string>();
  const directories = new Set<string>();
  for (const { path, isDirectory } of entries.values()) {
    if (isDirectory) directories.add(path);
    else files.set(path, await fileHash(path));
  }
  for (const [path, hash] of metadataHashes) {
    if (files.get(path) !== hash) throw new Error("Subscription executable changed");
  }
  const identity = createHash("sha256").update(JSON.stringify({
    roots: [...roots].sort(), directories: [...directories].sort(), files: [...files].sort(([a], [b]) => a.localeCompare(b)),
  })).digest("hex");
  return { roots: [...roots].sort(), identity, files };
}

function commonPackageAncestor(roots: readonly string[]): string {
  let ancestor = roots[0]!;
  for (const root of roots) {
    while (relative(ancestor, root).startsWith(`..${sep}`) || relative(ancestor, root) === ".." || isAbsolute(relative(ancestor, root))) {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("Subscription packages must share a filesystem root");
      ancestor = parent;
    }
  }
  return ancestor;
}

function commonJsGuardSource(root: string): string {
  return `const Module = require("node:module");
const { relative, isAbsolute } = require("node:path");
const { realpathSync } = require("node:fs");
const root = ${JSON.stringify(root)};
function inside(path) {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(".." + require("node:path").sep) && !isAbsolute(part);
}
function missing() {
  return Object.assign(new Error("subscription-module-outside-artifact"), { code: "MODULE_NOT_FOUND" });
}
const nodeModulePaths = Module._nodeModulePaths;
Module._nodeModulePaths = function(path) { return nodeModulePaths.call(this, path).filter(inside); };
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function(specifier, parent, ...rest) {
  if (Module.isBuiltin(specifier)) return resolveFilename.call(this, specifier, parent, ...rest);
  const bare = !isAbsolute(specifier) && !specifier.startsWith(".");
  if (bare && parent) parent.paths = (parent.paths || []).filter(inside);
  const result = resolveFilename.call(this, specifier, parent, ...rest);
  if (!inside(realpathSync(result))) throw missing();
  return result;
};
`;
}

// Loaded before the package entry. Every import/require is resolved inside the
// sealed snapshot and code is read from a no-follow handle with its own digest.
function moduleGuardSource(files: ReadonlyMap<string, string>): string {
  return `import { registerHooks, isBuiltin } from "node:module";
import { createHash } from "node:crypto";
import { constants, openSync, closeSync, readFileSync, fstatSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
const files = new Map(${JSON.stringify([...files])});
const metadataPaths = [...files.keys()].filter((path) => /[/\\\\]package\\.json$/.test(path));
function verifiedBytes(path) {
  const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("subscription-module-invalid-artifact");
    const bytes = readFileSync(fd);
    if (createHash("sha256").update(bytes).digest("hex") !== files.get(path)) throw new Error("subscription-module-changed");
    return bytes;
  } finally { closeSync(fd); }
}
function verifyMetadata() {
  for (const path of metadataPaths) verifiedBytes(path);
}
function checkedPath(url) {
  if (!url.startsWith("file:")) throw Object.assign(new Error("subscription-module-outside-artifact"), { code: "MODULE_NOT_FOUND" });
  const path = realpathSync(fileURLToPath(url));
  if (!files.has(path)) throw Object.assign(new Error("subscription-module-outside-artifact"), { code: "MODULE_NOT_FOUND" });
  return path;
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    verifyMetadata();
    let result;
    try { result = nextResolve(specifier, context); }
    catch (error) { if (error.code === "ERR_MODULE_NOT_FOUND") error.code = "MODULE_NOT_FOUND"; throw error; }
    verifyMetadata();
    if (!isBuiltin(result.url)) checkedPath(result.url);
    return result;
  },
  load(url, context, nextLoad) {
    if (isBuiltin(url)) return nextLoad(url, context);
    const path = checkedPath(url);
    const bytes = verifiedBytes(path);
    verifyMetadata();
    const result = nextLoad(url, context);
    verifyMetadata();
    return ["module", "commonjs", "json"].includes(result.format) ? { ...result, source: bytes } : result;
  },
});
`;
}

/** Bind loading to the declared transitive graph, without per-package import isolation. */
export async function copySubscriptionPackageArtifact(root: string, script: string, directory: string): Promise<SubscriptionPackageArtifact> {
  const canonicalDirectory = await fs.realpath(directory);
  const graph = await packageGraph(root, [{ path: canonicalDirectory, kind: "private-directory", routeKind: "guarded-script" }]);
  const sourceAncestor = commonPackageAncestor(graph.roots);
  const snapshot = join(canonicalDirectory, "package");
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const destination = (source: string) => join(snapshot, basename(sourceAncestor), relative(sourceAncestor, source));
  const sources: PackageEntry[] = [];
  for (const packageRoot of graph.roots) sources.push(...await packageFiles(packageRoot, true));
  await assertCodexLocations(locationRequests(sources, "directory"));
  for (const { path, isDirectory } of sources) {
    const target = destination(path);
    if (isDirectory) {
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      directories.add(target);
    } else if (!files.has(target)) {
      const file = await copyAdmittedExecutableFile(path, target);
      if (file.contentHash !== graph.files.get(path)) throw new Error("Subscription executable changed");
      files.set(file.executable, file.contentHash);
    }
  }
  const guard = join(canonicalDirectory, "module-guard.mjs");
  const guardSource = moduleGuardSource(files);
  const output = await fs.open(guard, "wx", 0o500);
  try { await output.writeFile(guardSource); await output.sync(); } finally { await output.close(); }
  const guardHash = createHash("sha256").update(guardSource).digest("hex");
  const commonJsGuard = join(canonicalDirectory, "module-guard.cjs");
  const commonJsSource = commonJsGuardSource(snapshot);
  const commonJsOutput = await fs.open(commonJsGuard, "wx", 0o500);
  try { await commonJsOutput.writeFile(commonJsSource); await commonJsOutput.sync(); } finally { await commonJsOutput.close(); }
  const commonJsHash = createHash("sha256").update(commonJsSource).digest("hex");
  // Called only for paths admitted in the verify batch.
  const verifySealedFile = async (path: string, expectedHash: string): Promise<void> => {
    const input = await openExecutableFile(path);
    try {
      const stat = await input.stat();
      if (stat.nlink !== 1 || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o500)
        || await hashExecutableFile(input) !== expectedHash) throw new Error("Subscription package artifact changed");
    } finally { await input.close(); }
  };
  const verify = async (): Promise<void> => {
    // The source graph, every sealed path and the guard share one admission batch.
    const sealed = await packageFiles(snapshot);
    const requests = [...locationRequests(sealed, "private-directory"),
      { path: canonicalDirectory, kind: "private-directory", routeKind: "guarded-script" } as const,
      { path: guard, kind: "executable", routeKind: "guarded-script" } as const,
      { path: commonJsGuard, kind: "executable", routeKind: "guarded-script" } as const];
    if ((await packageGraph(root, requests)).identity !== graph.identity) throw new Error("Subscription executable changed");
    const expected = new Map(files);
    const observedDirectories = new Set<string>();
    for (const { path, isDirectory } of sealed) {
      if (isDirectory) observedDirectories.add(path);
      else {
        const hash = expected.get(path);
        if (!hash) throw new Error("Subscription package artifact changed");
        await verifySealedFile(path, hash);
        expected.delete(path);
      }
    }
    for (const path of directories) if (!observedDirectories.has(path)) throw new Error("Subscription package artifact changed");
    if (expected.size) throw new Error("Subscription package artifact changed");
    await verifySealedFile(guard, guardHash);
    await verifySealedFile(commonJsGuard, commonJsHash);
  };
  // Everything copied above is the product's own: claim it before admission.
  await claimPrivateOwnership([...(await packageFiles(snapshot)).map(({ path }) => path), guard, commonJsGuard]);
  // Source changes during copying are rejected before the first CLI probe.
  await verify();
  return Object.freeze({ args: Object.freeze(["--no-global-search-paths", "--import", pathToFileURL(guard).href,
    "--require", commonJsGuard, destination(script)]),
    identity: graph.identity, verify });
}
