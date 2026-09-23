/**
 * Which git the marketplace runs (design §9.1), stored as
 * `settings.marketplace.git.mode`. Unset means `auto`.
 */
const GIT_RUNTIME_MODES = ["auto", "system", "managed"] as const;

export type GitRuntimeMode = (typeof GIT_RUNTIME_MODES)[number];

export function isGitRuntimeMode(value: unknown): value is GitRuntimeMode {
  return typeof value === "string" && (GIT_RUNTIME_MODES as readonly string[]).includes(value);
}
