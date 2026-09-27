/**
 * Shared name-validation constants for MCP governance.
 *
 * Single source of truth for env-var and HTTP-header name constraints.
 * Both mcp-governance.ts and mcp-runtime-spec.ts import from here so
 * the two validation paths can never silently diverge (MEDIUM).
 */

/** POSIX env-var name syntax: starts with letter or underscore, followed by word chars. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** RFC 7230 token grammar for HTTP header field names. */
export const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Maximum length for apiKeyEnv and apiKeyHeader names. */
export const MAX_NAME_LEN = 64;

/**
 * Env-var names that are dangerous to override via a manifest:
 * injecting an apiKey value into any of these could allow RCE via
 * shared-object injection (LD_PRELOAD, DYLD_INSERT_LIBRARIES),
 * interpreter startup-file hijacking (BASH_ENV, PYTHONSTARTUP),
 * or node-flag injection (NODE_OPTIONS) in spawned MCP child processes.
 *
 * Checked case-insensitively (CRITICAL).
 */
export const RESERVED_ENV_NAMES = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LANG",
  "NODE_ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "PERL5OPT",
]);

/** Environment names that can redirect a launcher, loader, proxy, or trust store. */
const LAUNCHER_ENV_NAME_RE = /^(?:NPM_CONFIG_|PNPM_|YARN_|BUN_|COREPACK_|UV_|PIP_|DOCKER_|NODE_|PYTHON(?!UNBUFFERED$|IOENCODING$|UTF8$)|DYLD_|LD_|XDG_CONFIG_HOME$|(?:HTTPS?|ALL|NO|FTP)_PROXY$|SSL_CERT_|REQUESTS_CA_BUNDLE$|CURL_CA_BUNDLE$)/iu;

export function isSafeMcpEnvironmentName(name: string): boolean {
  return name.length <= MAX_NAME_LEN && ENV_NAME_RE.test(name) && !RESERVED_ENV_NAMES.has(name.toUpperCase()) && !LAUNCHER_ENV_NAME_RE.test(name)
    && name !== "PLUGIN_ROOT" && name !== "PLUGIN_DATA";
}

/**
 * HTTP header names that must not be used as apiKeyHeader targets.
 *
 * Authorization/Cookie carry authentication material that must be set by
 * the host, not by a plugin manifest. Hop-by-hop headers (Connection,
 * Transfer-Encoding, etc.) and forwarding headers are spec-reserved and
 * can cause request smuggling or SSRF amplification if overridden.
 *
 * Checked case-insensitively (HIGH).
 */
export const RESERVED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);
