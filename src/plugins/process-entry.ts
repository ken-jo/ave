/**
 * The `process` entry: a plugin whose process is its own executable, speaking
 * the host protocol itself (docs/design/plugin-hostapi-protocol.md §2.1, §9.7 P3).
 *
 * Two refusals belong to it, and they are different questions:
 *
 *  - PROVENANCE ({@link assertProcessEntryAdmitted}). An executable the host
 *    cannot read as JS runs only when its bytes came through the release or
 *    archive rung of the git artifact ladder with a sha256 pin. It is decided
 *    first in the one funnel every activation path goes through, before any
 *    factory exists (decision 35).
 *  - CONFINEMENT ({@link ProcessEntryUnconfinedError}). It runs only under a
 *    live OS sandbox that confines processes, so never with the sandbox off and
 *    never on Windows, whose sandbox does not confine process creation. That is
 *    decided where the child is spawned.
 */
import { realpathSync } from "node:fs";
import { isSafeMcpEnvironmentName } from "../mcp/safe-names.js";
import type { ArtifactRung, GitInstallRecord, PluginInstallReceipt } from "./plugin-install-receipt.js";
import { AVE_EXTENSION_NAMESPACE, type PluginManifest } from "./public-contract.js";
import { resolveBundledArgv, resolveProcessEntryEnvironmentValue } from "./resolve-bundled-argv.js";

/**
 * The first app release with a `process` runtime (decision 38). Protocol `2`
 * began at 0.12.0, but no 0.12.x app can run a process entry, so a manifest
 * declaring one must require at least this version — that is what keeps catalog
 * selection on a 0.12.x client from choosing a version its runtime refuses.
 */
export const PROCESS_ENTRY_FIRST_APP_VERSION = "0.13.0";

export const PROCESS_ENTRY_UNCONFINED_CODE = "process-entry-unconfined";
const PROCESS_ENTRY_UNCONFINED_MESSAGE =
  "This extension runs its own program, which Ave runs only inside the OS Tool Sandbox on macOS or Linux. "
  + "Turn on Settings > Permissions > OS Tool Sandbox, then restart the extension. It cannot run on Windows.";

export const PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE = "process-entry-requires-pinned-artifact";
export const PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_MESSAGE =
  "This extension runs its own program, which Ave installs only from a marketplace release or archive pinned by its "
  + "sha256 hash, so this copy was refused. Install it from a marketplace that pins its release; a direct or local "
  + "install of it is always refused.";

/** No sandbox that confines processes is live, so a `process` entry is not spawned. */
export class ProcessEntryUnconfinedError extends Error {
  readonly code = PROCESS_ENTRY_UNCONFINED_CODE;

  constructor() {
    super(PROCESS_ENTRY_UNCONFINED_MESSAGE);
    this.name = "ProcessEntryUnconfinedError";
  }
}

/** A `process` entry whose install is not pinned by a release or archive artifact. */
export class ProcessEntryRequiresPinnedArtifactError extends Error {
  readonly code = PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE;

  constructor() {
    super(PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_MESSAGE);
    this.name = "ProcessEntryRequiresPinnedArtifactError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A process marker identifies an extension in a document no one has validated yet. */
export function hasProcessEntry(document: unknown): boolean {
  if (!isRecord(document) || !isRecord(document.extensions)) return false;
  const extension = document.extensions[AVE_EXTENSION_NAMESPACE];
  return isRecord(extension) && Object.hasOwn(extension, "process");
}

/**
 * What one activation path verified about the install it is activating: the
 * receipt's source, its artifact hash and, for a git install, the ladder rung
 * the artifact came through. `undefined` when the path verified nothing.
 */
export interface ProcessEntryProvenance {
  readonly installSource: "marketplace" | "local-dev" | "git";
  readonly artifactSha256: string | null;
  readonly rung: ArtifactRung | null;
  /** The kind of git source the install came from; `null` for any other install. */
  readonly sourceOrigin: GitInstallRecord["sourceOrigin"] | null;
}

/** The provenance a verified receipt records: what the gate reads from it. */
export function processEntryProvenance(receipt: PluginInstallReceipt): ProcessEntryProvenance {
  return {
    installSource: receipt.installSource,
    artifactSha256: receipt.artifactSha256,
    rung: receipt.installSource === "git" ? receipt.git.rung : null,
    sourceOrigin: receipt.installSource === "git" ? receipt.git.sourceOrigin : null,
  };
}

/**
 * The git sources that are marketplaces. A direct source is not one (§9.7 P4),
 * and a source kind added later stays refused until it is listed here.
 */
const MARKETPLACE_SOURCE_ORIGINS: ReadonlySet<GitInstallRecord["sourceOrigin"]> = new Set(["official", "managed", "custom"]);

/**
 * The provenance gate (decision 35). A no-op for an `entry` manifest; a
 * `process` manifest passes only with a verified `git` receipt from a
 * marketplace source whose artifact came through the `release` or `archive`
 * rung with a sha256 pin. Everything else that reaches it — a tree-rung
 * install, a direct source, a v3 receipt, a `local-dev` receipt under dev
 * unlock, a valid receipt the path did not verify — is refused.
 */
export function assertProcessEntryAdmitted(
  manifest: PluginManifest,
  verified: ProcessEntryProvenance | undefined,
): void {
  if (manifest.process === undefined) return;
  if (
    verified?.installSource === "git"
    && (verified.rung === "release" || verified.rung === "archive")
    && verified.artifactSha256 !== null
    && verified.sourceOrigin !== null
    && MARKETPLACE_SOURCE_ORIGINS.has(verified.sourceOrigin)
  ) {
    return;
  }
  throw new ProcessEntryRequiresPinnedArtifactError();
}

/** A `process` entry resolved against one retained generation: what the spawn runs. */
export interface ProcessLaunch {
  /** The executable's realpath inside the generation. */
  readonly command: string;
  readonly args: readonly string[];
  /** The declared pairs in manifest order, then `PLUGIN_ROOT` and `PLUGIN_DATA`. */
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The one builder of a `process` launch, shared by the factory and the validate
 * CLI.
 *
 * The executable is a regular file inside the generation; a `${PLUGIN_ROOT}/…`
 * argument or value is an existing file or directory inside it; a
 * `${PLUGIN_DATA}…` one stays inside the data directory (its leaf may not
 * exist yet). Declared names are held to the reserved-name rule again here,
 * below the manifest hardening, because this result is what reaches the spawn.
 * The host-owned pair comes last, so it is authoritative.
 */
export function resolveProcessLaunch(
  manifest: PluginManifest,
  generationRoot: string,
  pluginDataDir: string,
): ProcessLaunch {
  const entry = manifest.process;
  if (entry === undefined) throw new Error(`plugin '${manifest.id}' declares no process entry`);
  const label = `process entry of '${manifest.id}'`;
  const [command, ...args] = resolveBundledArgv({
    generationRoot,
    dataDir: pluginDataDir,
    argv: [entry.command, ...(entry.args ?? [])],
    // The receipt's artifact hash already pins these bytes; the fingerprint
    // the resolver derives is not used for a process entry.
    baseFingerprint: "",
    label,
    policy: "process",
  }).argv;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(entry.env ?? {})) {
    if (!isSafeMcpEnvironmentName(name)) {
      throw new Error(`${label} declares the environment name '${name}', which the host reserves`);
    }
    env[name] = resolveProcessEntryEnvironmentValue(generationRoot, pluginDataDir, value, `${label} env ${name}`);
  }
  env.PLUGIN_ROOT = realpathSync(generationRoot);
  env.PLUGIN_DATA = realpathSync(pluginDataDir);
  return { command: command!, args, env };
}
