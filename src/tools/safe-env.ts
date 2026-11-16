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

/*
 * Portions adapted from microsoft/vscode src/vs/base/common/processes.ts @ 6659689e6b03ec062f5b7bcea9850b4c59045807,
 * Copyright (c) Microsoft Corporation, MIT License.
 */
// The adapted part is `sanitizeProcessEnvironment`: inherit the application's environment and remove the application's own variables by name pattern.
/** Variables that belong to Ave or its runtime, never to the user's shell. `AVE_` carries Ave's configuration and secrets;
 * `ELECTRON_` changes how a child Electron or Node starts; the `SNAP` and `GDK_PIXBUF_` families describe the application's own package. */
const USER_TERMINAL_REMOVED_ENV: readonly RegExp[] = [/^ELECTRON_.+$/, /^AVE_.+$/, /^SNAP(|_.*)$/, /^GDK_PIXBUF_.+$/];
/** Values Ave writes into its own process (the packaged build forces NODE_ENV; the sandbox runtime points these temp variables at its own directory). */
const USER_TERMINAL_REMOVED_ENV_NAMES: ReadonlySet<string> = new Set(["NODE_ENV", "CLAUDE_CODE_TMPDIR", "CLAUDE_TMPDIR"]);

/**
 * The environment of the user's own terminal: everything the application was started with (ssh agent socket, editor, language toolchains),
 * minus Ave's own variables, plus `TERM_PROGRAM`. Only the visible host terminal uses it; agent and sandbox
 * children keep the allowlist above.
 */
export function buildUserTerminalEnv(
  extra: Record<string, string> = {},
  source: Readonly<NodeJS.ProcessEnv> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  // Windows variable names are case-insensitive.
  const fold = (name: string): string => (platform === "win32" ? name.toUpperCase() : name);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const folded = fold(name);
    if (USER_TERMINAL_REMOVED_ENV_NAMES.has(folded) || USER_TERMINAL_REMOVED_ENV.some((pattern) => pattern.test(folded))) continue;
    env[name] = value;
  }
  return { ...env, TERM_PROGRAM: "Ave", ...extra };
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
