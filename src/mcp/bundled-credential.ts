export interface BundledPackageRef {
  kind: "plugin" | "agent-plugin";
  name: string;
}

export interface BundledCredentialDeclaration {
  transport: string;
  auth?: string;
  apiKeyEnv?: string;
  apiKeyHeader?: string;
}

export function bundledCredentialDeclaration(value: BundledCredentialDeclaration): string {
  if (value.auth !== "api-key") throw new Error("bundled MCP credential declaration is missing");
  if (value.transport !== "stdio" && value.transport !== "http") throw new Error("bundled MCP credential transport is invalid");
  const target = value.transport === "stdio" ? value.apiKeyEnv : value.apiKeyHeader;
  if (!target) throw new Error("bundled MCP credential target is missing");
  return JSON.stringify([value.transport, value.auth, target]);
}

export function boundBundledCredential(declaration: string, secret: string): string {
  return JSON.stringify({ version: 1, declaration, secret });
}

export function readBoundBundledCredential(value: string | null): { declaration: string; secret: string } | null {
  if (!value) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "declaration,secret,version" || record.version !== 1
    || typeof record.declaration !== "string" || typeof record.secret !== "string" || !record.secret) return null;
  return { declaration: record.declaration, secret: record.secret };
}

export function bundledCredentialKey(packageRef: BundledPackageRef, server: string): string {
  if (!packageRef.name || !server || packageRef.name.includes("\0") || server.includes("\0")) {
    throw new Error("bundled MCP credential identity is invalid");
  }
  return `mcp.bundled:${JSON.stringify([packageRef.kind, packageRef.name, server])}`;
}

export function bundledConfigId(packageRef: BundledPackageRef, server: string): string {
  return `bundled:${JSON.stringify([packageRef.kind, packageRef.name, server])}`;
}

export function parseBundledConfigId(id: string): { packageRef: BundledPackageRef; server: string } | null {
  if (!id.startsWith("bundled:")) return null;
  let value: unknown;
  try { value = JSON.parse(id.slice("bundled:".length)) as unknown; }
  catch { throw new Error("bundled MCP config id is invalid"); }
  if (!Array.isArray(value) || value.length !== 3 || (value[0] !== "plugin" && value[0] !== "agent-plugin")
    || typeof value[1] !== "string" || !value[1] || typeof value[2] !== "string" || !value[2]) {
    throw new Error("bundled MCP config id is invalid");
  }
  return { packageRef: { kind: value[0], name: value[1] }, server: value[2] };
}
