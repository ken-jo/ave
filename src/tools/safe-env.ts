// Every child spawn must use the safe allowlist baseline so host secrets cannot leak.
// Only explicitly host-created extras or scoped shell/sandbox forwarding may add variables.

// Forward generic runtime keys, including Windows launcher state; exclude provider keys and internal secrets.
export const FORWARD_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "USERNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "SHELL",
  "COMSPEC",
  "PATHEXT",
  "SystemDrive",
  "SystemRoot",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PYTHONDONTWRITEBYTECODE",
  "PYTHONUNBUFFERED",
  "PYTHONUTF8",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
] as const;

// Return a fresh safe environment; explicit host-created extras override baseline keys.
export function buildSafeChildEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const key of FORWARD_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) safe[key] = value;
  }
  return { ...safe, ...extra };
}

/** Standard operator-configured proxy settings; preserve each client's casing. */
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

/** Standard operator-configured CA trust paths used by common command-line clients. */
const CA_TRUST_ENV_KEYS = [
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
  "REQUESTS_CA_BUNDLE",
  "PIP_CERT",
  "GIT_SSL_CAINFO",
  "AWS_CA_BUNDLE",
  "CARGO_HTTP_CAINFO",
  "DENO_CERT",
  "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE",
  "NIX_SSL_CERT_FILE",
] as const;

const HOST_SHELL_NETWORK_ENV_KEYS = [
  ...PROXY_ENV_KEYS,
  ...CA_TRUST_ENV_KEYS,
] as const;

// Plain host shells preserve operator proxy and trust settings; sandbox children receive only wrapper network configuration.
export function buildHostShellChildEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  const env = buildSafeChildEnv();
  for (const key of HOST_SHELL_NETWORK_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

// Permit only documented wrapper proxy, trust, and temporary-directory changes.
// Comparing values alone could reintroduce a stripped secret if the wrapper mutates it.
const ASRT_SANDBOX_ENV_KEYS: ReadonlySet<string> = new Set([
  ...PROXY_ENV_KEYS,
  "FTP_PROXY",
  "RSYNC_PROXY",
  "GRPC_PROXY",
  "ftp_proxy",
  "grpc_proxy",
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
  "CLOUDSDK_PROXY_TYPE",
  "CLOUDSDK_PROXY_ADDRESS",
  "CLOUDSDK_PROXY_PORT",
  "CLOUDSDK_PROXY_USERNAME",
  "CLOUDSDK_PROXY_PASSWORD",
  "GIT_CONFIG_PARAMETERS",
  "GIT_SSH_COMMAND",
  ...CA_TRUST_ENV_KEYS,
  "TMPDIR",
  // Preserve the secret-free Windows sandbox marker through the same explicit wrapper allowlist.
  "SANDBOX_RUNTIME",
]);

const ASRT_SANDBOX_ENV_KEYS_LOWER: ReadonlySet<string> = new Set(
  [...ASRT_SANDBOX_ENV_KEYS].map((key) => key.toLowerCase()),
);

// Match wrapper-managed proxy, trust, and sandbox keys case-insensitively, leaving them to the wrapper.
export function isSandboxWrapperEnvKey(name: string): boolean {
  return ASRT_SANDBOX_ENV_KEYS_LOWER.has(name.toLowerCase());
}

// Start from the safe baseline and overlay only allowlisted keys actually changed by the wrapper.
// Never forward its full inherited environment or untouched host values.
export function buildSandboxedChildEnv(
  wrappedEnv: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  return overlaySandboxChildEnv(wrappedEnv, buildSafeChildEnv(extra), process.env);
}

/** Apply wrapper changes to an already captured safe child environment. */
export function overlaySandboxChildEnv(
  wrappedEnv: NodeJS.ProcessEnv,
  safeBaseline: Readonly<Record<string, string>>,
  wrapperBaseline: Readonly<NodeJS.ProcessEnv>,
): Record<string, string> {
  const env = { ...safeBaseline };
  for (const key of ASRT_SANDBOX_ENV_KEYS) {
    const value = wrappedEnv[key];
    if (value === undefined) continue;
    if (wrapperBaseline[key] === value) continue;
    env[key] = value;
  }
  return env;
}

/** Retain only the wrapper's documented overlay keys, never an ambient secret bag. */
export function captureSandboxEnvironmentBaseline(): Readonly<NodeJS.ProcessEnv> {
  return Object.freeze(Object.fromEntries([...ASRT_SANDBOX_ENV_KEYS].map((key) => [key, process.env[key]])));
}
