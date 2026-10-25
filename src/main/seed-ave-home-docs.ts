import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  constants as fsConstants,
} from "node:fs";
import { basename, join, dirname, parse as parsePath } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENTS_DOC_NAME, aveHome } from "../shared/ave-home.js";
import * as atomicFile from "../lib/atomic-file.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { isMissingPathError } from "../lib/atomic-file.js";
import { getConfiguredHostResources } from "./host-resources.js";

export interface AveHomeDocUpgradeMarker {
  sourcePath: string;
  markerPath: string;
}

const UPGRADE_MARKER_DOC_DIRS = ["", "skills", "prompts"] as const;

interface SeedOneOptions {
  upgradePolicy: "marker" | "seed-only";
  replaceableHashesResource?: string;
}

// Never overwrite user edits or pending upgrade markers; replace AGENTS.md only after no-follow validation and an exact shipped-byte match. Offer each
// divergent packaged version once; agent profiles are seed-only and seeding failures must not block boot.
export function seedAveHomeDocs(): { seeded: string[]; upgraded: string[] } {
  const result = { seeded: [] as string[], upgraded: [] as string[] };
  const home = aveHome();

  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  } catch (err) {
    console.warn("[seed-ave-home-docs] failed to ensure home dir:", err);
    return result;
  }

  seedOne(home, AGENTS_DOC_NAME, result, {
    upgradePolicy: "marker",
    replaceableHashesResource: "AGENTS.md.replaceable-sha256",
  });
  seedDir(home, "agents", result, { upgradePolicy: "seed-only" });
  seedDir(home, "skills", result, { upgradePolicy: "marker" });
  seedDir(home, "prompts", result, { upgradePolicy: "marker" });
  return result;
}

export function listAveHomeDocUpgradeMarkers(home = aveHome()): AveHomeDocUpgradeMarker[] {
  const markers: AveHomeDocUpgradeMarker[] = [];
  for (const subdir of UPGRADE_MARKER_DOC_DIRS) {
    const dir = subdir.length > 0 ? join(home, subdir) : home;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const entry of entries) {
      if (!isUpgradeMarkerName(entry)) continue;
      const markerPath = subdir.length > 0 ? join(subdir, entry) : entry;
      markers.push({
        markerPath,
        sourcePath: sourcePathForUpgradeMarker(markerPath),
      });
    }
  }
  return markers.sort((a, b) => a.markerPath.localeCompare(b.markerPath));
}

// Accept marker paths only from the host’s current marker listing; never join arbitrary IPC paths onto home.
function resolveUpgradeMarker(
  markerPath: string,
  home: string,
): AveHomeDocUpgradeMarker | null {
  return listAveHomeDocUpgradeMarkers(home)
    .find((marker) => marker.markerPath === markerPath) ?? null;
}

// Bytes of a pending upgrade marker, or `null` when it is not one.
export function readAveHomeDocUpgradeMarker(
  markerPath: string,
  home = aveHome(),
): string | null {
  const marker = resolveUpgradeMarker(markerPath, home);
  if (marker === null) return null;
  const buf = readMarkerIfPresent(join(home, marker.markerPath));
  return buf === null ? null : buf.toString("utf8");
}

// Bytes of the live doc a marker offers to replace, or `null` when either is absent. The source path is derived from the validated marker rather than
// accepted from the caller, so this reaches no file the marker listing does not already name.
export function readAveHomeDocSource(
  markerPath: string,
  home = aveHome(),
): string | null {
  const marker = resolveUpgradeMarker(markerPath, home);
  if (marker === null) return null;
  const buf = readMarkerIfPresent(join(home, marker.sourcePath));
  return buf === null ? null : buf.toString("utf8");
}

// Report whether an upgrade marker was removed so keeping the user’s version differs from an already-settled offer.
export function discardAveHomeDocUpgradeMarker(
  markerPath: string,
  home = aveHome(),
): boolean {
  const marker = resolveUpgradeMarker(markerPath, home);
  if (marker === null) return false;
  try {
    unlinkSync(join(home, marker.markerPath));
    return true;
  } catch (err) {
    if (isMissingPathError(err)) return false;
    throw err;
  }
}

// Applying one version retires all byte-identical offers so dated siblings cannot re-offer the live document.
export function retireAppliedAveHomeDocUpgradeMarkers(
  markerPath: string,
  appliedBytes: string,
  home = aveHome(),
): void {
  const marker = resolveUpgradeMarker(markerPath, home);
  if (marker === null) return;
  const appliedMarker = join(home, marker.markerPath);
  const applied = Buffer.from(appliedBytes, "utf8");
  for (const sibling of upgradeMarkerPathsFor(home, marker.sourcePath)) {
    if (sibling !== appliedMarker) {
      const bytes = readMarkerIfPresent(sibling);
      if (bytes === null || !bytes.equals(applied)) continue;
    }
    try {
      unlinkSync(sibling);
    } catch (err) {
      if (isMissingPathError(err)) continue;
      console.warn(`[seed-ave-home-docs] failed to retire ${sibling}:`, err);
    }
  }
}

// Do not relabel shipped reference bytes as user customization; recognize exact allowlisted versions and the current packaged copy.
export function isShippedAgentsMdContent(content: string): boolean {
  const buf = Buffer.from(content, "utf8");
  if (readReplaceableHashes("AGENTS.md.replaceable-sha256").has(sha256Hex(buf))) {
    return true;
  }
  const packagedSource = resolvePackagedResource(AGENTS_DOC_NAME);
  if (packagedSource === null) return false;
  try {
    return readFileSync(packagedSource).equals(buf);
  } catch {
    return false;
  }
}

function isUpgradeMarkerName(name: string): boolean {
  const markerIndex = name.indexOf(".md.new");
  if (markerIndex === -1) return false;
  const suffix = name.slice(markerIndex + ".md.new".length);
  return suffix === "" || suffix.startsWith(".");
}

function sourcePathForUpgradeMarker(markerPath: string): string {
  const markerIndex = markerPath.indexOf(".new");
  return markerIndex === -1 ? markerPath : markerPath.slice(0, markerIndex);
}

// Use the shared marker grammar for both undated and dated siblings so listing and duplicate detection agree.
function upgradeMarkerPathsFor(home: string, filename: string): string[] {
  const target = join(home, filename);
  const dir = dirname(target);
  const sourceName = basename(target);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (isMissingPathError(err)) return [];
    throw err;
  }
  return entries
    .filter(
      (entry) =>
        isUpgradeMarkerName(entry) && sourcePathForUpgradeMarker(entry) === sourceName,
    )
    .map((entry) => join(dir, entry));
}

// A marker the user merged between the directory listing and this read is simply gone.
function readMarkerIfPresent(markerPath: string): Buffer | null {
  try {
    return readFileSync(markerPath);
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw err;
  }
}

// Prune only dated markers with exact allowlisted shipped bytes; preserve undated offers and documents without an allowlist.
function pruneSupersededMarkers(
  markerPaths: string[],
  undatedMarker: string,
  replaceableHashes: Set<string>,
): void {
  if (replaceableHashes.size === 0) return;
  for (const markerPath of markerPaths) {
    if (markerPath === undatedMarker) continue;
    try {
      const markerBuf = readRegularFileNoFollow(markerPath);
      if (markerBuf === null || !replaceableHashes.has(sha256Hex(markerBuf))) continue;
      unlinkSync(markerPath);
    } catch (err) {
      console.warn(`[seed-ave-home-docs] failed to prune ${markerPath}:`, err);
    }
  }
}

function seedOne(
  home: string,
  filename: string,
  result: { seeded: string[]; upgraded: string[] },
  options: SeedOneOptions,
): void {
  const packagedSource = resolvePackagedResource(filename);
  if (packagedSource === null) {
    console.warn(`[seed-ave-home-docs] packaged ${filename} not found — skipping`);
    return;
  }

  // Read the packaged template once and compare against that snapshot, avoiding path check/read races.
  let packagedBuf: Buffer;
  try {
    packagedBuf = readFileSync(packagedSource);
  } catch (err) {
    console.warn(`[seed-ave-home-docs] failed to read packaged ${filename}:`, err);
    return;
  }

  const target = join(home, filename);
  const upgradeTarget = join(home, `${filename}.new`);
  const replaceableHashes = options.replaceableHashesResource
    ? readReplaceableHashes(options.replaceableHashesResource)
    : new Set<string>();

  if (!existsSync(target)) {
    try {
      // COPYFILE_EXCL closes the TOCTOU window between existsSync and the write: if another process (concurrent boot from a second app instance, background
      // sync agent) lands a file in the gap, this throws EEXIST and we honor their write rather than clobbering it.
      copyFileSync(packagedSource, target, fsConstants.COPYFILE_EXCL);
      enforceUserFileMode(target);
      result.seeded.push(filename);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
      console.warn(`[seed-ave-home-docs] failed to seed ${filename}:`, err);
    }
    return;
  }

  if (options.upgradePolicy === "seed-only") return;

  // Read the target directly and compare bytes; unsupported or failed predecessor replacement falls back to a non-clobbering .new offer.
  try {
    // Byte-identical content is an idempotent no-op even when this platform cannot safely perform an in-place path replacement. This read may follow a
    // user-owned symlink, but it never writes through it.
    let observedBuf: Buffer | null = null;
    try {
      observedBuf = readFileSync(target);
    } catch {
      // Non-regular or transiently unavailable targets continue to the fail-closed `.new` path below.
    }
    if (observedBuf?.equals(packagedBuf)) return;

    const currentBuf = replaceableHashes.size > 0
      ? readRegularFileNoFollow(target)
      : null;
    if (currentBuf !== null) {
      const currentHash = sha256Hex(currentBuf);
      if (
        replaceableHashes.has(currentHash) &&
        replaceKnownPackagedCopy(target, packagedBuf, currentHash)
      ) {
        result.upgraded.push(filename);
        return;
      }
    }

    // Never overwrite pending offers; compare every sibling so each packaged version is offered only once.
    const markerPaths = upgradeMarkerPathsFor(home, filename);
    for (const markerPath of markerPaths) {
      const markerBuf = readMarkerIfPresent(markerPath);
      if (markerBuf?.equals(packagedBuf)) return;
    }

    // The undated name is the stable one this doc's pending upgrade is surfaced under; while an older offer still holds it, a newer version lands beside it
    // under a timestamp so neither offer is lost.
    const offerTarget = markerPaths.includes(upgradeTarget)
      ? join(home, `${filename}.new.${new Date().toISOString().replace(/[:.]/g, "-")}`)
      : upgradeTarget;
    copyFileSync(packagedSource, offerTarget);
    enforceUserFileMode(offerTarget);
    result.upgraded.push(filename);
    pruneSupersededMarkers(markerPaths, upgradeTarget, replaceableHashes);
  } catch (err) {
    console.warn(`[seed-ave-home-docs] failed to compare ${filename}:`, err);
  }
}

function readReplaceableHashes(resourceName: string): Set<string> {
  const resource = resolvePackagedResource(resourceName);
  if (resource === null) return new Set();

  try {
    const lines = readFileSync(resource, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter((line) => /^[a-f0-9]{64}$/.test(line));
    return new Set(lines);
  } catch (err) {
    console.warn("[seed-ave-home-docs] failed to read replaceable hash list:", err);
    return new Set();
  }
}

// Refuse symlinks and non-files before hashing a user-owned target.
function readRegularFileNoFollow(target: string): Buffer | null {
  let fd: number | null = null;
  try {
    // A pre-open lstat check creates its own path-swap race. Require the descriptor-level primitive instead; platforms without O_NOFOLLOW fail closed into
    // the non-clobbering `.new` path.
    const noFollow = fsConstants.O_NOFOLLOW;
    if (typeof noFollow !== "number") return null;
    fd = openSync(target, fsConstants.O_RDONLY | noFollow);
    if (!fstatSync(fd).isFile()) return null;
    return readFileSync(fd);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// Stage and fsync the successor, then recheck regular-file identity and allowlisted hash immediately before rename.
// Failed preconditions preserve the original and use the non-clobbering offer path.
function replaceKnownPackagedCopy(
  target: string,
  packagedBuf: Buffer,
  expectedHash: string,
): boolean {
  try {
    return atomicFile.replaceUtf8FileAtomicSyncIf(
      target,
      packagedBuf.toString("utf8"),
      () => {
        const latest = readRegularFileNoFollow(target);
        return latest !== null && sha256Hex(latest) === expectedHash;
      },
      0o600,
    );
  } catch (err) {
    if ((err as { committed?: boolean }).committed === true) {
      console.warn(
        "[seed-ave-home-docs] packaged copy replaced, but parent directory durability sync failed:",
        err,
      );
      return true;
    }
    console.warn("[seed-ave-home-docs] failed to replace known packaged copy:", err);
    return false;
  }
}

// Storage-namespace rule: files under `~/.ave/` are 0o600 (user-only). On Windows chmod is effectively a no-op — wrap so the seed continues to succeed
// there instead of treating the platform mismatch as a fatal error.
function enforceUserFileMode(target: string): void {
  try {
    chmodSync(target, 0o600);
  } catch {
    // Windows / non-POSIX filesystem — best effort only.
  }
}

// Seed every `*.md` file from a packaged resource subdirectory into the matching `~/.ave/<subdir>/` location. The caller chooses whether existing
// divergent user files get a non-clobbering `.new` marker or stay seed-only.
function seedDir(
  home: string,
  subdir: string,
  result: { seeded: string[]; upgraded: string[] },
  options: SeedOneOptions,
): void {
  const packagedDir = resolvePackagedResource(subdir);
  if (packagedDir === null) {
    // No packaged templates for this subdir — fine for early dev tree, just skip.
    return;
  }

  const targetDir = join(home, subdir);
  try {
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    console.warn(`[seed-ave-home-docs] failed to ensure dir ${subdir}:`, err);
    return;
  }

  let entries: string[];
  try {
    entries = readdirSync(packagedDir);
  } catch (err) {
    console.warn(`[seed-ave-home-docs] failed to scan ${subdir}:`, err);
    return;
  }

  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".md")) continue;
    seedOne(home, join(subdir, entry), result, options);
  }
}

function resolvePackagedResource(name: string): string | null {
  const resourceRoot = getConfiguredHostResources()?.resourcePath;
  if (resourceRoot !== undefined) {
    const packaged = join(resourceRoot, name);
    return existsSync(packaged) ? packaged : null;
  }

  // Resolve resources by walking ancestors of this module, never cwd or getAppPath, which desktop launchers can redirect.
  const root = packagedResourceRoot();
  if (root === null) return null;
  const dev = join(root, "resources", name);
  return existsSync(dev) ? dev : null;
}

// Resolve the resource-bearing ancestor once per process; genuine absence returns null and skips seeding.
let cachedResourceRoot: string | null | undefined;
function packagedResourceRoot(): string | null {
  // Explicit override anchor: lets the unit test (and any out-of-tree packaging layout) point the resolver at a known root WITHOUT mutating process.cwd()
  // or the module location. Not cached — the test sets a fresh fixtures root per case via `beforeEach`.
  const override = process.env.AVE_RESOURCE_ROOT?.trim();
  if (override) {
    return existsSync(join(override, "resources", "skills")) ? override : null;
  }

  if (cachedResourceRoot !== undefined) return cachedResourceRoot;
  let dir = dirname(fileURLToPath(import.meta.url));
  const fsRoot = parsePath(dir).root;
  for (;;) {
    if (existsSync(join(dir, "resources", "skills"))) {
      cachedResourceRoot = dir;
      return dir;
    }
    if (dir === fsRoot) break;
    dir = dirname(dir);
  }
  cachedResourceRoot = null;
  return null;
}
