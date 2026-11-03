// Stage the pinned git copy into resources/git-runtime/<platform>-<arch> for the installer to ship.
// The archive must match its pinned size and sha256; every extracted file is recorded so packaging can re-verify the tree.
// postinstall stages the host target; --target selects another (cross-builds cannot run it, so they skip the smoke test).

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Parser } from "tar";
import {
  GIT_RUNTIME_MARKER,
  GIT_RUNTIME_RESOURCE_DIR,
  GIT_RUNTIME_TARGETS,
  GIT_RUNTIME_VERSION,
  gitRuntimeLayout,
  gitRuntimeTargetKey,
} from "./git-runtime-targets.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTRACT_LIMITS = { entries: 5000, bytes: 512 * 1024 * 1024 };
const SMOKE_TIMEOUT_MS = 15_000;
const SMOKE_BLOB = "ave bundled git\n";
/** A symlink may only name a sibling (`git-fetch -> git`), never a path. */
const SIBLING_LINK = /^[A-Za-z0-9._+-]+$/u;
const WINDOWS_INVALID_SEGMENT = /[<>:"|?*]/u;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

function log(message) {
  process.stdout.write(`[fetch-git] ${message}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function gitRuntimeDir(key, projectRoot = PROJECT_ROOT) {
  return path.join(projectRoot, "resources", GIT_RUNTIME_RESOURCE_DIR, key);
}

/** A portable relative path, or a reason it is refused. */
function entryPath(raw) {
  const name = raw.replace(/^\.\//u, "").replace(/\/$/u, "");
  if (name === "" || name === ".") return { skip: true };
  if (/[\u0000-\u001f\u007f\\]/u.test(name)) return { error: "control character or backslash" };
  if (name.startsWith("/") || /^[A-Za-z]:/u.test(name)) return { error: "absolute path" };
  if (name !== name.normalize("NFC")) return { error: "not Unicode NFC" };
  const segments = name.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return { error: "traversal syntax" };
    if (segment.endsWith(".") || segment.endsWith(" ") || WINDOWS_INVALID_SEGMENT.test(segment)) return { error: "Windows-invalid segment" };
    if (WINDOWS_RESERVED_BASENAME.test((segment.split(".", 1)[0] ?? "").replace(/[ .]+$/u, ""))) return { error: "reserved device name" };
  }
  return { segments };
}

/** Extract regular files, directories and sibling symlinks; anything else fails the stage. */
async function extract(archive, dest) {
  await mkdir(dest, { recursive: true });
  const identities = new Set();
  const writes = [];
  let entries = 0;
  let bytes = 0;
  let failure = null;
  const fail = (message) => {
    failure ??= new Error(`fetch-git: archive ${message}`);
  };
  const parser = new Parser({ strict: true });
  parser.on("warn", (code, message) => fail(`${code} ${message}`));
  parser.on("error", (error) => fail(error.message));
  parser.on("entry", (entry) => {
    const reject = (reason) => {
      fail(`${reason}: ${entry.path}`);
      entry.resume();
    };
    if (failure) return entry.resume();
    const parsed = entryPath(entry.path);
    if (parsed.skip) return entry.resume();
    if (parsed.error) return reject(parsed.error);
    const identity = parsed.segments.join("/").toLocaleUpperCase("en-US");
    if (identities.has(identity)) return reject("entry collides with another on a case-insensitive filesystem");
    identities.add(identity);
    if (++entries > EXTRACT_LIMITS.entries) return reject(`more than ${EXTRACT_LIMITS.entries} entries`);
    const target = path.join(dest, ...parsed.segments);
    if (entry.type === "Directory") {
      writes.push(mkdir(target, { recursive: true }));
      return entry.resume();
    }
    if (entry.type === "SymbolicLink") {
      const link = entry.linkpath ?? "";
      if (!SIBLING_LINK.test(link) || link === "." || link === "..") return reject(`symlink to ${JSON.stringify(link)} is not a sibling`);
      writes.push(mkdir(path.dirname(target), { recursive: true }).then(() => symlink(link, target)));
      return entry.resume();
    }
    if (entry.type !== "File") return reject(`unsupported entry type ${entry.type}`);
    bytes += entry.size;
    if (bytes > EXTRACT_LIMITS.bytes) return reject(`more than ${EXTRACT_LIMITS.bytes} bytes`);
    const mode = ((entry.mode ?? 0o644) & 0o755) | 0o600;
    writes.push(mkdir(path.dirname(target), { recursive: true }).then(() => pipeline(entry, createWriteStream(target, { mode, flags: "wx" }))));
  });
  try {
    await pipeline(createReadStream(archive), parser);
  } catch (error) {
    fail(error.message);
  }
  for (const result of await Promise.allSettled(writes)) if (result.status === "rejected") fail(`extract: ${result.reason.message}`);
  if (failure) throw failure;
}

/** Every file, directory and link under `root` with its content hash, in a stable order. */
async function treeEntries(root) {
  const out = [];
  const walk = async (dir, prefix) => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      if (prefix === "" && name === GIT_RUNTIME_MARKER) continue;
      const full = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) out.push(`l ${rel} ${await readlink(full)}`);
      else if (stat.isDirectory()) {
        out.push(`d ${rel}`);
        await walk(full, rel);
      } else if (stat.isFile()) out.push(`f ${rel} ${sha256(await readFile(full))}`);
      else throw new Error(`fetch-git: unexpected file type at ${full}`);
    }
  };
  await walk(root, "");
  return out;
}

export async function gitRuntimeTreeDigest(root) {
  return sha256((await treeEntries(root)).join("\n"));
}

function runCopy(root, platform, args, input) {
  const layout = gitRuntimeLayout(root, platform);
  const sep = platform === "win32" ? ";" : ":";
  const env = {
    ...process.env,
    GIT_EXEC_PATH: layout.execPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  if (layout.pathPrefix.length > 0) env.PATH = [...layout.pathPrefix, process.env.PATH ?? ""].join(sep);
  return new Promise((resolve, reject) => {
    const child = execFile(layout.executable, args, { env, timeout: SMOKE_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)));
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** The copy runs, reports the pinned version, hashes like git, and has its https helper. */
export async function smokeTestGitRuntime(root, platform = process.platform) {
  const layout = gitRuntimeLayout(root, platform);
  if (!existsSync(layout.httpsHelper)) throw new Error(`fetch-git: ${layout.httpsHelper} is missing`);
  const version = (await runCopy(root, platform, ["--version"])).trim();
  if (!new RegExp(`^git version ${GIT_RUNTIME_VERSION.replaceAll(".", "\\.")}(?:\\D|$)`, "u").test(version)) {
    throw new Error(`fetch-git: the copy reports "${version}", expected ${GIT_RUNTIME_VERSION}`);
  }
  const oid = (await runCopy(root, platform, ["hash-object", "--stdin"], SMOKE_BLOB)).trim();
  const expected = createHash("sha1").update(`blob ${Buffer.byteLength(SMOKE_BLOB)}\0${SMOKE_BLOB}`).digest("hex");
  if (oid !== expected) throw new Error(`fetch-git: the copy hashed a blob as ${oid}, expected ${expected}`);
  return version;
}

/** Throws unless `dir` holds exactly the tree its marker recorded from the pinned archive. */
export async function verifyStagedGitRuntime(key, dir = gitRuntimeDir(key)) {
  const asset = GIT_RUNTIME_TARGETS[key];
  if (!asset) throw new Error(`fetch-git: no pinned git for ${key}`);
  let marker;
  try {
    marker = JSON.parse(await readFile(path.join(dir, GIT_RUNTIME_MARKER), "utf8"));
  } catch {
    throw new Error(`fetch-git: ${dir} has no ${GIT_RUNTIME_MARKER}`);
  }
  if (marker.version !== GIT_RUNTIME_VERSION || marker.target !== key || marker.archiveSha256 !== asset.sha256) {
    throw new Error(`fetch-git: ${dir} was staged from a different archive than the pinned ${asset.sha256}`);
  }
  const digest = await gitRuntimeTreeDigest(dir);
  if (digest !== marker.treeSha256) throw new Error(`fetch-git: ${dir} differs from the tree extracted from the pinned archive`);
}

async function archiveBytes(asset, localArchive) {
  if (localArchive) return await readFile(localArchive);
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`fetch-git: ${asset.url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Stage `key` unless a verified copy is already there. A size or sha256 mismatch throws and leaves the old state. */
export async function stageGitRuntime({ key, archive: localArchive, projectRoot = PROJECT_ROOT } = {}) {
  const asset = GIT_RUNTIME_TARGETS[key];
  if (!asset) throw new Error(`fetch-git: no pinned git for ${key}`);
  const dest = gitRuntimeDir(key, projectRoot);
  if (existsSync(dest)) {
    try {
      await verifyStagedGitRuntime(key, dest);
      return { dir: dest, staged: false };
    } catch (error) {
      log(`restaging ${key}: ${error.message}`);
    }
  }
  const bytes = await archiveBytes(asset, localArchive);
  if (bytes.length !== asset.size) throw new Error(`fetch-git: ${key} archive is ${bytes.length} bytes, expected ${asset.size}`);
  const digest = sha256(bytes);
  if (digest !== asset.sha256) throw new Error(`fetch-git: ${key} archive sha256 ${digest} does not match the pinned ${asset.sha256}`);

  const parent = path.dirname(dest);
  const staging = path.join(parent, `.staging-${randomBytes(6).toString("hex")}`);
  try {
    await mkdir(staging, { recursive: true });
    const archivePath = path.join(staging, "git.tar.gz");
    await writeFile(archivePath, bytes);
    const root = path.join(staging, "root");
    await extract(archivePath, root);
    const [platform] = key.split("-");
    if (key === `${process.platform}-${process.arch}`) log(`smoke test: ${await smokeTestGitRuntime(root, platform)}`);
    await writeFile(path.join(root, GIT_RUNTIME_MARKER), `${JSON.stringify({
      schema: 1,
      version: GIT_RUNTIME_VERSION,
      target: key,
      archiveSha256: asset.sha256,
      treeSha256: await gitRuntimeTreeDigest(root),
    }, null, 2)}\n`);
    await rm(dest, { recursive: true, force: true });
    await rename(root, dest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { dir: dest, staged: true };
}

function parseArgs(argv) {
  let key = gitRuntimeTargetKey(process.platform, process.arch);
  let archive;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--current") key = gitRuntimeTargetKey(process.platform, process.arch);
    else if (arg === "--target") key = argv[++i] ?? "";
    else if (arg === "--archive") archive = argv[++i];
    else throw new Error(`fetch-git: unknown argument ${arg}`);
  }
  if (key !== null && !Object.hasOwn(GIT_RUNTIME_TARGETS, key)) {
    throw new Error(`fetch-git: --target must be one of ${Object.keys(GIT_RUNTIME_TARGETS).join(", ")}`);
  }
  return { key, archive };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const { key, archive } = parseArgs(process.argv.slice(2));
  if (key === null) {
    log(`no bundled git for ${process.platform}-${process.arch}; the app uses the system git`);
  } else {
    const { dir, staged } = await stageGitRuntime({ key, archive });
    log(`${staged ? "staged" : "verified"} git ${GIT_RUNTIME_VERSION}: ${path.relative(PROJECT_ROOT, dir)}`);
  }
}
