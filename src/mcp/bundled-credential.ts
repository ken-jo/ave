export interface BundledPackageRef {
  kind: "plugin" | "agent-plugin";
  name: string;
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
