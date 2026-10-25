/** Share environment and header name validation across governance and runtime parsing. */

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const HTTP_HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export const MAX_NAME_LEN = 64;

/** Reject manifest-controlled startup and loader variables case-insensitively to prevent code injection. */
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

const LAUNCHER_ENV_NAME_RE = /^(?:NPM_CONFIG_|PNPM_|YARN_|BUN_|COREPACK_|UV_|PIP_|DOCKER_|NODE_|PYTHON(?!UNBUFFERED$|IOENCODING$|UTF8$)|DYLD_|LD_|XDG_CONFIG_HOME$|(?:HTTPS?|ALL|NO|FTP)_PROXY$|SSL_CERT_|REQUESTS_CA_BUNDLE$|CURL_CA_BUNDLE$)/iu;

/** The variables the host sets for a plugin's process; a manifest may not declare them in any spelling. */
const HOST_OWNED_PLUGIN_ENV_NAMES = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

export function isSafeMcpEnvironmentName(name: string): boolean {
  const upper = name.toUpperCase();
  return name.length <= MAX_NAME_LEN && ENV_NAME_RE.test(name) && !RESERVED_ENV_NAMES.has(upper) && !LAUNCHER_ENV_NAME_RE.test(name)
    && !HOST_OWNED_PLUGIN_ENV_NAMES.has(upper);
}

/** Reserve authentication, forwarding and hop-by-hop headers to prevent credential injection and request smuggling. */
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

export const MAX_OAUTH_CLIENT_ID_LEN = 256;

/** Shared client-id validation permits 1–256 visible ASCII characters. */
export function isValidOAuthClientId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_OAUTH_CLIENT_ID_LEN && /^[\x21-\x7E]+$/u.test(value);
}
