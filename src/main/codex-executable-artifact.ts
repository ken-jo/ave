import { createHash } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  assertCodexExecutableLocation,
  assertCodexLocations,
  assertCodexPrivateRuntimeDirectory,
  createPrivateObjects,
  createPrivateTempDirectory,
  type CodexLocationRequest,
  type CodexLocationTrustInputs,
} from "./codex-executable-location.js";
import { isNativeExecutableFile } from "./native-executable-format.js";
import { sameFileIdentity } from "../lib/file-identity.js";
import { retryOnTransientFsLock } from "../lib/transient-fs-lock-retry.js";

const COPY_BUFFER_BYTES = 64 * 1024;

interface ExecutableArtifactFile {
  readonly executable: string;
  readonly contentHash: string;
}

export interface CodexExecutableArtifact extends ExecutableArtifactFile {
  readonly companion: ExecutableArtifactFile | null;
}

export class CodexExecutableArtifactError extends Error {
  constructor(message = "Invalid native executable artifact") {
    super(message);
    this.name = "CodexExecutableArtifactError";
  }
}

function noFollow(): number {
  // Exclusive creation prevents following an existing destination on every platform. Source handles are pinned and checked again after open; the
  // additional no-follow flag is enforced on platforms that provide it.
  if (process.platform === "win32") return 0;
  if (typeof constants.O_NOFOLLOW !== "number") throw new CodexExecutableArtifactError("No-follow open is unavailable");
  return constants.O_NOFOLLOW;
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return sameFileIdentity(before, after) && before.size === after.size
    && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs;
}

export async function openExecutableFile(path: string): Promise<FileHandle> {
  const before = await fs.lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new CodexExecutableArtifactError();
  const handle = await fs.open(path, constants.O_RDONLY | noFollow());
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !unchanged(before, opened)) throw new CodexExecutableArtifactError("Executable changed while opening");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function hashExecutableFile(handle: FileHandle): Promise<string> {
  const before = await handle.stat({ bigint: true });
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (BigInt(position) !== before.size || !unchanged(before, await handle.stat({ bigint: true }))) {
    throw new CodexExecutableArtifactError("Executable changed while hashing");
  }
  return hash.digest("hex");
}

export async function copyExecutableFile(
  source: string,
  executable: string,
): Promise<ExecutableArtifactFile> {
  await assertCodexExecutableLocation(source);
  return copyAdmittedExecutableFile(source, executable);
}

// Copy a source whose location the caller already admitted, for example in one batch.
async function copyAdmittedExecutableFile(
  source: string,
  executable: string,
): Promise<ExecutableArtifactFile> {
  const input = await openExecutableFile(source);
  try {
    const before = await input.stat({ bigint: true });
    const output = await fs.open(executable, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(), 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
    let position = 0;
    try {
      for (;;) {
        const { bytesRead } = await input.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        await output.writeFile(chunk);
        hash.update(chunk);
        position += bytesRead;
      }
      if (BigInt(position) !== before.size || !unchanged(before, await input.stat({ bigint: true }))) {
        throw new CodexExecutableArtifactError("Executable changed while copying");
      }
      await output.sync();
      await output.chmod(0o500);
    } finally {
      await output.close();
    }
    return Object.freeze({ executable, contentHash: hash.digest("hex") });
  } finally {
    await input.close();
  }
}

export async function copyNativeExecutableFile(
  source: string,
  executable: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  routeKind: CodexLocationRequest["routeKind"] = "native",
  trustInputs: CodexLocationTrustInputs = {},
): Promise<ExecutableArtifactFile> {
  await assertCodexExecutableLocation(source, routeKind, trustInputs);
  const artifact = await copyAdmittedExecutableFile(source, executable);
  const copied = await openExecutableFile(executable);
  try {
    if (!await isNativeExecutableFile(copied, platform, arch)) throw new CodexExecutableArtifactError();
  } finally {
    await copied.close();
  }
  return artifact;
}

async function companionSource(source: string, platform: NodeJS.Platform): Promise<string | null> {
  const name = platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host";
  const directory = dirname(source);
  const packageDirectory = basename(directory) === "bin" ? dirname(directory)
    : basename(directory) === "MacOS" && basename(dirname(directory)) === "Contents"
      && basename(dirname(dirname(directory))) === "CodexCLI.app"
      ? dirname(dirname(dirname(directory))) : directory;
  const candidates = [join(packageDirectory, "codex-resources", name)];
  if (packageDirectory !== directory) candidates.push(join(packageDirectory, "bin", name));
  candidates.push(join(directory, name));
  for (const candidate of new Set(candidates)) {
    try {
      await fs.lstat(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
    await assertCodexExecutableLocation(candidate, "native");
    return fs.realpath(candidate);
  }
  return null;
}

// Copy the executable and its optional native companion into one private artifact.
export async function copyCodexExecutableArtifact(
  source: string,
  runtimeDirectory: string,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): Promise<CodexExecutableArtifact> {
  await assertCodexLocations([
    { path: source, kind: "executable", routeKind: "native" },
    { path: runtimeDirectory, kind: "private-directory", routeKind: "native" },
  ]);
  const directory = await createPrivateTempDirectory(join(runtimeDirectory, "artifact-"));
  try {
    await assertCodexPrivateRuntimeDirectory(directory, "native");
    const artifact = await createPrivateObjects(async (created) => {
      const primary = await copyNativeExecutableFile(source, join(directory, platform === "win32" ? "codex.exe" : "codex"), platform, arch);
      created.push(primary.executable);
      const companion = await companionSource(source, platform);
      const companionCopy = companion === null ? null : await copyNativeExecutableFile(
        companion,
        join(directory, platform === "win32" ? "codex-code-mode-host.exe" : "codex-code-mode-host"),
        platform,
        arch,
      );
      if (companionCopy) created.push(companionCopy.executable);
      return Object.freeze({ ...primary, companion: companionCopy });
    });
    await verifyCodexExecutableArtifact(artifact);
    return artifact;
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// Recheck the private copy immediately before each probe or app-server spawn.
export async function verifyCodexExecutableArtifact(
  artifact: CodexExecutableArtifact,
  routeKind: CodexLocationRequest["routeKind"] = "native",
): Promise<void> {
  const directory = dirname(artifact.executable);
  const files = [artifact, ...(artifact.companion ? [artifact.companion] : [])];
  for (const file of files) {
    if (dirname(file.executable) !== directory) throw new CodexExecutableArtifactError();
  }
  await assertCodexLocations([
    { path: directory, kind: "private-directory", routeKind },
    ...files.map((file) => ({ path: file.executable, kind: "executable" as const, routeKind })),
  ]);
  for (const file of files) {
    const input = await openExecutableFile(file.executable);
    try {
      const stat = await input.stat({ bigint: true });
      if (stat.nlink !== 1n || (process.platform !== "win32" && (stat.mode & 0o777n) !== 0o500n)
        || await hashExecutableFile(input) !== file.contentHash) {
        throw new CodexExecutableArtifactError("Executable artifact changed");
      }
    } finally {
      await input.close();
    }
  }
}

// Only callers that just created this artifact may discard it.
export async function discardCodexExecutableArtifact(artifact: CodexExecutableArtifact): Promise<void> {
  await retryOnTransientFsLock(() => fs.rm(dirname(artifact.executable), { recursive: true, force: true }));
}
