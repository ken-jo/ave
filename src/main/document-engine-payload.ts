import { lstatSync, promises as fs, readlinkSync, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { createPrivateDirectory, createPrivateTempDirectory } from "./codex-executable-location.js";
import { hashExecutableFile, openExecutableFile } from "./codex-executable-artifact.js";
import { runDocumentEngineSystemCommand } from "./document-engine-system-command.js";
import type { DocumentEngineRelease } from "./document-engine-release-pins.js";
import { win32SystemBinary } from "../shared/windows-system-path.js";
import { renameDirectory } from "../lib/transient-fs-lock-retry.js";

const PAYLOAD_LIMITS = Object.freeze({ entries: 30_000, bytes: 2_500_000_000, depth: 32 });

export interface DocumentEngineTreeEntry {
  readonly path: string;
  readonly kind: "directory" | "file" | "link";
  readonly size: number;
  readonly sha256?: string;
  readonly target?: string;
  readonly executable?: boolean;
}

export interface DocumentEnginePayloadPaths { readonly root: string; readonly executable: string; readonly unopkg: string }

export interface DocumentEnginePathIdentity {
  readonly path: string;
  readonly stat: BigIntStats;
  readonly target?: string;
  readonly ancestor?: true;
  /**
   * A downloaded release archive: ctime is excluded because extended-attribute writers outside Ave (disk image
   * checksum caches, provenance, indexing) change it without changing bytes. Content equality is proven instead by
   * {@link assertDocumentEngineArchiveUnchanged}, which rehashes the held file whenever ctime moved.
   */
  readonly archive?: true;
}

function sameArchiveIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mode === after.mode && before.nlink === after.nlink && before.mtimeNs === after.mtimeNs;
}

function samePathIdentity(before: BigIntStats, after: BigIntStats): boolean {
  return sameArchiveIdentity(before, after) && before.ctimeNs === after.ctimeNs;
}

export function captureDocumentEnginePathIdentity(path: string, kind?: "archive"): DocumentEnginePathIdentity {
  const stat = lstatSync(path, { bigint: true });
  return Object.freeze({ path, stat, ...(stat.isSymbolicLink() ? { target: readlinkSync(path) } : {}),
    ...(kind === "archive" ? { archive: true as const } : {}) });
}

/**
 * After an external tool consumed a verified archive by path, prove the held file still carries the pinned bytes.
 * Inode, size, mode, link count and mtime must be unchanged; a ctime-only change (an xattr write) is admitted only
 * when the held descriptor still hashes to the pin.
 */
export async function assertDocumentEngineArchiveUnchanged(held: FileHandle, identity: DocumentEnginePathIdentity,
  sha256: string): Promise<void> {
  if (!identity.archive) throw new Error("Document engine archive identity was not captured as an archive");
  assertDocumentEnginePathIdentities([identity]);
  const current = await held.stat({ bigint: true });
  if (!sameArchiveIdentity(identity.stat, current)) throw new Error("Document engine archive identity changed after verification");
  if (current.ctimeNs !== identity.stat.ctimeNs && await hashExecutableFile(held) !== sha256) {
    throw new Error("Document engine archive bytes changed after verification");
  }
}

/** Revalidate identities captured while content hashes were checked, immediately before spawn. */
export function assertDocumentEnginePathIdentities(identities: readonly DocumentEnginePathIdentity[]): void {
  for (const identity of identities) {
    const current = lstatSync(identity.path, { bigint: true });
    const matches = identity.ancestor ? identity.stat.dev === current.dev && identity.stat.ino === current.ino
      && identity.stat.mode === current.mode && current.isDirectory() && !current.isSymbolicLink()
      : identity.archive ? sameArchiveIdentity(identity.stat, current) : samePathIdentity(identity.stat, current);
    if (!matches || identity.target !== undefined && readlinkSync(identity.path) !== identity.target) {
      throw new Error("Document engine payload identity changed after verification");
    }
  }
}

export async function readDocumentEngineTree(root: string, signal: AbortSignal,
  onIdentity?: (identity: DocumentEnginePathIdentity) => void): Promise<readonly DocumentEngineTreeEntry[]> {
  const entries: DocumentEngineTreeEntry[] = [];
  let total = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > PAYLOAD_LIMITS.depth || entries.length >= PAYLOAD_LIMITS.entries) throw new Error("Document engine payload entry limit exceeded");
    const stat = await fs.lstat(path, { bigint: true });
    let target: string | undefined;
    const name = relative(root, path).replace(/\\/g, "/");
    if (stat.isSymbolicLink()) {
      target = await fs.readlink(path);
      const resolved = resolve(dirname(path), target);
      const within = relative(root, resolved);
      if (isAbsolute(target) || within === ".." || within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(within)) {
        throw new Error("Document engine payload link leaves its root");
      }
      entries.push({ path: name, kind: "link", size: 0, target });
    } else if (stat.isDirectory()) {
      entries.push({ path: name, kind: "directory", size: 0 });
      for (const child of (await fs.readdir(path)).sort()) await visit(join(path, child), depth + 1);
    } else if (stat.isFile()) {
      if (stat.nlink !== 1n) throw new Error("Document engine payload contains a hard link");
      total += Number(stat.size);
      if (total > PAYLOAD_LIMITS.bytes) throw new Error("Document engine payload byte limit exceeded");
      const handle = await openExecutableFile(path);
      try {
        entries.push({ path: name, kind: "file", size: Number(stat.size), sha256: await hashExecutableFile(handle),
          ...(process.platform !== "win32" ? { executable: (Number(stat.mode) & 0o111) !== 0 } : {}) });
      } finally { await handle.close(); }
    } else throw new Error("Document engine payload contains an unsupported entry");
    if (!samePathIdentity(stat, await fs.lstat(path, { bigint: true }))) throw new Error("Document engine payload changed during verification");
    onIdentity?.(Object.freeze({ path, stat, ...(target !== undefined ? { target } : {}) }));
  };
  await visit(root, 0);
  return entries;
}

/**
 * Metadata-only digest of an installed payload: every entry's path, kind, inode, size, mode, link count, mtime,
 * ctime and link target. Any write, replacement, chmod or xattr change moves ctime, so equality with the digest
 * recorded when the bytes were hashed binds the tree to that hash without rereading it. Off the main thread: only
 * asynchronous lstat/readdir calls are issued.
 */
export async function readDocumentEngineIdentityDigest(root: string, signal: AbortSignal): Promise<string> {
  const entries: string[] = [];
  const visit = async (path: string, depth: number): Promise<void> => {
    signal.throwIfAborted();
    if (depth > PAYLOAD_LIMITS.depth || entries.length >= PAYLOAD_LIMITS.entries) throw new Error("Document engine payload entry limit exceeded");
    const stat = await fs.lstat(path, { bigint: true });
    const kind = stat.isSymbolicLink() ? "link" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : undefined;
    if (!kind) throw new Error("Document engine payload contains an unsupported entry");
    entries.push(JSON.stringify([relative(root, path).replace(/\\/g, "/"), kind, String(stat.ino), String(stat.size),
      String(stat.mode), String(stat.nlink), String(stat.mtimeNs), String(stat.ctimeNs), kind === "link" ? await fs.readlink(path) : null]));
    if (kind === "directory") await Promise.all((await fs.readdir(path)).map((child) => visit(join(path, child), depth + 1)));
  };
  await visit(root, 0);
  signal.throwIfAborted();
  return createHash("sha256").update(entries.sort().join("\n")).digest("hex");
}

export function documentEngineTreeDigest(tree: readonly DocumentEngineTreeEntry[]): string {
  return createHash("sha256").update(JSON.stringify(tree)).digest("hex");
}

export function documentEnginePayloadPaths(destination: string, release: DocumentEngineRelease): DocumentEnginePayloadPaths {
  if (release.platform === "darwin") {
    const root = join(destination, "LibreOffice.app");
    return { root, executable: join(root, "Contents", "MacOS", "soffice"), unopkg: join(root, "Contents", "MacOS", "unopkg") };
  }
  const root = release.platform === "win32" ? join(destination, "LibreOffice") : join(destination, "opt", "libreoffice26.8");
  return { root, executable: join(root, "program", release.platform === "win32" ? "soffice.exe" : "soffice"),
    unopkg: join(root, "program", release.platform === "win32" ? "unopkg.exe" : "unopkg") };
}

/**
 * `-noverify`: the image's bytes are already SHA-256 pinned and release-signature verified through a held descriptor,
 * so hdiutil's own UDIF checksum pass is redundant; it also writes `com.apple.diskimages.recentcksum` onto the archive.
 */
async function withDocumentEngineDiskImage<T>(archive: string, signal: AbortSignal, consume: (app: string) => Promise<T>): Promise<T> {
  const mount = await createPrivateTempDirectory(join(tmpdir(), "ave-document-engine-mount-"));
  let mounted = false;
  try {
    await runDocumentEngineSystemCommand("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-noverify", "-mountpoint", mount, archive], signal);
    mounted = true;
    const source = join(mount, "LibreOffice.app");
    const stat = await fs.lstat(source);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Document engine disk image has an invalid app layout");
    return await consume(source);
  } finally {
    if (mounted) await runDocumentEngineSystemCommand("/usr/bin/hdiutil", ["detach", mount], new AbortController().signal);
    await fs.rmdir(mount);
  }
}

export interface ExtractedDocumentEnginePayload {
  readonly paths: DocumentEnginePayloadPaths;
  /** macOS: the authenticated image's own tree, read from the same mount the copy came from. */
  readonly sourceTree?: readonly DocumentEngineTreeEntry[];
}

/** Extract authenticated distribution bytes into a caller-owned empty directory without a system install. */
export async function extractDocumentEnginePayload(
  archive: string, destination: string, release: DocumentEngineRelease, signal: AbortSignal,
): Promise<ExtractedDocumentEnginePayload> {
  if ((await fs.readdir(destination)).length !== 0) throw new Error("Document engine extraction directory is not empty");
  let sourceTree: readonly DocumentEngineTreeEntry[] | undefined;
  if (release.platform === "darwin") {
    sourceTree = await withDocumentEngineDiskImage(archive, signal, async (source) => {
      const tree = await readDocumentEngineTree(source, signal);
      await runDocumentEngineSystemCommand("/usr/bin/ditto", [source, join(destination, "LibreOffice.app")], signal);
      return tree;
    });
  } else if (release.platform === "win32") {
    await runDocumentEngineSystemCommand(win32SystemBinary("msiexec"), ["/a", archive, "/qn", "/norestart", `TARGETDIR=${destination}`], signal);
    const root = join(destination, "LibreOffice");
    const candidates: string[] = [];
    const locate = async (parent: string, depth: number): Promise<void> => {
      if (depth > 4) return;
      for (const name of await fs.readdir(parent)) {
        const path = join(parent, name);
        const stat = await fs.lstat(path);
        if (stat.isSymbolicLink()) throw new Error("Document engine administrative image contains a link");
        if (stat.isDirectory()) {
          if (name === "LibreOffice" && await fs.stat(join(path, "program", "soffice.exe")).then(() => true, (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return false;
            throw error;
          })) candidates.push(path);
          else await locate(path, depth + 1);
        }
      }
    };
    await locate(destination, 0);
    if (candidates.length !== 1) throw new Error("Document engine administrative image layout is unsupported");
    if (candidates[0] !== root) await renameDirectory(candidates[0]!, root);
  } else {
    const unpacked = await createPrivateTempDirectory(join(tmpdir(), "ave-document-engine-debs-"));
    try {
      await runDocumentEngineSystemCommand("/usr/bin/tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", unpacked], signal);
      const roots = await fs.readdir(unpacked);
      if (roots.length !== 1) throw new Error("Document engine package bundle layout is unsupported");
      const packages = join(unpacked, roots[0]!, "DEBS");
      const names = (await fs.readdir(packages)).filter((name) => name.endsWith(".deb")).sort();
      if (names.length < 1 || names.length > 256) throw new Error("Document engine package count is invalid");
      for (const name of names) {
        signal.throwIfAborted();
        if (name !== basename(name)) throw new Error("Document engine package name is invalid");
        await runDocumentEngineSystemCommand("/usr/bin/dpkg-deb", ["--extract", join(packages, name), destination], signal);
      }
    } finally { await fs.rm(unpacked, { recursive: true, force: true }); }
  }
  const paths = documentEnginePayloadPaths(destination, release);
  for (const path of [paths.executable, paths.unopkg]) {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Document engine executable layout is invalid");
  }
  return { paths, ...(sourceTree ? { sourceTree } : {}) };
}

/** Reconstruct the authenticated tree independently of the installed copy (platforms without a payload seal). */
export async function reconstructDocumentEngineTree(archive: string, release: DocumentEngineRelease, signal: AbortSignal): Promise<readonly DocumentEngineTreeEntry[]> {
  if (release.platform === "darwin") return await withDocumentEngineDiskImage(archive, signal, (source) => readDocumentEngineTree(source, signal));
  const temporary = await createPrivateTempDirectory(join(tmpdir(), "ave-document-engine-expected-"));
  try {
    const destination = await createPrivateDirectory(join(temporary, "payload"));
    const { paths } = await extractDocumentEnginePayload(archive, destination, release, signal);
    return await readDocumentEngineTree(paths.root, signal);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
