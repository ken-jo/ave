import * as Ajv2020Module from "ajv/dist/2020.js";
import portableMcpSchema from "../../schemas/agent-plugins-mcp.schema.json" with { type: "json" };
import { isSafeMcpEnvironmentName, HTTP_HEADER_NAME_RE, MAX_NAME_LEN, RESERVED_HEADERS } from "./safe-names.js";
import { parseStrictJson } from "../marketplace/catalog/strict-json.js";
import type { AjvCtor } from "../plugins/config-schema.js";

interface PortableStdioServer {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface PortableHttpServer {
  type: "streamable-http";
  url: string;
  headers?: Record<string, string>;
}

type PortableMcpServer = PortableStdioServer | PortableHttpServer;

export interface PortableMcpDocument {
  $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
  mcpServers: Record<string, PortableMcpServer>;
}

export type BundledMcpAuth = Record<string, { auth: "api-key"; apiKeyEnv?: string; apiKeyHeader?: string }>;

export type StaticBundledMcpServer =
  | { transport: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd: string; auth?: "api-key"; apiKeyEnv?: string }
  | { transport: "http"; url: string; headers?: Record<string, string>; auth?: "api-key"; apiKeyHeader?: string };

export type StaticBundledMcp = Record<string, StaticBundledMcpServer>;

const Ajv2020 = ((Ajv2020Module as unknown as { default?: unknown }).default ?? Ajv2020Module) as AjvCtor;
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validatePortableMcp = ajv.compile(portableMcpSchema);
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SERVER_NAME = /^[^\u0000-\u001f\u007f]{1,128}$/u;
const BARE_COMMAND = /^[A-Za-z][A-Za-z0-9._-]*$/u;

function relativePath(path: string, label: string): void {
  if (!path || path.includes("\\") || path.includes("${") || CONTROL.test(path) || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} leaves its declared root`);
  }
}

function validateCwd(cwd: string, label: string): void {
  if (cwd === "${PLUGIN_ROOT}" || cwd === "${PLUGIN_DATA}") return;
  const prefixes = ["./", "${PLUGIN_ROOT}/", "${PLUGIN_DATA}/"];
  const prefix = prefixes.find((candidate) => cwd.startsWith(candidate));
  if (!prefix) throw new Error(`${label}.cwd must be plugin-relative or rooted in PLUGIN_ROOT or PLUGIN_DATA`);
  relativePath(cwd.slice(prefix.length), `${label}.cwd`);
}

function validateServer(name: string, server: PortableMcpServer): void {
  const label = `mcpServers.${name}`;
  if (!SERVER_NAME.test(name) || name.trim() !== name) throw new Error(`${label} has an invalid server name`);
  if (server.type === "stdio") {
    if (server.command.includes("${") || CONTROL.test(server.command)
      || !(BARE_COMMAND.test(server.command) || server.command.startsWith("./"))) {
      throw new Error(`${label}.command must be one bare executable or a ./ package path without placeholders`);
    }
    if (server.command.startsWith("./")) relativePath(server.command.slice(2), `${label}.command`);
    for (const [key, value] of Object.entries(server.env ?? {})) {
      if (!isSafeMcpEnvironmentName(key) || value.includes("\0")) throw new Error(`${label}.env.${key} is not allowed`);
    }
    for (const arg of server.args ?? []) if (arg.includes("\0")) throw new Error(`${label}.args contains NUL`);
    if (server.cwd !== undefined) validateCwd(server.cwd, label);
  } else if (server.type === "streamable-http") {
    let url: URL;
    try { url = new URL(server.url); } catch { throw new Error(`${label}.url must be an HTTPS URL`); }
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new Error(`${label}.url must be an HTTPS URL without credentials`);
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      if (key.length > MAX_NAME_LEN || !HTTP_HEADER_NAME_RE.test(key) || RESERVED_HEADERS.has(key.toLowerCase()) || CONTROL.test(value)) {
        throw new Error(`${label}.headers.${key} is not allowed`);
      }
    }
  } else {
    throw new Error(`${label}.type ${String((server as { type: unknown }).type)} is not supported`);
  }
}

/** Validate the portable document before adding any host-specific runtime fields. */
export function parsePortableMcp(bytes: Buffer | string): PortableMcpDocument {
  const document: unknown = parseStrictJson(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes);
  if (document && typeof document === "object" && !Array.isArray(document)) {
    const servers = (document as Record<string, unknown>).mcpServers;
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      for (const [name, server] of Object.entries(servers)) {
        if (server && typeof server === "object" && !Array.isArray(server) && (server as Record<string, unknown>).type === "sse") {
          throw new Error(`mcpServers.${name}.type sse is not supported`);
        }
      }
    }
  }
  if (!validatePortableMcp(document)) {
    const first = validatePortableMcp.errors?.[0];
    throw new Error(`mcp.json ${first?.instancePath || "/"}: ${first?.message ?? "invalid portable schema"}`);
  }
  const parsed = document as PortableMcpDocument;
  for (const [name, server] of Object.entries(parsed.mcpServers)) validateServer(name, server);
  return parsed;
}

/** Keep paths symbolic so package descriptors have the same bytes under every install root. */
export function projectPortableMcp(parsed: PortableMcpDocument, auth: BundledMcpAuth = {}): StaticBundledMcp {
  if (!validatePortableMcp(parsed)) throw new Error("portable MCP projection requires a validated document");
  for (const [name, server] of Object.entries(parsed.mcpServers)) validateServer(name, server);
  for (const name of Object.keys(auth)) if (!Object.hasOwn(parsed.mcpServers, name)) throw new Error(`mcpAuth.${name} names no MCP server`);
  const projected = Object.create(null) as StaticBundledMcp;
  for (const [name, server] of Object.entries(parsed.mcpServers)) {
    const declaration = Object.hasOwn(auth, name) ? auth[name] : undefined;
    if (declaration) {
      const extra = Object.keys(declaration).filter((key) => !["auth", "apiKeyEnv", "apiKeyHeader"].includes(key));
      if (extra.length > 0) throw new Error(`mcpAuth.${name} has unknown fields: ${extra.join(", ")}`);
      if (declaration.auth !== "api-key") throw new Error(`mcpAuth.${name}.auth is invalid`);
      if (server.type === "stdio" && (!declaration.apiKeyEnv || declaration.apiKeyHeader || !isSafeMcpEnvironmentName(declaration.apiKeyEnv))) {
        throw new Error(`mcpAuth.${name} needs one allowed apiKeyEnv`);
      }
      if (server.type === "streamable-http" && (!declaration.apiKeyHeader || declaration.apiKeyEnv
        || declaration.apiKeyHeader.length > MAX_NAME_LEN || !HTTP_HEADER_NAME_RE.test(declaration.apiKeyHeader)
        || RESERVED_HEADERS.has(declaration.apiKeyHeader.toLowerCase()))) {
        throw new Error(`mcpAuth.${name} needs one allowed apiKeyHeader`);
      }
    }
    if (server.type === "stdio") {
      projected[name] = {
        transport: "stdio", command: server.command,
        ...(server.args ? { args: [...server.args] } : {}),
        ...(server.env ? { env: { ...server.env } } : {}),
        cwd: server.cwd ?? "${PLUGIN_ROOT}",
        ...(declaration ? { auth: "api-key", apiKeyEnv: declaration.apiKeyEnv } : {}),
      };
    } else {
      projected[name] = {
        transport: "http", url: server.url,
        ...(server.headers ? { headers: { ...server.headers } } : {}),
        ...(declaration ? { auth: "api-key", apiKeyHeader: declaration.apiKeyHeader } : {}),
      };
    }
  }
  return projected;
}

/** Export only portable fields; credential declarations belong to plugin.json. */
export function exportPortableMcp(projected: StaticBundledMcp): PortableMcpDocument {
  const mcpServers = Object.create(null) as Record<string, PortableMcpServer>;
  for (const [name, server] of Object.entries(projected)) {
    mcpServers[name] = server.transport === "stdio"
      ? { type: "stdio", command: server.command, ...(server.args ? { args: [...server.args] } : {}),
        ...(server.env ? { env: { ...server.env } } : {}), cwd: server.cwd }
      : { type: "streamable-http", url: server.url, ...(server.headers ? { headers: { ...server.headers } } : {}) };
  }
  return { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers };
}
