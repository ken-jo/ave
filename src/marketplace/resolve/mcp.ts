/** Convert only supported server specs; refuse ambiguous templates, registries, transports and multiple secrets.
 * Launchers require pinned packages and restricted options; local commands use commit-bound server files. */
import AdmZip from "adm-zip";
import type { MarketplaceArtifactLimits } from "../../plugins/marketplace-artifact-limits.js";
import type { McpRuntimeSpec } from "../../plugins/types.js";
import type { McpServerConfig } from "../../mcp/types.js";
import { HTTP_HEADER_NAME_RE, MAX_NAME_LEN, RESERVED_HEADERS, isSafeMcpEnvironmentName } from "../../mcp/safe-names.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CatalogRow } from "../catalog/aggregate.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import { MarketplaceError } from "../errors.js";
import { candidateVersion, planPackage, readDescriptorAtVersion, repoPath, type PackagePlan, type RepositoryAccess } from "./descriptor.js";
import { treeDigest } from "./plugin-ladder.js";
import { isRecord } from "../../shared/is-record.js";

export interface McpInstallPlan extends PackagePlan {
  kind: "mcp";
}

export interface ResolvedMcpServer {
  plan: McpInstallPlan;
  from: "descriptor" | "server.json";
  /** Before `$PLUGIN_DIR`/`$DATA_DIR`/`$NODE` substitution; this is what the approval step shows. */
  runtime: McpRuntimeSpec;
  packageFiles: { zipBuffer: Buffer; digest: string } | null;
}

export interface McpResolveDeps extends RepositoryAccess {
  limits: Readonly<MarketplaceArtifactLimits>;
  workRoot: string;
}

const SERVER_JSON_LIMIT = 256 * 1024;
const LAUNCHERS = new Set(["npx", "uvx", "docker"]);
const TEMPLATE = /\{[^{}]+\}/u;
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const EXACT_PYPI_VERSION = /^[0-9][0-9A-Za-z.!+_-]*$/u;
/** Exact registry package versions only; URLs, paths and git specs are forbidden. */
const NPX_TARGET = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const UVX_TARGET = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?==[0-9][0-9A-Za-z.!+_-]*$/u;
const UVX_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const DOCKER_IMAGE = /^[a-z0-9][a-z0-9._-]*(?::\d+)?(?:\/[a-z0-9][a-z0-9._-]*)*(?::(?!latest$)[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}|@sha256:[0-9a-f]{64})$/u;
const DOCKER_HUB_HOSTS = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);
/** Block environment overrides of registries, indexes, proxies, trust, startup and container daemons. */
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

const envNameOk = isSafeMcpEnvironmentName;
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
  if (registryType !== "oci" && runtimeArgs.length > 0) {
    // npx and uvx options choose registries, indexes and extra packages.
    throw refuse(`server.json ${registryType} package ${identifier} declares runtimeArguments, which Ave does not pass to ${registryType === "npm" ? "npx" : "uvx"}`);
  }
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
    const host = imageRegistryHost(image);
    if (host !== null && !DOCKER_HUB_HOSTS.has(host)) throw refuse(`server.json oci image ${identifier} is not on the default oci registry`);
    command = "docker";
    args = ["run", "-i", "--rm", ...runtimeArgs, image, ...packageArgs];
  }
  const spec: McpRuntimeSpec = { transport: "stdio", command, args };
  if (Object.keys(env).length > 0) spec.env = env;
  if (secret) {
    spec.auth = "api-key";
    spec.apiKeyEnv = secret;
  }
  assertMcpRuntimePinned(identifier, spec);
  if (command === "docker" && dockerImageOf(identifier, args) !== args[3 + runtimeArgs.length]) {
    // A runtime argument must not become the image the declared one is passed to.
    throw refuse(`server.json oci package ${identifier}: runtimeArguments must be docker options, not an image`);
  }
  return spec;
}

function imageRegistryHost(image: string): string | null {
  const slash = image.indexOf("/");
  if (slash < 0) return null;
  const first = image.slice(0, slash);
  return first.includes(".") || first.includes(":") || first === "localhost" ? first.toLowerCase() : null;
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

/** Pre-image options may retain or narrow isolation, never widen it. */
function dockerOptionLength(args: readonly string[], index: number): number {
  const arg = args[index]!;
  if (["-i", "--interactive", "--rm", "--init", "-t", "--tty"].includes(arg)) return 1;
  const env = /^(?:-e|--env)(?:=(.*))?$/su.exec(arg);
  if (env) {
    const value = env[1] ?? args[index + 1];
    const name = value?.split("=", 1)[0];
    return name !== undefined && envNameOk(name) ? (env[1] === undefined ? 2 : 1) : 0;
  }
  const network = /^--network(?:=(.*))?$/su.exec(arg);
  if (network) {
    const value = network[1] ?? args[index + 1];
    return value === "none" || value === "bridge" ? (network[1] === undefined ? 2 : 1) : 0;
  }
  return 0;
}

/** Pin launcher code and restrict options before the package or image; later arguments belong to the server.
 * Environment overrides cannot redirect registry, proxy, trust or daemon configuration. */
export function assertMcpRuntimePinned(name: string, spec: McpRuntimeSpec): void {
  if (spec.transport !== "stdio") return;
  const envNames = [...Object.keys(spec.env ?? {}), ...(spec.apiKeyEnv ? [spec.apiKeyEnv] : [])];
  const badEnv = envNames.find((env) => !envNameOk(env));
  if (badEnv !== undefined) throw refuse(`MCP server ${name}: environment variable ${badEnv} is not allowed`);
  if (!LAUNCHERS.has(spec.command)) return;
  const args = spec.args ?? [];
  if (spec.command === "npx") {
    let index = 0;
    while (args[index] === "-y" || args[index] === "--yes") index += 1;
    const target = args[index];
    if (!target || !NPX_TARGET.test(target)) {
      throw refuse(`MCP server ${name}: npx must run <package>@<exact version>, with only -y before it`);
    }
  } else if (spec.command === "uvx") {
    const from = /^--from(?:=(.*))?$/su.exec(args[0] ?? "");
    const target = from ? (from[1] ?? args[1]) : args[0];
    const command = from ? args[from[1] === undefined ? 2 : 1] : undefined;
    if (!target || !UVX_TARGET.test(target) || (from && (!command || !UVX_COMMAND.test(command)))) {
      throw refuse(`MCP server ${name}: uvx must run <package>==<exact version>, with only --from before it`);
    }
  } else {
    dockerImageOf(name, args);
  }
}

function dockerImageOf(name: string, args: readonly string[]): string {
  let index = args[0] === "run" ? 1 : -1;
  while (index > 0 && index < args.length && args[index]!.startsWith("-")) {
    const length = dockerOptionLength(args, index);
    if (length === 0) throw refuse(`MCP server ${name}: docker must run an image with a fixed tag or a digest, and option ${args[index]} is not allowed`);
    index += length;
  }
  const image = index > 0 ? args[index] : undefined;
  if (!image || !DOCKER_IMAGE.test(image)) {
    throw refuse(`MCP server ${name}: docker must run an image with a fixed tag or a digest`);
  }
  return image;
}

/** A token ends where a name character cannot continue it: `$NODE_OPTIONS` is not `$NODE`. */
const RUNTIME_TOKEN = /\$(PLUGIN_DIR|DATA_DIR|NODE)(?![A-Za-z0-9_])/gu;

function usesToken(spec: McpRuntimeSpec, token: string): boolean {
  if (spec.transport !== "stdio") return false;
  return [spec.command, ...(spec.args ?? []), ...Object.values(spec.env ?? {})].some((value) => value.includes(token));
}

async function exportServerFiles(plan: McpInstallPlan, deps: McpResolveDeps): Promise<{ zipBuffer: Buffer; digest: string }> {
  const dest = await mkdtemp(join(deps.workRoot, "mcp-"));
  try {
    const exported = await deps.treeAt(plan.versionCommit).exportPath(
      repoPath(plan.packagePath, "server"),
      dest,
      { maxFiles: deps.limits.maxEntryCount, maxBytes: deps.limits.maxTotalUncompressedBytes },
    );
    const files = [];
    for (const file of exported) {
      files.push({ path: `server/${file.path}`, data: await readFile(join(dest, ...file.path.split("/"))), executable: file.executable });
    }
    const zip = new AdmZip();
    for (const file of files) zip.addFile(file.path, file.data, "", file.executable ? 0o755 : 0o644);
    return { zipBuffer: zip.toBuffer(), digest: treeDigest(files) };
  } finally {
    await rm(dest, { recursive: true, force: true });
  }
}

export function mcpPayloadReadsServerJson(payload: Record<string, unknown>): boolean {
  return !isRecord(payload.server);
}

export function parseServerJson(path: string, bytes: Buffer): unknown {
  try {
    return parseStrictJson(bytes.toString("utf8"));
  } catch (error) {
    throw refuse(`${path} does not parse: ${(error as Error).message}`);
  }
}

export interface DeclaredMcpServer {
  from: ResolvedMcpServer["from"];
  runtime: McpRuntimeSpec;
  packageCommand: string | null;
}

/** Install and publication checks share launcher validation for descriptor and server.json specs. */
export function declaredMcpServer(name: string, payload: Record<string, unknown>, serverJson: unknown): DeclaredMcpServer {
  let runtime: McpRuntimeSpec;
  let from: ResolvedMcpServer["from"];
  if (isRecord(payload.server)) {
    runtime = runtimeFromDescriptor(payload.server);
    from = "descriptor";
  } else {
    runtime = runtimeFromServerJson(serverJson, isRecord(payload.select) ? (payload.select as { package?: number; remote?: number }) : undefined);
    from = "server.json";
  }
  if (usesToken(runtime, "$PYTHON")) throw refuse(`MCP server ${name} uses $PYTHON; Ave provides no Python runtime (use uvx)`);
  if (runtime.transport !== "stdio" && JSON.stringify(runtime).includes("$DATA_DIR")) {
    throw refuse(`MCP server ${name}: $DATA_DIR is filled in only in a stdio server's arguments and environment`);
  }
  assertMcpRuntimePinned(name, runtime);
  // Non-launcher commands run only from exported server files.
  const packageCommand = runtime.transport === "stdio" && !LAUNCHERS.has(runtime.command) ? runtime.command : null;
  if (packageCommand === null && usesToken(runtime, "$PLUGIN_DIR")) {
    throw refuse(`MCP server ${name} refers to $PLUGIN_DIR but ships no package files`);
  }
  return { from, runtime, packageCommand };
}

export async function resolveMcpPackage(plan: McpInstallPlan, deps: McpResolveDeps): Promise<ResolvedMcpServer> {
  const descriptor = await readDescriptorAtVersion(plan, deps);
  const payload = descriptor.payload;
  let serverJson: unknown;
  if (mcpPayloadReadsServerJson(payload)) {
    const path = repoPath(plan.packagePath, "server.json");
    const tree = deps.treeAt(plan.versionCommit);
    await tree.ensure([path]);
    const bytes = await tree.readFile(path, SERVER_JSON_LIMIT);
    if (!bytes) throw refuse(`${path} is missing at ${plan.versionCommit}`);
    serverJson = parseServerJson(path, bytes);
  }
  const { from, runtime, packageCommand } = declaredMcpServer(plan.name, payload, serverJson);
  if (packageCommand === null || runtime.transport !== "stdio") return { plan, from, runtime, packageFiles: null };
  const packageFiles = await exportServerFiles(plan, deps);
  if (!new AdmZip(packageFiles.zipBuffer).getEntry(packageCommand)) {
    throw refuse(`MCP server ${plan.name}: ${packageCommand} is not a file in the package at ${plan.versionCommit}`);
  }
  return { plan, from, runtime: { ...runtime, command: `$PLUGIN_DIR/${packageCommand}` }, packageFiles };
}

export interface McpServerDirs {
  /** Installed package files are replaced on update. */
  installDir: string;
  /** Package data survives updates. */
  dataDir: string;
  nodePath: string;
}

export function mcpServerConfigFor(resolved: ResolvedMcpServer, dirs: McpServerDirs): McpServerConfig {
  return mcpRuntimeConfig(resolved.plan.name, resolved.runtime, dirs);
}

export function mcpRuntimeConfig(name: string, runtime: McpRuntimeSpec, dirs: McpServerDirs): McpServerConfig {
  if (runtime.transport !== "stdio") return buildMcpServerConfig(name, { ...runtime });
  const values = { PLUGIN_DIR: dirs.installDir, DATA_DIR: dirs.dataDir, NODE: dirs.nodePath } as const;
  // One pass with a function replacer: a filled-in path is never rescanned for
  // tokens, and `$&`/`$$` in it stay literal.
  const fill = (value: string): string => value.replace(RUNTIME_TOKEN, (_match, token: keyof typeof values) => values[token]);
  return buildMcpServerConfig(name, {
    ...runtime,
    command: fill(runtime.command),
    ...(runtime.args ? { args: runtime.args.map(fill) } : {}),
    ...(runtime.env ? { env: Object.fromEntries(Object.entries(runtime.env).map(([key, value]) => [key, fill(value)])) } : {}),
  });
}

function buildMcpServerConfig(slug: string, runtime: McpRuntimeSpec): McpServerConfig {
  if (runtime.transport === "stdio") {
    const config: McpServerConfig = {
      id: slug,
      transport: "stdio",
      command: runtime.command,
      args: runtime.args,
      env: runtime.env,
      auth: runtime.auth ?? "none",
    };
    if (runtime.apiKeyEnv) {
      config.apiKeyEnv = runtime.apiKeyEnv;
    }
    return config;
  }
  const config: McpServerConfig = {
    id: slug,
    transport: "http",
    url: runtime.url,
    auth: runtime.auth ?? "none",
  };
  if (runtime.apiKeyHeader) {
    config.apiKeyHeader = runtime.apiKeyHeader;
  }
  if (typeof runtime.allowPrivateNetworks === "boolean") {
    config.allowPrivateNetworks = runtime.allowPrivateNetworks;
  }
  if (runtime.oauth) {
    config.oauth = runtime.oauth;
  }
  return config;
}
