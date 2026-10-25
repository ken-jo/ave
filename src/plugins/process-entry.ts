/** Process plugins speak the protocol through their own executable and require pinned provenance plus process confinement. */
import { realpathSync } from "node:fs";
import { isSafeMcpEnvironmentName } from "../mcp/safe-names.js";
import type { GitInstallRecord, PluginInstallReceipt, PluginRung } from "./plugin-install-receipt.js";
import { AVE_EXTENSION_NAMESPACE, type PluginManifest } from "./public-contract.js";
import { resolveBundledArgv, resolveProcessEntryEnvironmentValue } from "./resolve-bundled-argv.js";
import { isRecord } from "../shared/is-record.js";

/** The process runtime requires its own minimum app version; support for an older protocol alone is insufficient. */
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

export class ProcessEntryUnconfinedError extends Error {
  readonly code = PROCESS_ENTRY_UNCONFINED_CODE;

  constructor() {
    super(PROCESS_ENTRY_UNCONFINED_MESSAGE);
    this.name = "ProcessEntryUnconfinedError";
  }
}

export class ProcessEntryRequiresPinnedArtifactError extends Error {
  readonly code = PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE;

  constructor() {
    super(PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_MESSAGE);
    this.name = "ProcessEntryRequiresPinnedArtifactError";
  }
}

export function hasProcessEntry(document: unknown): boolean {
  if (!isRecord(document) || !isRecord(document.extensions)) return false;
  const extension = document.extensions[AVE_EXTENSION_NAMESPACE];
  return isRecord(extension) && Object.hasOwn(extension, "process");
}

/** Each activation supplies only provenance it verified itself; undefined means no evidence. */
export interface ProcessEntryProvenance {
  readonly installSource: "marketplace" | "local-dev" | "git" | "folder";
  readonly artifactSha256: string | null;
  /** Folder artifacts never qualify for process entry. */
  readonly rung: PluginRung | null;
  /** The kind of git source the install came from; `null` for any other install. */
  readonly sourceOrigin: GitInstallRecord["sourceOrigin"] | null;
}

/** The provenance a verified receipt records: what the gate reads from it. */
export function processEntryProvenance(receipt: PluginInstallReceipt): ProcessEntryProvenance {
  return {
    installSource: receipt.installSource,
    artifactSha256: receipt.artifactSha256,
    rung: receipt.installSource === "git" ? receipt.git.rung : receipt.installSource === "folder" ? "folder" : null,
    sourceOrigin: receipt.installSource === "git" ? receipt.git.sourceOrigin : null,
  };
}

/** New source kinds refuse until explicitly admitted; direct sources are not marketplaces. */
const MARKETPLACE_SOURCE_ORIGINS: ReadonlySet<GitInstallRecord["sourceOrigin"]> = new Set(["official", "managed", "custom"]);

/** Only verified git release/archive receipts with sha256 pins admit process entries; entry manifests bypass this gate. */
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

export interface ProcessLaunch {
  readonly command: string;
  readonly args: readonly string[];
  /** Declared environment pairs precede authoritative PLUGIN_ROOT and PLUGIN_DATA. */
  readonly env: Readonly<Record<string, string>>;
}

// Resolve a regular executable inside the retained generation and validate rooted arguments before spawn.
// Append host-owned environment last so declarations cannot override it.
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
    // The verified artifact hash already pins executable bytes; no resolver fingerprint is needed.
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
