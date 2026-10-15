/**
 * MCP servers the git marketplace installs (design §5.2, §8.1).
 *
 * A server is an entry in the MCP config (`mcp-manager`), plus, for a
 * package-local command, the package's `server/` files under
 * `~/.ave/mcp/<name>/` (`$PLUGIN_DIR`, replaced on update), plus its own
 * `~/.ave/mcp-data/<name>/` (`$DATA_DIR`, kept across updates and removed
 * on uninstall only when the user says so).
 *
 * `~/.ave/packages/mcp-installs.json` records which servers this installer
 * owns and where each came from: the MCP config has no room for provenance,
 * and a server the user configured by hand is never touched here. A record
 * file that cannot be read stops the installer rather than reading as empty,
 * which would make every installed server look hand-configured.
 *
 * Every change runs one at a time. A config swap that fails puts the
 * previous config back; the files are swapped by the artifact store, which
 * restores the previous directory when the swap's commit throws.
 */
import AdmZip from "adm-zip";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isMissingPathError } from "../../lib/atomic-file.js";
import { writeFileAtomicAtPath } from "../../main/storage/feature-namespace.js";
import type { McpServerConfig, ValidationResult } from "../../mcp/types.js";
import { parseMcpRuntimeSpec } from "../../plugins/mcp-runtime-spec.js";
import { assertSafeArtifactSlug } from "../../plugins/plugin-id.js";
import { isResolvedPathWithin } from "../../plugins/plugin-storage-containment.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MarketplaceError } from "../errors.js";
import { classifyInstall, type InstallAction } from "../resolve/identity.js";
import { mcpRuntimeConfig, type ResolvedMcpServer } from "../resolve/mcp.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { OriginReader } from "../sources/retained.js";
import { isSourcePin } from "../sources/source-tree.js";
import type { InstalledRecord, McpInstallerPort } from "./ports.js";
import { mcpConsent } from "../updates/consent.js";
import { parseConsentFingerprint, type ConsentFingerprint } from "../updates/consent-record.js";
import { isRecord } from "../../shared/is-record.js";

interface McpOrigin {
  sourceId: string;
  sourceOrigin: SourceOrigin;
  /** The snapshot commit the install plan was bound to (kept by snapshot pruning). */
  commit: string;
  packagePath: string;
  from: ResolvedMcpServer["from"];
  /** Tree digest of the installed `server/` files; null when the server runs no package files. */
  filesDigest: string | null;
  installedAt: string;
}

interface McpRecord {
  name: string;
  /** Null for a server installed from a pasted server.json whose version is not tracked. */
  version: string | null;
  /** The spec before token substitution: what the user approved, and what a failed update restores. */
  runtime: McpRuntimeSpec;
  hasFiles: boolean;
  /** Null for a server bound to no source (design §8.1). */
  origin: McpOrigin | null;
  /** The consent fingerprint accepted with this install (§18.7.3); absent on a record from before slice F. */
  consent?: ConsentFingerprint;
}

interface RecordFile {
  version: 1;
  servers: McpRecord[];
}

const SOURCE_ORIGINS = new Set<SourceOrigin>(["official", "managed", "custom", "direct"]);
const RECORD_KEYS = new Set(["name", "version", "runtime", "hasFiles", "origin", "consent"]);
const ORIGIN_KEYS = new Set(["sourceId", "sourceOrigin", "commit", "packagePath", "from", "filesDigest", "installedAt"]);

function parseRecords(text: string, path: string): McpRecord[] {
  const fail = (why: string): never => {
    throw new Error(`${path}: ${why}`);
  };
  const value = parseStrictJson(text);
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.servers)) return fail("not an MCP install record file");
  if (Object.keys(value).some((key) => key !== "version" && key !== "servers")) fail("unknown field");
  const seen = new Set<string>();
  return (value.servers as unknown[]).map((entry, index) => {
    const at = `servers[${index}]`;
    if (!isRecord(entry) || Object.keys(entry).some((key) => !RECORD_KEYS.has(key))) return fail(`${at} is malformed`);
    if (typeof entry.name !== "string") return fail(`${at}.name is missing`);
    try {
      assertSafeArtifactSlug(entry.name);
    } catch {
      fail(`${at}.name is not a server name`);
    }
    if (entry.version !== null && (typeof entry.version !== "string" || entry.version.length === 0)) fail(`${at}.version is malformed`);
    const runtime = parseMcpRuntimeSpec(entry.runtime);
    if (!runtime) return fail(`${at}.runtime is not an MCP runtime`);
    if (typeof entry.hasFiles !== "boolean") fail(`${at}.hasFiles is missing`);
    const origin = entry.origin;
    if (origin !== null) {
      if (!isRecord(origin) || Object.keys(origin).some((key) => !ORIGIN_KEYS.has(key))
        || typeof origin.sourceId !== "string" || origin.sourceId.length === 0
        || !SOURCE_ORIGINS.has(origin.sourceOrigin as SourceOrigin)
        || !isSourcePin(origin.commit)
        || typeof origin.packagePath !== "string"
        || (origin.from !== "descriptor" && origin.from !== "server.json")
        || (origin.filesDigest !== null && (typeof origin.filesDigest !== "string" || !/^[0-9a-f]{64}$/u.test(origin.filesDigest)))
        || typeof origin.installedAt !== "string") {
        fail(`${at}.origin is malformed`);
      }
    }
    let consent: ConsentFingerprint | undefined;
    if (entry.consent !== undefined) {
      consent = parseConsentFingerprint(entry.consent, `${path}: ${at}.consent`);
      if (consent.kind !== "mcp") fail(`${at}.consent is not an MCP server's`);
    }
    if (seen.has(entry.name)) fail(`${entry.name} is recorded twice`);
    seen.add(entry.name);
    return { ...(entry as unknown as McpRecord), runtime, ...(consent ? { consent } : {}) };
  });
}

async function readRecords(path: string): Promise<McpRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  return parseRecords(text, path);
}

/** Origins of installed MCP servers, for snapshot retention (design §2.3) and revocations (§10.4). */
export function mcpInstallOrigins(recordsPath: string): OriginReader {
  return async () => (await readRecords(recordsPath)).flatMap((record) => (record.origin ? [{ kind: "mcp" as const, name: record.name, sourceId: record.origin.sourceId, commit: record.origin.commit }] : []));
}

export interface McpInstallerDeps {
  /** `~/.ave/packages/mcp-installs.json`. */
  recordsPath: string;
  /** `~/.ave/mcp-data`: each server's `$DATA_DIR` is `<dataRoot>/<name>`. */
  dataRoot: string;
  /** The MCP artifact store over `~/.ave/mcp`: safe extraction and a directory swap that restores on failure. */
  files: {
    installDirFor(name: string): string;
    extractZipWithCommit<T>(name: string, zipBuffer: Buffer, commit: (installDir: string, files: string[]) => Promise<T>): Promise<{ result: T }>;
  };
  manager: {
    getConfigs(): Promise<ReadonlyArray<{ id: string }>>;
    /** Saves the config, then connects; a failed connection keeps the config and says why. */
    addConfig(config: McpServerConfig): Promise<{ connected: boolean; warning?: string }>;
    removeConfig(id: string): Promise<void>;
    /** The governance decision `addConfig` applies, asked before anything is written. */
    validateConfig(config: McpServerConfig): ValidationResult;
  };
  /** `$NODE`. */
  nodePath: string;
  now?: () => Date;
}

/** Zip entries whose mode carries an execute bit: the artifact store writes files without their mode. */
function executableEntries(zipBuffer: Buffer): string[] {
  return new AdmZip(zipBuffer)
    .getEntries()
    .filter((entry) => !entry.isDirectory && ((entry.attr >>> 16) & 0o111) !== 0)
    .map((entry) => entry.entryName);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

export class McpInstaller implements McpInstallerPort {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: McpInstallerDeps) {}

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private dataDir(name: string): string {
    return join(this.deps.dataRoot, assertSafeArtifactSlug(name));
  }

  private configFor(record: Pick<McpRecord, "name" | "runtime">): McpServerConfig {
    return mcpRuntimeConfig(record.name, record.runtime, {
      installDir: this.deps.files.installDirFor(record.name),
      dataDir: this.dataDir(record.name),
      nodePath: this.deps.nodePath,
    });
  }

  /**
   * The consent baseline of an installed server (§18.7.3): the stored
   * fingerprint, or one computed from its recorded runtime for a record
   * from before slice F. Null when this installer does not own `name`.
   */
  async baseline(name: string): Promise<ConsentFingerprint | null> {
    const record = (await readRecords(this.deps.recordsPath)).find((item) => item.name === name);
    if (!record) return null;
    return record.consent ?? mcpConsent(record.runtime);
  }

  admit(name: string, runtime: McpRuntimeSpec): void {
    const decision = this.deps.manager.validateConfig(this.configFor({ name: assertSafeArtifactSlug(name), runtime }));
    if (!decision.valid) {
      throw new MarketplaceError("PACKAGE_POLICY_BLOCKED", `the MCP governance policy does not allow ${name} (layer ${decision.layer}): ${decision.reason}`);
    }
  }

  private async write(records: McpRecord[]): Promise<void> {
    const file: RecordFile = { version: 1, servers: records };
    await writeFileAtomicAtPath(this.deps.recordsPath, `${JSON.stringify(file, null, 2)}\n`);
  }

  /** The record for `name`; PACKAGE_ID_CONFLICT when the MCP config holds a server by that name this installer did not install. */
  private async owned(name: string): Promise<{ records: McpRecord[]; current: McpRecord | null }> {
    const records = await readRecords(this.deps.recordsPath);
    const current = records.find((record) => record.name === name) ?? null;
    if (!current && (await this.deps.manager.getConfigs()).some((config) => config.id === name)) {
      throw new MarketplaceError("PACKAGE_ID_CONFLICT", `an MCP server named ${name} is already configured; remove it in MCP settings first`);
    }
    return { records, current };
  }

  /** Replace the config of `previous` with `next`; a failed add puts the previous one back. */
  private async swapConfig(previous: McpRecord | null, next: McpServerConfig): Promise<string | null> {
    if (previous) await this.deps.manager.removeConfig(previous.name);
    try {
      const added = await this.deps.manager.addConfig(next);
      return added.connected ? null : added.warning ?? "the server did not connect";
    } catch (error) {
      if (previous) await this.deps.manager.addConfig(this.configFor(previous));
      throw error;
    }
  }

  /** Register `record`, swapping its files first when it has any, and write the record file last. */
  /** Returns the first connection's failure, when there was one. */
  private async apply(records: McpRecord[], previous: McpRecord | null, record: McpRecord, zipBuffer: Buffer | null): Promise<string | null> {
    this.admit(record.name, record.runtime);
    const dataDir = this.dataDir(record.name);
    const createdDataDir = !(await exists(dataDir));
    await mkdir(dataDir, { recursive: true });
    try {
      return await this.register(records, previous, record, zipBuffer);
    } catch (error) {
      // A failed first install leaves no data directory behind; an existing one is the server's data.
      if (createdDataDir) await rm(dataDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async register(records: McpRecord[], previous: McpRecord | null, record: McpRecord, zipBuffer: Buffer | null): Promise<string | null> {
    const next = records.filter((item) => item.name !== record.name).concat(record);
    const register = async (): Promise<string | null> => {
      const connectionWarning = await this.swapConfig(previous, this.configFor(record));
      try {
        await this.write(next);
      } catch (error) {
        await this.deps.manager.removeConfig(record.name);
        if (previous) await this.deps.manager.addConfig(this.configFor(previous));
        throw error;
      }
      return connectionWarning;
    };
    if (zipBuffer) {
      const executables = executableEntries(zipBuffer);
      const { result } = await this.deps.files.extractZipWithCommit(record.name, zipBuffer, async (installDir, files) => {
        // The mode bits come from the zip, but only for a file extraction wrote as named, inside the install directory.
        const extracted = new Set(files);
        for (const entry of executables) {
          const target = resolve(installDir, entry);
          if (!extracted.has(entry) || !isResolvedPathWithin(installDir, target)) {
            throw new Error(`MCP server ${record.name}: executable zip entry ${JSON.stringify(entry)} was not extracted as named`);
          }
          await chmod(target, 0o755);
        }
        return register();
      });
      return result;
    }
    const connectionWarning = await register();
    // The new version runs no package files; the previous version's go.
    if (previous?.hasFiles) await rm(this.deps.files.installDirFor(record.name), { recursive: true, force: true });
    return connectionWarning;
  }

  list(): Promise<InstalledRecord[]> {
    return readRecords(this.deps.recordsPath).then((records) =>
      records.map((record) => ({
        kind: "mcp" as const,
        name: record.name,
        version: record.version,
        sourceId: record.origin?.sourceId ?? null,
        originCommit: record.origin?.commit ?? null,
      })),
    );
  }

  install(resolved: ResolvedMcpServer, options: { switchSource: boolean }): Promise<{ action: InstallAction; connectionWarning: string | null }> {
    return this.serial(async () => {
      const { plan } = resolved;
      const { records, current } = await this.owned(plan.name);
      const action = classifyInstall(
        plan,
        current ? { kind: "mcp", name: current.name, version: current.version, sourceId: current.origin?.sourceId ?? null } : null,
        { switchSource: options.switchSource },
      );
      const record: McpRecord = {
        name: plan.name,
        version: plan.version,
        runtime: resolved.runtime,
        hasFiles: resolved.packageFiles !== null,
        // The baseline the next update is compared with: the command the user accepted (§18.7.3).
        consent: mcpConsent(resolved.runtime),
        origin: {
          sourceId: plan.sourceId,
          sourceOrigin: plan.sourceOrigin,
          commit: plan.snapshotCommit,
          packagePath: plan.packagePath,
          from: resolved.from,
          filesDigest: resolved.packageFiles?.digest ?? null,
          installedAt: (this.deps.now?.() ?? new Date()).toISOString(),
        },
      };
      const connectionWarning = await this.apply(records, current, record, resolved.packageFiles?.zipBuffer ?? null);
      return { action, connectionWarning };
    });
  }

  installUnbound(name: string, runtime: McpRuntimeSpec): Promise<{ connectionWarning: string | null }> {
    return this.serial(async () => {
      const { records, current } = await this.owned(assertSafeArtifactSlug(name));
      if (current?.origin) {
        throw new MarketplaceError("PACKAGE_ID_CONFLICT", `MCP server ${name} is installed from ${current.origin.sourceId}; uninstall it first`);
      }
      return { connectionWarning: await this.apply(records, current, { name, version: null, runtime, hasFiles: false, origin: null }, null) };
    });
  }

  uninstall(name: string, options: { removeData: boolean }): Promise<{ keptDataDir: string | null }> {
    return this.serial(async () => {
      const records = await readRecords(this.deps.recordsPath);
      const current = records.find((record) => record.name === name);
      if (!current) throw new MarketplaceError("PACKAGE_ID_CONFLICT", `MCP server ${name} was not installed from the marketplace`);
      await this.deps.manager.removeConfig(name);
      try {
        await this.write(records.filter((record) => record !== current));
      } catch (error) {
        // The record still says installed, so the server keeps its config too.
        await this.deps.manager.addConfig(this.configFor(current));
        throw error;
      }
      if (current.hasFiles) await rm(this.deps.files.installDirFor(name), { recursive: true, force: true });
      const dataDir = this.dataDir(name);
      if (options.removeData) {
        await rm(dataDir, { recursive: true, force: true });
        return { keptDataDir: null };
      }
      return { keptDataDir: (await exists(dataDir)) ? dataDir : null };
    });
  }
}
