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
import type { McpServerConfig } from "../../mcp/types.js";
import { parseMcpRuntimeSpec } from "../../plugins/mcp-runtime-spec.js";
import { assertSafeArtifactSlug } from "../../plugins/plugin-id.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MarketplaceError } from "../errors.js";
import { classifyInstall, type InstallAction } from "../resolve/identity.js";
import { mcpRuntimeConfig, type ResolvedMcpServer } from "../resolve/mcp.js";
import type { SourceOrigin } from "../sources/registry.js";
import type { OriginReader } from "../sources/retained.js";
import type { InstalledRecord, McpInstallerPort } from "./ports.js";

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
}

interface RecordFile {
  version: 1;
  servers: McpRecord[];
}

const SOURCE_ORIGINS = new Set<SourceOrigin>(["official", "managed", "custom", "direct"]);
const RECORD_KEYS = new Set(["name", "version", "runtime", "hasFiles", "origin"]);
const ORIGIN_KEYS = new Set(["sourceId", "sourceOrigin", "commit", "packagePath", "from", "filesDigest", "installedAt"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
        || typeof origin.commit !== "string" || !/^[0-9a-f]{40}$/u.test(origin.commit)
        || typeof origin.packagePath !== "string"
        || (origin.from !== "descriptor" && origin.from !== "server.json")
        || (origin.filesDigest !== null && (typeof origin.filesDigest !== "string" || !/^[0-9a-f]{64}$/u.test(origin.filesDigest)))
        || typeof origin.installedAt !== "string") {
        fail(`${at}.origin is malformed`);
      }
    }
    if (seen.has(entry.name)) fail(`${entry.name} is recorded twice`);
    seen.add(entry.name);
    return { ...(entry as unknown as McpRecord), runtime };
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

/** Origins of installed MCP servers, for snapshot retention (design §2.3). */
export function mcpInstallOrigins(recordsPath: string): OriginReader {
  return async () => (await readRecords(recordsPath)).flatMap((record) => (record.origin ? [{ sourceId: record.origin.sourceId, commit: record.origin.commit }] : []));
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
    addConfig(config: McpServerConfig): Promise<unknown>;
    removeConfig(id: string): Promise<void>;
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
  private async swapConfig(previous: McpRecord | null, next: McpServerConfig): Promise<void> {
    if (previous) await this.deps.manager.removeConfig(previous.name);
    try {
      await this.deps.manager.addConfig(next);
    } catch (error) {
      if (previous) await this.deps.manager.addConfig(this.configFor(previous));
      throw error;
    }
  }

  /** Register `record`, swapping its files first when it has any, and write the record file last. */
  private async apply(records: McpRecord[], previous: McpRecord | null, record: McpRecord, zipBuffer: Buffer | null): Promise<void> {
    await mkdir(this.dataDir(record.name), { recursive: true });
    const next = records.filter((item) => item.name !== record.name).concat(record);
    const register = async () => {
      await this.swapConfig(previous, this.configFor(record));
      try {
        await this.write(next);
      } catch (error) {
        await this.deps.manager.removeConfig(record.name);
        if (previous) await this.deps.manager.addConfig(this.configFor(previous));
        throw error;
      }
    };
    if (zipBuffer) {
      const executables = executableEntries(zipBuffer);
      await this.deps.files.extractZipWithCommit(record.name, zipBuffer, async (installDir) => {
        for (const entry of executables) await chmod(resolve(installDir, entry), 0o755);
        await register();
      });
      return;
    }
    await register();
    // The new version runs no package files; the previous version's go.
    if (previous?.hasFiles) await rm(this.deps.files.installDirFor(record.name), { recursive: true, force: true });
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

  install(resolved: ResolvedMcpServer, options: { switchSource: boolean }): Promise<{ action: InstallAction }> {
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
      await this.apply(records, current, record, resolved.packageFiles?.zipBuffer ?? null);
      return { action };
    });
  }

  installUnbound(name: string, runtime: McpRuntimeSpec): Promise<void> {
    return this.serial(async () => {
      const { records, current } = await this.owned(assertSafeArtifactSlug(name));
      if (current?.origin) {
        throw new MarketplaceError("PACKAGE_ID_CONFLICT", `MCP server ${name} is installed from ${current.origin.sourceId}; uninstall it first`);
      }
      await this.apply(records, current, { name, version: null, runtime, hasFiles: false, origin: null }, null);
    });
  }

  uninstall(name: string, options: { removeData: boolean }): Promise<{ keptDataDir: string | null }> {
    return this.serial(async () => {
      const records = await readRecords(this.deps.recordsPath);
      const current = records.find((record) => record.name === name);
      if (!current) throw new MarketplaceError("PACKAGE_ID_CONFLICT", `MCP server ${name} was not installed from the marketplace`);
      await this.deps.manager.removeConfig(name);
      await this.write(records.filter((record) => record !== current));
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
