import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "../shared/is-record.js";
import { copyExecutableFile, hashExecutableFile, openExecutableFile } from "./codex-executable-artifact.js";
import { assertCodexExecutableLocation, assertCodexPrivateRuntimeDirectory, assertExecutableDirectory } from "./codex-executable-location.js";

const MAX_PACKAGE_ENTRIES = 20_000;
const MAX_PACKAGES = 512;
const PACKAGE_NAME_PATTERN = /^(?:@[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

interface PackageGraph {
  readonly roots: readonly string[];
  readonly identity: string;
  readonly files: ReadonlyMap<string, string>;
}

export interface SubscriptionPackageArtifact {
  readonly args: readonly string[];
  readonly identity: string;
  readonly verify: () => Promise<void>;
}

async function fileHash(path: string): Promise<string> {
  await assertCodexExecutableLocation(path);
  const file = await openExecutableFile(path);
  try { return await hashExecutableFile(file); } finally { await file.close(); }
}

async function packageMetadata(root: string): Promise<Record<string, unknown>> {
  const path = join(root, "package.json");
  await assertCodexExecutableLocation(path);
  const file = await openExecutableFile(path);
  try {
    const parsed: unknown = JSON.parse(await file.readFile("utf8"));
    if (!isRecord(parsed)) throw new Error("Invalid subscription package metadata");
    return parsed;
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

async function resolvePackageDependency(root: string, name: string, optional: boolean): Promise<string | null> {
  for (let directory = root;; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", ...name.split("/"));
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid subscription dependency directory");
      await assertExecutableDirectory(candidate);
      return await fs.realpath(candidate);
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
    if (dirname(directory) === directory) break;
  }
  if (optional) return null;
  throw new Error("Subscription package dependency is unavailable");
}

async function packageFiles(root: string, visit: (path: string, isDirectory: boolean) => Promise<void>, declaredPackage = false): Promise<void> {
  let count = 0;
  const walk = async (directory: string): Promise<void> => {
    await assertExecutableDirectory(directory);
    await visit(directory, true);
    for (const name of (await fs.readdir(directory)).sort()) {
      // Dependency roots are admitted from package metadata, not directory presence.
      if (declaredPackage && name === "node_modules") continue;
      if (++count > MAX_PACKAGE_ENTRIES) throw new Error("Subscription package is too large");
      const path = join(directory, name);
      const entry = await fs.lstat(path);
      if (entry.isSymbolicLink()) throw new Error("Subscription package contains a symbolic link");
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) await visit(path, false);
      else throw new Error("Invalid subscription package entry");
    }
  };
  await walk(root);
}

async function packageGraph(root: string): Promise<PackageGraph> {
  const roots = new Set<string>();
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const collect = async (directory: string): Promise<void> => {
    if (roots.has(directory)) return;
    if (roots.size >= MAX_PACKAGES) throw new Error("Subscription dependency graph is too large");
    roots.add(directory);
    const metadata = await packageMetadata(directory);
    await packageFiles(directory, async (path, isDirectory) => {
      if (isDirectory) directories.add(path);
      else if (!files.has(path)) files.set(path, await fileHash(path));
      if (files.size + directories.size > MAX_PACKAGE_ENTRIES) throw new Error("Subscription package is too large");
    }, true);
    for (const [name, optional] of packageDependencies(metadata)) {
      const dependency = await resolvePackageDependency(directory, name, optional);
      if (dependency) await collect(dependency);
    }
  };
  await collect(root);
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
  if (!url.startsWith("file:")) throw new Error("subscription-module-outside-artifact");
  const path = realpathSync(fileURLToPath(url));
  if (!files.has(path)) throw new Error("subscription-module-outside-artifact");
  return path;
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    verifyMetadata();
    const result = nextResolve(specifier, context);
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
  const graph = await packageGraph(root);
  const canonicalDirectory = await fs.realpath(directory);
  await assertCodexPrivateRuntimeDirectory(canonicalDirectory);
  const sourceAncestor = commonPackageAncestor(graph.roots);
  const snapshot = join(canonicalDirectory, "package");
  const files = new Map<string, string>();
  const directories = new Set<string>();
  const destination = (source: string) => join(snapshot, basename(sourceAncestor), relative(sourceAncestor, source));
  for (const packageRoot of graph.roots) {
    await packageFiles(packageRoot, async (path, isDirectory) => {
      const target = destination(path);
      if (isDirectory) {
        await fs.mkdir(target, { recursive: true, mode: 0o700 });
        directories.add(target);
      } else if (!files.has(target)) {
        const file = await copyExecutableFile(path, target);
        if (file.contentHash !== graph.files.get(path)) throw new Error("Subscription executable changed");
        files.set(file.executable, file.contentHash);
      }
    }, true);
  }
  const guard = join(canonicalDirectory, "module-guard.mjs");
  const guardSource = moduleGuardSource(files);
  const output = await fs.open(guard, "wx", 0o500);
  try { await output.writeFile(guardSource); await output.sync(); } finally { await output.close(); }
  const guardHash = createHash("sha256").update(guardSource).digest("hex");
  const verifySealedFile = async (path: string, expectedHash: string): Promise<void> => {
    await assertCodexExecutableLocation(path);
    const input = await openExecutableFile(path);
    try {
      const stat = await input.stat();
      if (stat.nlink !== 1 || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o500)
        || await hashExecutableFile(input) !== expectedHash) throw new Error("Subscription package artifact changed");
    } finally { await input.close(); }
  };
  const verify = async (): Promise<void> => {
    if ((await packageGraph(root)).identity !== graph.identity) throw new Error("Subscription executable changed");
    const expected = new Map(files);
    const observedDirectories = new Set<string>();
    await packageFiles(snapshot, async (path, isDirectory) => {
      if (isDirectory) observedDirectories.add(path);
      else {
        const hash = expected.get(path);
        if (!hash) throw new Error("Subscription package artifact changed");
        await verifySealedFile(path, hash);
        expected.delete(path);
      }
    });
    for (const path of observedDirectories) await assertCodexPrivateRuntimeDirectory(path);
    for (const path of directories) if (!observedDirectories.has(path)) throw new Error("Subscription package artifact changed");
    if (expected.size) throw new Error("Subscription package artifact changed");
    await verifySealedFile(guard, guardHash);
  };
  // Source changes during copying are rejected before the first CLI probe.
  await verify();
  return Object.freeze({ args: Object.freeze(["--no-global-search-paths", "--import", pathToFileURL(guard).href, destination(script)]),
    identity: graph.identity, verify });
}
