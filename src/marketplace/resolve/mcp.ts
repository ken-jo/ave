/**
 * MCP packages (design §5.2): a descriptor's `server` spec, or the official
 * MCP `server.json` next to it, becomes the host's MCP runtime spec. The
 * existing approval step shows that spec, and the existing MCP config
 * install registers it.
 *
 * `server.json` (schema 2025-12-11) maps like this; anything else is refused
 * rather than guessed:
 *
 *   npm    → npx [runtimeArguments] -y <identifier>@<version> [packageArguments]
 *   pypi   → uvx [runtimeArguments] <identifier>==<version> [packageArguments]
 *   oci    → docker run -i --rm [runtimeArguments] <identifier>[:<version>] [packageArguments]
 *   remote → streamable-http only
 *
 * Refused: sse, other registries or a non-default registry base URL, a
 * package whose transport is not stdio, `{variable}` templates, a required
 * argument or variable without a value, and more than one secret (the host
 * stores exactly one per server: `apiKeyEnv` or `apiKeyHeader`).
 *
 * The executed code is bound to the plan like a plugin's: npx and uvx
 * packages carry an exact version, and a docker image a tag other than
 * `latest` or a digest. A
 * package-local stdio command (`server/…`) runs from files exported at the
 * version's commit.
 */
import AdmZip from "adm-zip";
import type { MarketplaceArtifactLimits } from "../../plugins/marketplace-artifact-limits.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import type { McpServerConfig } from "../../mcp/types.js";
import { buildMcpServerConfig, substituteRuntimeTokens } from "../../mcp/mcp-marketplace-install.js";
import { ENV_NAME_RE, HTTP_HEADER_NAME_RE, MAX_NAME_LEN, RESERVED_ENV_NAMES, RESERVED_HEADERS } from "../../mcp/safe-names.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogRow } from "../catalog/aggregate.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MarketplaceError } from "../errors.js";
import { candidateVersion, planPackage, readDescriptorAtVersion, repoPath, type PackagePlan, type RepositoryAccess } from "./descriptor.js";
import { treeDigest } from "./plugin-ladder.js";

export interface McpInstallPlan extends PackagePlan {
  kind: "mcp";
}

export interface ResolvedMcpServer {
  plan: McpInstallPlan;
  /** Where the spec came from. */
  from: "descriptor" | "server.json";
  /** Before `$PLUGIN_DIR`/`$NODE` substitution; this is what the approval step shows. */
  runtime: McpRuntimeSpec;
  /** The package's `server/` files for a package-local command, zipped for the MCP artifact store; null otherwise. */
  packageFiles: { zipBuffer: Buffer; digest: string } | null;
}

export interface McpResolveDeps extends RepositoryAccess {
  limits: Readonly<MarketplaceArtifactLimits>;
  /** Scratch directory for the `server/` export; removed before resolve returns. */
  workRoot: string;
}

const SERVER_JSON_LIMIT = 256 * 1024;
const LAUNCHERS = new Set(["npx", "uvx", "docker"]);
const TEMPLATE = /\{[^{}]+\}/u;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const EXACT_PYPI_VERSION = /^[0-9][0-9A-Za-z.!+_-]*$/u;
const DEFAULT_REGISTRIES: Record<string, string> = {
  npm: "https://registry.npmjs.org",
  pypi: "https://pypi.org",
  oci: "https://docker.io",
};

function refuse(message: string): MarketplaceError {
  return new MarketplaceError("CONTENT_RULE_VIOLATION", message);
}

export function planMcpInstall(row: CatalogRow): McpInstallPlan {
  if (row.kind !== "mcp") throw new Error(`${row.kind} ${row.name} is not an MCP server`);
  return { ...planPackage(row, candidateVersion(row)), kind: "mcp" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw refuse(`${what} is not a string`);
  if (TEMPLATE.test(value)) throw refuse(`${what} uses a {variable} template, which Ave does not fill in`);
  return value;
}

/** An input's fixed value: `value`, else `default`; a required input without either is refused. */
function inputValue(input: Record<string, unknown>, what: string): string | undefined {
  if (isRecord(input.variables) && Object.keys(input.variables).length > 0) {
    throw refuse(`${what} uses variables, which Ave does not fill in`);
  }
  const value = stringOrUndefined(input.value, `${what} value`) ?? stringOrUndefined(input.default, `${what} default`);
  if (value === undefined && input.isRequired === true) throw refuse(`${what} is required and has no value`);
  return value;
}

function argumentsOf(list: unknown, what: string): string[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw refuse(`${what} is not a list`);
  const out: string[] = [];
  for (const [index, item] of list.entries()) {
    if (!isRecord(item)) throw refuse(`${what}[${index}] is not an object`);
    const value = inputValue(item, `${what}[${index}]`);
    if (item.type === "positional") {
      if (value !== undefined) out.push(value);
    } else if (item.type === "named") {
      const name = stringOrUndefined(item.name, `${what}[${index}].name`);
      if (!name) throw refuse(`${what}[${index}] has no name`);
      if (value !== undefined) out.push(name, value);
      else if (item.isRequired === true) throw refuse(`${what}[${index}] is required and has no value`);
    } else {
      throw refuse(`${what}[${index}] has an unknown type`);
    }
  }
  return out;
}

interface Secrets {
  env: Record<string, string>;
  secret: string | undefined;
}

function keyValues(list: unknown, what: string, nameOk: (name: string) => boolean): Secrets {
  const out: Secrets = { env: {}, secret: undefined };
  if (list === undefined) return out;
  if (!Array.isArray(list)) throw refuse(`${what} is not a list`);
  for (const [index, item] of list.entries()) {
    if (!isRecord(item) || typeof item.name !== "string") throw refuse(`${what}[${index}] has no name`);
    const name = item.name;
    if (!nameOk(name)) throw refuse(`${what} ${name} is not allowed`);
    if (item.isSecret === true) {
      if (out.secret) throw refuse(`${what} declares more than one secret (${out.secret}, ${name}); Ave stores one per server`);
      out.secret = name;
      continue;
    }
    const value = inputValue(item, `${what} ${name}`);
    if (value !== undefined) out.env[name] = value;
  }
  return out;
}

const envNameOk = (name: string) => name.length <= MAX_NAME_LEN && ENV_NAME_RE.test(name) && !RESERVED_ENV_NAMES.has(name.toUpperCase());
const headerNameOk = (name: string) => name.length <= MAX_NAME_LEN && HTTP_HEADER_NAME_RE.test(name) && !RESERVED_HEADERS.has(name.toLowerCase());

function packageRuntime(pkg: Record<string, unknown>): McpRuntimeSpec {
  const registryType = pkg.registryType;
  if (typeof registryType !== "string" || !Object.hasOwn(DEFAULT_REGISTRIES, registryType)) {
    throw refuse(`server.json package registry ${String(registryType)} is not supported (npm, pypi or oci)`);
  }
  const base = stringOrUndefined(pkg.registryBaseUrl, "registryBaseUrl");
  if (base !== undefined && base.replace(/\/+$/u, "") !== DEFAULT_REGISTRIES[registryType]) {
    throw refuse(`server.json package registry ${base} is not the default ${registryType} registry`);
  }
  const transport = pkg.transport;
  if (!isRecord(transport) || transport.type !== "stdio") throw refuse("a server.json package must use the stdio transport");
  const identifier = stringOrUndefined(pkg.identifier, "identifier");
  if (!identifier || /\s/u.test(identifier)) throw refuse("server.json package has no usable identifier");
  const version = stringOrUndefined(pkg.version, "version");
  const runtimeArgs = argumentsOf(pkg.runtimeArguments, "runtimeArguments");
  const packageArgs = argumentsOf(pkg.packageArguments, "packageArguments");
  const { env, secret } = keyValues(pkg.environmentVariables, "environment variable", envNameOk);
  let command: string;
  let args: string[];
  if (registryType === "npm") {
    if (!version || !EXACT_SEMVER.test(version)) throw refuse(`npm package ${identifier} needs an exact version`);
    command = "npx";
    args = [...runtimeArgs, "-y", `${identifier}@${version}`, ...packageArgs];
  } else if (registryType === "pypi") {
    if (!version || !EXACT_PYPI_VERSION.test(version)) throw refuse(`pypi package ${identifier} needs an exact version`);
    command = "uvx";
    args = [...runtimeArgs, `${identifier}==${version}`, ...packageArgs];
  } else {
    const tagged = /[:@][^/]+$/u.test(identifier);
    const image = tagged ? identifier : `${identifier}:${version ?? ""}`;
    if ((!tagged && !version) || image.endsWith(":latest")) throw refuse(`oci image ${identifier} needs a fixed tag or a digest`);
    command = "docker";
    args = ["run", "-i", "--rm", ...runtimeArgs, image, ...packageArgs];
  }
  const spec: McpRuntimeSpec = { transport: "stdio", command, args };
  if (Object.keys(env).length > 0) spec.env = env;
  if (secret) {
    spec.auth = "api-key";
    spec.apiKeyEnv = secret;
  }
  return spec;
}

function remoteRuntime(remote: Record<string, unknown>): McpRuntimeSpec {
  if (remote.type !== "streamable-http") throw refuse(`server.json remote type ${String(remote.type)} is not supported (streamable-http only)`);
  const url = stringOrUndefined(remote.url, "remote url");
  if (!url || !/^https:\/\/\S+$/u.test(url)) throw refuse("server.json remote url must be https");
  const { env: headers, secret } = keyValues(remote.headers, "header", headerNameOk);
  if (Object.keys(headers).length > 0) throw refuse("server.json remote headers with fixed values are not supported");
  const spec: McpRuntimeSpec = { transport: "http", url };
  if (secret) {
    spec.auth = "api-key";
    spec.apiKeyHeader = secret;
  }
  return spec;
}

/** The runtime spec a `server.json` describes, for the selected package or remote. */
export function runtimeFromServerJson(document: unknown, select: { package?: number; remote?: number } | undefined): McpRuntimeSpec {
  if (!isRecord(document)) throw refuse("server.json is not an object");
  const packages = Array.isArray(document.packages) ? document.packages : [];
  const remotes = Array.isArray(document.remotes) ? document.remotes : [];
  if (select?.package !== undefined && select.remote !== undefined) throw refuse("select names both a package and a remote");
  if (select?.remote !== undefined) {
    const remote = remotes[select.remote];
    if (!isRecord(remote)) throw refuse(`server.json has no remote ${select.remote}`);
    return remoteRuntime(remote);
  }
  const packageIndex = select?.package ?? (packages.length > 0 ? 0 : undefined);
  if (packageIndex !== undefined) {
    const pkg = packages[packageIndex];
    if (!isRecord(pkg)) throw refuse(`server.json has no package ${packageIndex}`);
    return packageRuntime(pkg);
  }
  const [remote] = remotes;
  if (!isRecord(remote)) throw refuse("server.json declares no package and no remote");
  return remoteRuntime(remote);
}

/** The descriptor's own spec (already schema-checked) as the host runtime spec. */
function runtimeFromDescriptor(server: Record<string, unknown>): McpRuntimeSpec {
  if (server.transport === "stdio") {
    const spec: McpRuntimeSpec = { transport: "stdio", command: server.command as string };
    if (Array.isArray(server.args) && server.args.length > 0) spec.args = [...(server.args as string[])];
    if (isRecord(server.env) && Object.keys(server.env).length > 0) spec.env = { ...(server.env as Record<string, string>) };
    if (typeof server.auth === "string") spec.auth = server.auth as "none" | "api-key" | "sso";
    if (typeof server.apiKeyEnv === "string") spec.apiKeyEnv = server.apiKeyEnv;
    return spec;
  }
  const spec: McpRuntimeSpec = { transport: "http", url: server.url as string };
  if (typeof server.auth === "string") spec.auth = server.auth as "none" | "api-key" | "sso" | "oauth";
  if (typeof server.apiKeyHeader === "string") spec.apiKeyHeader = server.apiKeyHeader;
  return spec;
}

function packageSpecAfter(args: readonly string[], skip: ReadonlySet<string>): string | undefined {
  return args.find((arg) => !arg.startsWith("-") && !skip.has(arg));
}

/**
 * The launched code must be fixed by the commit, not by whatever a registry
 * serves later. For a descriptor's own spec the package (npx, uvx) or image
 * (docker) is the first argument that is not an option, so options before it
 * use the `--name=value` form. A `server.json` spec is pinned as it is built.
 */
export function assertMcpRuntimePinned(name: string, spec: McpRuntimeSpec): void {
  if (spec.transport !== "stdio" || !LAUNCHERS.has(spec.command)) return;
  const args = spec.args ?? [];
  if (spec.command === "npx") {
    const target = packageSpecAfter(args, new Set());
    if (!target || !/^(?:@[^@/\s]+\/)?[^@/\s]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(target)) {
      throw refuse(`MCP server ${name}: npx must run <package>@<exact version>`);
    }
  } else if (spec.command === "uvx") {
    const from = args.indexOf("--from");
    const target = from >= 0 ? args[from + 1] : packageSpecAfter(args, new Set());
    if (!target || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?===?[A-Za-z0-9][A-Za-z0-9.!+_*~-]*$/u.test(target)) {
      throw refuse(`MCP server ${name}: uvx must run <package>==<exact version>`);
    }
  } else {
    const run = args.indexOf("run");
    const image = run >= 0 ? args.slice(run + 1).find((arg) => !arg.startsWith("-")) : undefined;
    if (!image || !(/@sha256:[0-9a-f]{64}$/u.test(image) || (/:[^/:@]+$/u.test(image) && !image.endsWith(":latest")))) {
      throw refuse(`MCP server ${name}: docker must run an image with a fixed tag or a digest`);
    }
  }
}

function usesToken(spec: McpRuntimeSpec, token: string): boolean {
  if (spec.transport !== "stdio") return false;
  return [spec.command, ...(spec.args ?? []), ...Object.values(spec.env ?? {})].some((value) => value.includes(token));
}

async function exportServerFiles(plan: McpInstallPlan, deps: McpResolveDeps): Promise<{ zipBuffer: Buffer; digest: string }> {
  const dest = await mkdtemp(join(deps.workRoot, "mcp-"));
  try {
    const exported = await deps.repo.exportPath(
      deps.remote,
      plan.versionCommit,
      repoPath(plan.packagePath, "server"),
      dest,
      { maxFiles: deps.limits.maxEntryCount, maxBytes: deps.limits.maxTotalUncompressedBytes },
      deps.signal,
    );
    const files = [];
    for (const file of exported) {
      files.push({ path: `server/${file.path}`, data: await readFile(join(dest, ...file.path.split("/"))), executable: file.executable });
    }
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.path, file.data, "", file.executable ? 0o755 << 16 : 0o644 << 16);
    return { zipBuffer: zip.toBuffer(), digest: treeDigest(files) };
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
}

/** Resolve an MCP package at the plan's commits into the spec the approval step shows. */
export async function resolveMcpPackage(plan: McpInstallPlan, deps: McpResolveDeps): Promise<ResolvedMcpServer> {
  const descriptor = await readDescriptorAtVersion(plan, deps);
  const payload = descriptor.payload;
  let runtime: McpRuntimeSpec;
  let from: ResolvedMcpServer["from"];
  if (isRecord(payload.server)) {
    runtime = runtimeFromDescriptor(payload.server);
    from = "descriptor";
  } else {
    const path = repoPath(plan.packagePath, "server.json");
    await deps.repo.ensureBlobs(deps.remote, plan.versionCommit, [path], deps.signal);
    const bytes = await deps.repo.readFile(plan.versionCommit, path, SERVER_JSON_LIMIT);
    if (!bytes) throw refuse(`${path} is missing at ${plan.versionCommit}`);
    let document: unknown;
    try {
      document = parseStrictJson(bytes.toString("utf8"));
    } catch (error) {
      throw refuse(`${path} does not parse: ${(error as Error).message}`);
    }
    runtime = runtimeFromServerJson(document, isRecord(payload.select) ? (payload.select as { package?: number; remote?: number }) : undefined);
    from = "server.json";
  }
  if (usesToken(runtime, "$PYTHON")) throw refuse(`MCP server ${plan.name} uses $PYTHON; Ave provides no Python runtime (use uvx)`);
  if (from === "descriptor") assertMcpRuntimePinned(plan.name, runtime);
  let packageFiles: ResolvedMcpServer["packageFiles"] = null;
  if (runtime.transport === "stdio" && !LAUNCHERS.has(runtime.command)) {
    // Validation allows only `server/…` here (design §5.2); it runs from the exported files.
    packageFiles = await exportServerFiles(plan, deps);
    const command = runtime.command;
    if (!packageFiles || !new AdmZip(packageFiles.zipBuffer).getEntry(command)) {
      throw refuse(`MCP server ${plan.name}: ${command} is not a file in the package at ${plan.versionCommit}`);
    }
    runtime = { ...runtime, command: `$PLUGIN_DIR/${command}` };
  } else if (usesToken(runtime, "$PLUGIN_DIR")) {
    throw refuse(`MCP server ${plan.name} refers to $PLUGIN_DIR but ships no package files`);
  }
  return { plan, from, runtime, packageFiles };
}

/** The MCP config to register, with `$PLUGIN_DIR` and `$NODE` filled in. */
export function mcpServerConfigFor(resolved: ResolvedMcpServer, installDir: string, nodePath: string): McpServerConfig {
  return buildMcpServerConfig(resolved.plan.name, substituteRuntimeTokens(resolved.runtime, { pluginDir: installDir, nodePath, pythonPath: "" }));
}
