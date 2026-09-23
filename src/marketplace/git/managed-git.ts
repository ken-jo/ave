/**
 * The managed git copy (design §9.2): `~/.ave/runtime/git/<version>/`.
 *
 *   checking → downloading(bytes) → verifying → extracting → smoke-testing → ready | failed(code)
 *
 * The archive is downloaded through the caller's gated fetch (§7.4) with its
 * sha256 and exact size pinned in managed-git-pins.ts, extracted into a
 * staging directory next to the target, smoke-tested there, marked ready, and
 * only then renamed into place. A failed or partial install never replaces a
 * working copy: the previous directory is moved aside and restored if the
 * final rename fails.
 *
 * Trust roots per platform, as measured on the pinned build (2026-09-23):
 *   - macOS: `git-remote-http` links the system libcurl (SecureTransport), so
 *     the keychain — including a corporate root in the System keychain — is
 *     used as is. No CA file is set.
 *   - Linux: the copy ships `ssl/cacert.pem` and reads no OS store; the runner
 *     gets a bundle of those roots plus the corporate roots corp-ca-extract.ts
 *     finds.
 *   - Windows: `http.sslBackend=schannel`, the Windows certificate store. The
 *     copy's own system config says the same but is not read (GIT_CONFIG_NOSYSTEM).
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Parser, type ReadEntry } from "tar";
import { renameDirectory } from "../../lib/transient-fs-lock-retry.js";
import { canonicalZipEntryPathIdentity, sanitizeZipEntryPath } from "../../plugins/zip-entry-path.js";
import { buildSafeChildEnv } from "../../tools/safe-env.js";
import type { GitRuntimeProgress } from "../../shared/git-runtime.js";
import { MarketplaceError, isMarketplaceError } from "../errors.js";
import type { ManagedGitInstall } from "./detect.js";
import { parseGitVersion } from "./git-version.js";
import { MANAGED_GIT, type ManagedGitPins } from "./managed-git-pins.js";
import type { GitRunnerOptions } from "./run-git.js";

interface ManagedGitLayout {
  executable: string;
  execPath: string;
  pathPrefix: string[];
  /** Linux: the roots the copy ships; the other platforms use the OS store. */
  shippedCaBundle: string | null;
  config: Record<string, string>;
}

export function managedGitLayout(root: string, platform: NodeJS.Platform): ManagedGitLayout {
  if (platform === "win32") {
    return {
      executable: join(root, "cmd", "git.exe"),
      execPath: join(root, "mingw64", "libexec", "git-core"),
      pathPrefix: [join(root, "mingw64", "bin"), join(root, "usr", "bin")],
      shippedCaBundle: null,
      config: { "http.sslBackend": "schannel" },
    };
  }
  return {
    executable: join(root, "bin", "git"),
    execPath: join(root, "libexec", "git-core"),
    pathPrefix: [],
    shippedCaBundle: platform === "linux" ? join(root, "ssl", "cacert.pem") : null,
    config: {},
  };
}

const READY_MARKER = ".ave-ready.json";
const CA_BUNDLE = "ave-ca-bundle.pem";
const EXTRACT_LIMITS = { entries: 5000, bytes: 512 * 1024 * 1024 };
const SMOKE_TIMEOUT_MS = 15_000;
/** `git hash-object --stdin` of this text; proves the copy runs its own object code. */
const SMOKE_BLOB = "ave managed git\n";
/** A symlink may only name a sibling (`git-fetch -> git`), never a path. */
const SIBLING_LINK = /^[A-Za-z0-9._+-]+$/u;

function assetKey(platform: NodeJS.Platform, arch: string): string {
  return `${platform}-${arch}`;
}

function runtimeDir(runtimeRoot: string, pins: ManagedGitPins = MANAGED_GIT): string {
  return join(runtimeRoot, pins.version);
}

/** The installed copy of the pinned version, if it finished its smoke test. */
export async function findManagedGit(
  runtimeRoot: string,
  platform: NodeJS.Platform = process.platform,
  pins: ManagedGitPins = MANAGED_GIT,
): Promise<ManagedGitInstall | null> {
  const root = runtimeDir(runtimeRoot, pins);
  let marker: { version?: unknown };
  try {
    marker = JSON.parse(await readFile(join(root, READY_MARKER), "utf8")) as { version?: unknown };
  } catch {
    return null;
  }
  const layout = managedGitLayout(root, platform);
  const version = parseGitVersion(`git version ${pins.version}`);
  if (marker.version !== pins.version || !version || !existsSync(layout.executable)) return null;
  return { path: layout.executable, root, version };
}

/**
 * Runner settings for a managed copy. On Linux the CA bundle is rewritten on
 * each call so a corporate root added to the OS store reaches the next run.
 */
export async function managedRunnerOptions(
  install: ManagedGitInstall,
  platform: NodeJS.Platform,
  corporateRootsPem: string | null,
): Promise<Pick<GitRunnerOptions, "managedEnv" | "managedPathPrefix" | "managedConfig">> {
  const layout = managedGitLayout(install.root, platform);
  const env: Record<string, string> = { GIT_EXEC_PATH: layout.execPath };
  if (layout.shippedCaBundle) {
    if (corporateRootsPem) {
      const bundle = join(install.root, CA_BUNDLE);
      const shipped = await readFile(layout.shippedCaBundle, "utf8");
      await writeFile(bundle, `${shipped.trimEnd()}\n${corporateRootsPem.trim()}\n`, { mode: 0o600 });
      env.GIT_SSL_CAINFO = bundle;
    } else {
      env.GIT_SSL_CAINFO = layout.shippedCaBundle;
    }
  }
  return {
    managedEnv: env,
    ...(layout.pathPrefix.length > 0 ? { managedPathPrefix: layout.pathPrefix.join(platform === "win32" ? ";" : ":") } : {}),
    managedConfig: layout.config,
  };
}

export interface ManagedGitInstallOptions {
  /** `~/.ave/runtime/git`. */
  runtimeRoot: string;
  /** The gated download (§7.4): NetworkGate.fetch bound to the PAC-aware transport. */
  download: (url: string, signal?: AbortSignal) => Promise<Response>;
  platform?: NodeJS.Platform;
  arch?: string;
  pins?: ManagedGitPins;
  /** Replace an installed copy (repair). Without it an installed copy is returned as is. */
  force?: boolean;
  onProgress?: (progress: GitRuntimeProgress) => void;
  signal?: AbortSignal;
}

function installFailed(message: string, cause?: unknown): MarketplaceError {
  return new MarketplaceError("GIT_RUNTIME_INSTALL_FAILED", message, cause === undefined ? undefined : { cause });
}

/** Stream the body to `file` while hashing; never more than `size` bytes. */
async function downloadTo(response: Response, file: string, size: number, onBytes: (bytes: number) => void): Promise<string> {
  if (!response.ok || !response.body) throw installFailed(`download failed with HTTP ${response.status}`);
  const hash = createHash("sha256");
  const out = createWriteStream(file, { mode: 0o600 });
  let bytes = 0;
  try {
    await pipeline(
      response.body as unknown as NodeJS.ReadableStream,
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          bytes += chunk.length;
          if (bytes > size) throw installFailed(`download is larger than the pinned ${size} bytes`);
          hash.update(chunk);
          onBytes(bytes);
          yield chunk;
        }
      },
      out,
    );
  } catch (error) {
    if (isMarketplaceError(error)) throw error;
    throw installFailed(`download interrupted after ${bytes} bytes: ${(error as Error).message}`, error);
  }
  if (bytes !== size) throw installFailed(`download is ${bytes} bytes, expected ${size}`);
  return hash.digest("hex");
}

/** Extract regular files, directories and sibling symlinks; anything else stops the install. */
async function extract(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true, mode: 0o700 });
  const identities = new Set<string>();
  const writes: Promise<void>[] = [];
  let entries = 0;
  let bytes = 0;
  let failure: Error | null = null;
  const parser = new Parser({ strict: true });
  const fail = (error: Error) => {
    failure ??= error;
  };
  parser.on("warn", (code: string, message: string) => fail(installFailed(`archive: ${code} ${message}`)));
  parser.on("error", (error: Error) => fail(installFailed(`archive: ${error.message}`, error)));
  parser.on("entry", (entry: ReadEntry) => {
    const reject = (reason: string) => {
      fail(installFailed(`${reason}: ${entry.path}`));
      entry.resume();
    };
    if (failure) return entry.resume();
    const raw = entry.path.replace(/^\.\//u, "").replace(/\/$/u, "");
    if (raw === "" || raw === ".") return entry.resume();
    let relative: string | null;
    try {
      relative = sanitizeZipEntryPath("managed-git", raw);
    } catch (error) {
      return reject((error as Error).message);
    }
    if (!relative) return reject("empty entry path");
    const identity = canonicalZipEntryPathIdentity(relative);
    if (identities.has(identity)) return reject("entry path collides with another on a case-insensitive filesystem");
    identities.add(identity);
    if (++entries > EXTRACT_LIMITS.entries) return reject(`more than ${EXTRACT_LIMITS.entries} entries`);
    const target = join(dest, ...relative.split("/"));
    if (entry.type === "Directory") {
      writes.push(mkdir(target, { recursive: true, mode: 0o755 }).then(() => undefined));
      entry.resume();
      return;
    }
    if (entry.type === "SymbolicLink") {
      const link = entry.linkpath ?? "";
      if (!SIBLING_LINK.test(link) || link === "." || link === "..") return reject(`symlink to ${JSON.stringify(link)} is not a sibling`);
      writes.push(mkdir(dirname(target), { recursive: true }).then(() => symlink(link, target)));
      entry.resume();
      return;
    }
    if (entry.type !== "File") return reject(`unsupported entry type ${entry.type}`);
    bytes += entry.size;
    if (bytes > EXTRACT_LIMITS.bytes) return reject(`more than ${EXTRACT_LIMITS.bytes} bytes`);
    const mode = ((entry.mode ?? 0o644) & 0o755) | 0o600;
    writes.push(
      mkdir(dirname(target), { recursive: true }).then(() => pipeline(entry as unknown as NodeJS.ReadableStream, createWriteStream(target, { mode, flags: "wx" }))),
    );
  });
  try {
    await pipeline(createReadStream(archive), parser as unknown as NodeJS.WritableStream);
  } catch (error) {
    fail(installFailed(`archive: ${(error as Error).message}`, error));
  }
  const settled = await Promise.allSettled(writes);
  for (const result of settled) if (result.status === "rejected") fail(installFailed(`extract: ${(result.reason as Error).message}`, result.reason));
  if (failure) throw failure;
}

function runCopy(layout: ManagedGitLayout, args: string[], input?: string): Promise<string> {
  const env = buildSafeChildEnv({
    GIT_EXEC_PATH: layout.execPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  });
  if (layout.pathPrefix.length > 0) env.PATH = [...layout.pathPrefix, env.PATH ?? ""].join(process.platform === "win32" ? ";" : ":");
  return new Promise((resolve, reject) => {
    const child = execFile(layout.executable, args, { env, timeout: SMOKE_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** The copy runs, reports the pinned version, hashes like git, and has its https helper. */
async function smokeTest(root: string, platform: NodeJS.Platform, pins: ManagedGitPins): Promise<void> {
  const layout = managedGitLayout(root, platform);
  let versionText: string;
  let oid: string;
  try {
    versionText = await runCopy(layout, ["--version"]);
    oid = (await runCopy(layout, ["hash-object", "--stdin"], SMOKE_BLOB)).trim();
  } catch (error) {
    throw installFailed(`the downloaded git does not run: ${(error as Error).message}`, error);
  }
  const version = parseGitVersion(versionText);
  if (!version || `${version.major}.${version.minor}.${version.patch}` !== pins.version) {
    throw installFailed(`the downloaded git reports ${versionText.trim()}, expected ${pins.version}`);
  }
  const expected = createHash("sha1").update(`blob ${Buffer.byteLength(SMOKE_BLOB)}\0${SMOKE_BLOB}`).digest("hex");
  if (oid !== expected) throw installFailed(`the downloaded git hashed a blob as ${oid}, expected ${expected}`);
  const helper = join(layout.execPath, platform === "win32" ? "git-remote-https.exe" : "git-remote-https");
  if (!existsSync(helper)) throw installFailed("the downloaded git has no https transport helper");
}

const running = new Map<string, Promise<ManagedGitInstall>>();

/** Download, verify, extract, smoke-test and publish the pinned copy. Concurrent calls share one install. */
export function installManagedGit(options: ManagedGitInstallOptions): Promise<ManagedGitInstall> {
  const key = options.runtimeRoot;
  const current = running.get(key);
  if (current) return current;
  const started = runInstall(options).finally(() => running.delete(key));
  running.set(key, started);
  return started;
}

async function runInstall(options: ManagedGitInstallOptions): Promise<ManagedGitInstall> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const pins = options.pins ?? MANAGED_GIT;
  const report = (progress: GitRuntimeProgress) => options.onProgress?.(progress);
  const staging = join(options.runtimeRoot, `.staging-${randomBytes(8).toString("hex")}`);
  try {
    report({ phase: "checking" });
    const existing = await findManagedGit(options.runtimeRoot, platform, pins);
    if (existing && !options.force) {
      report({ phase: "ready", version: pins.version });
      return existing;
    }
    const asset = pins.assets[assetKey(platform, arch)];
    if (!asset) throw installFailed(`no managed git build for ${assetKey(platform, arch)}`);

    await mkdir(staging, { recursive: true, mode: 0o700 });
    const archive = join(staging, "git.tar.gz");
    report({ phase: "downloading", bytes: 0, total: asset.size });
    let response: Response;
    try {
      response = await options.download(asset.url, options.signal);
    } catch (error) {
      // A policy block says why and stays; any other transport failure is this install failing (§14).
      if (isMarketplaceError(error) && error.code === "SOURCE_POLICY_BLOCKED") throw error;
      throw installFailed(`download failed: ${(error as Error).message}`, error);
    }
    const digest = await downloadTo(response, archive, asset.size, (bytes) => report({ phase: "downloading", bytes, total: asset.size }));

    report({ phase: "verifying" });
    if (digest !== asset.sha256) throw installFailed(`sha256 ${digest} does not match the pinned ${asset.sha256}`);

    report({ phase: "extracting" });
    const extracted = join(staging, "root");
    await extract(archive, extracted);
    await rm(archive, { force: true });

    report({ phase: "smoke-testing" });
    await smokeTest(extracted, platform, pins);
    await writeFile(
      join(extracted, READY_MARKER),
      `${JSON.stringify({ version: pins.version, sha256: asset.sha256, installedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );

    const target = runtimeDir(options.runtimeRoot, pins);
    const aside = existsSync(target) ? join(options.runtimeRoot, `.previous-${randomBytes(8).toString("hex")}`) : null;
    if (aside) await renameDirectory(target, aside);
    try {
      await renameDirectory(extracted, target);
    } catch (error) {
      if (aside) await renameDirectory(aside, target);
      throw installFailed(`cannot move the new copy into place: ${(error as Error).message}`, error);
    }
    if (aside) await rm(aside, { recursive: true, force: true });

    const installed = await findManagedGit(options.runtimeRoot, platform, pins);
    if (!installed) throw installFailed("the installed copy is not found after the move");
    report({ phase: "ready", version: pins.version });
    return installed;
  } catch (error) {
    const failure = isMarketplaceError(error) ? error : installFailed((error as Error).message, error);
    report({ phase: "failed", code: failure.code, message: failure.message });
    throw failure;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
