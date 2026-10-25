/** Imports stdio desktop configurations and flags suspected secrets for protected storage. */

import type { McpServerConfig } from "./types.js";

export interface ClaudeDesktopImportEntry {
  id: string;
  config: McpServerConfig;
  suspectedSecretEnvKeys: string[];
  warning?: string;
}

export interface ClaudeDesktopImportResult {
  entries: ClaudeDesktopImportEntry[];
  errors: Array<{ id: string; reason: string }>;
}

/** Expose stable import failure reasons; raw errors stay behind Copy details. */
export type ClaudeDesktopImportFailure = "permission-denied" | "not-found" | "unreadable" | "other";

export function importFailureKind(error: unknown): ClaudeDesktopImportFailure {
  if (error instanceof SyntaxError) return "unreadable";
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "EACCES":
    case "EPERM":
    case "EROFS":
      return "permission-denied";
    case "ENOENT":
      return "not-found";
    case "EISDIR":
    case "ENOTDIR":
    case "EIO":
      return "unreadable";
    default:
      return "other";
  }
}

/** Prefer false-positive secret-name warnings over silently persisting credentials. */
const SECRET_KEY_PATTERNS = [
  "KEY",
  "SECRET",
  "TOKEN",
  "PASSWORD",
  "PASS",
  "AUTH",
  "CREDENTIAL",
  "BEARER",
  "JWT",
  "COOKIE",
  "SESSION",
  "DSN",
  "PRIVATE",
  "SIGNATURE",
  "APIKEY",
];

/** Detect token-shaped values even when their environment variable names are generic. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}$/,
  /^sk-[A-Za-z0-9_-]{20,}$/,
  /^xox[baprs]-[A-Za-z0-9-]{10,}$/,
];

function looksLikeSecretKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_KEY_PATTERNS.some((p) => upper.includes(p));
}

function looksLikeSecretValue(value: string): boolean {
  return SECRET_VALUE_PATTERNS.some((p) => p.test(value));
}

/** Return successful stdio entries alongside per-entry errors; malformed input never throws. */
export function parseClaudeDesktopConfig(raw: string): ClaudeDesktopImportResult {
  const result: ClaudeDesktopImportResult = { entries: [], errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    result.errors.push({ id: "<root>", reason: `not valid JSON: ${(err as Error).message}` });
    return result;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    result.errors.push({ id: "<root>", reason: "config must be a JSON object" });
    return result;
  }
  const mcpServers = (parsed as Record<string, unknown>).mcpServers;
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
    result.errors.push({ id: "<root>", reason: "missing `mcpServers` object" });
    return result;
  }

  for (const [rawId, raw] of Object.entries(mcpServers as Record<string, unknown>)) {
    const id = rawId.trim();
    if (!id) {
      result.errors.push({ id: rawId, reason: "empty id" });
      continue;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      result.errors.push({ id, reason: "entry must be an object" });
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const command = entry.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      result.errors.push({ id, reason: "missing or invalid `command`" });
      continue;
    }
    let args: string[] | undefined;
    if (entry.args !== undefined) {
      if (!Array.isArray(entry.args)) {
        result.errors.push({ id, reason: "`args` must be a string array" });
        continue;
      }
      const allStrings = entry.args.every((a): a is string => typeof a === "string");
      if (!allStrings) {
        result.errors.push({ id, reason: "`args` entries must all be strings" });
        continue;
      }
      args = entry.args as string[];
    }
    let env: Record<string, string> | undefined;
    let suspectedSecretEnvKeys: string[] = [];
    if (entry.env !== undefined) {
      if (!entry.env || typeof entry.env !== "object" || Array.isArray(entry.env)) {
        result.errors.push({ id, reason: "`env` must be an object of string key/value pairs" });
        continue;
      }
      const envObj = entry.env as Record<string, unknown>;
      const cleaned: Record<string, string> = {};
      let invalid = false;
      for (const [k, v] of Object.entries(envObj)) {
        if (typeof v !== "string") {
          result.errors.push({
            id,
            reason: `\`env.${k}\` must be a string (got ${typeof v})`,
          });
          invalid = true;
          break;
        }
        cleaned[k] = v;
        // Check both key and value shapes; empty placeholders contain no credential.
        if (v.length > 0 && (looksLikeSecretKey(k) || looksLikeSecretValue(v))) {
          suspectedSecretEnvKeys.push(k);
        }
      }
      if (invalid) continue;
      if (Object.keys(cleaned).length > 0) env = cleaned;
    }

    // Derive sandbox roots in the host at connection time; imported or persisted roots cannot define confinement.
    const config: McpServerConfig = {
      id,
      transport: "stdio",
      command: command.trim(),
      args,
      env,
      auth: "none",
    };
    const importEntry: ClaudeDesktopImportEntry = {
      id,
      config,
      suspectedSecretEnvKeys,
    };
    if (suspectedSecretEnvKeys.length > 0) {
      importEntry.warning =
        `Detected ${suspectedSecretEnvKeys.length} env value(s) that look like secrets ` +
        `(${suspectedSecretEnvKeys.join(", ")}). Consider moving them to the OS keychain ` +
        `via the api-key flow instead of persisting in mcp-servers.json.`;
    }
    result.entries.push(importEntry);
  }

  return result;
}
