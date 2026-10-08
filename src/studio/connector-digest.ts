import { sha256Hex } from "../lib/hex-digest-equal.js";
import { canonicalStringify } from "../shared/canonical-json.js";
import type { McpServerConfigDto } from "../mcp/types.js";

export function studioConnectorSpecDigest(spec: McpServerConfigDto, args: readonly string[], env: Readonly<Record<string, string>>): string {
  return sha256Hex(canonicalStringify({ spec, args, env }));
}
