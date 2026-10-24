/** Configuration every host-owned Git process carries before its subcommand. */
const HOST_GIT_CONFIG = ["safe.bareRepository=explicit", "core.fsmonitor=false"] as const;

/**
 * Refuse implicit bare-repository discovery and prevent repository metadata
 * from starting monitors or hooks. Callers retain their environment, transport
 * and credential policy. A supplied hooks path must be an empty host-owned
 * directory; otherwise the null device makes every hook lookup absent.
 */
export function buildHostGitArgs(args: readonly string[], options: {
  /** Caller-owned global configuration, applied before the mandatory floor. */
  configArgs?: readonly string[];
  disabledHooksPath?: string;
} = {}): string[] {
  const disabledHooksPath = options.disabledHooksPath ?? (process.platform === "win32" ? "NUL" : "/dev/null");
  return [
    ...options.configArgs ?? [],
    ...HOST_GIT_CONFIG.flatMap((entry) => ["-c", entry]),
    "-c", `core.hooksPath=${disabledHooksPath}`,
    ...args,
  ];
}
