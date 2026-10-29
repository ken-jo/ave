/** Canonical inventory of environment variables that are meaningful only for source runs, tests, E2E, or developer diagnostics. Consumers have different jobs but share this inventory: - the env-surface gate classifies the `AVE_*` entries as development-only; - packaged boot
 * removes every entry before child processes inherit it. Keep retired names as explicit tombstones when an older launcher may still provide them. A tombstone is never a compatibility path: it is scrubbed and audited so a packaged build cannot revive removed development behaviour. */
export const DEVELOPMENT_ENV_POLICY = [
  // Kept the signed admission catalog offline; installs now resolve from git sources (design §6).
  { name: "AVE_ADMISSION_OFFLINE", lifecycle: "tombstone", packaged: "scrub" },
  // Removed development bypasses retained as one-way packaged scrub tombstones.
  { name: "AVE_ALLOW_LINKED_PLUGIN_ENTRY", lifecycle: "tombstone", packaged: "scrub" },
  { name: "AVE_ALLOW_TEST_MARKETPLACE_KEYS", lifecycle: "tombstone", packaged: "scrub" },
  { name: "AVE_ASRT_TEST_HOME", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_DEBUG_STREAM", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_DEV", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_DEV_CONSOLE", lifecycle: "active", packaged: "scrub" },
  // Renamed to AVE_WIN_NO_SANDBOX; stale launchers must not revive it.
  { name: "AVE_DEV_NO_SANDBOX", lifecycle: "tombstone", packaged: "scrub" },
  { name: "AVE_DEV_PREFLIGHT_OVERRIDE", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_DEV_PROMPT_SOURCE_DUMP", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_DEV_RELOAD", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_E2E", lifecycle: "active", packaged: "scrub" },
  // An isolated E2E run starts the real marketplace update scheduler (design §18.10 F); honoured only with AVE_E2E.
  { name: "AVE_E2E_MARKETPLACE_SCHEDULER", lifecycle: "active", packaged: "scrub" },
  // Trusted an E2E-signed whitelist; host-secret grants now come from the app and local snapshots.
  { name: "AVE_E2E_WHITELIST_PUBLIC_KEY", lifecycle: "tombstone", packaged: "scrub" },
  { name: "AVE_LOG_FILE", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_LOG_FORMAT", lifecycle: "active", packaged: "scrub" },
  // Removed from plugin path resolution; retained as a scrub/audit tombstone.
  { name: "AVE_PLUGINS_DIR", lifecycle: "tombstone", packaged: "scrub" },
  { name: "AVE_REQUIRE_SANDBOX_CASES", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_TEST_SANDBOX_BASE", lifecycle: "active", packaged: "scrub" },
  // The directory vitest.globalSetup.ts makes each test file its Ave home in.
  { name: "AVE_TEST_RUN_HOME", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_RESOURCE_ROOT", lifecycle: "active", packaged: "scrub" },
  // Kept the signed revocation feed offline; revocations now come from local snapshots.
  { name: "AVE_REVOCATION_OFFLINE", lifecycle: "tombstone", packaged: "scrub" },
  { name: "AVE_RUN_PROBES", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_SECRET_PROBE", lifecycle: "active", packaged: "scrub" },
  // A staging service base for source runs (design §11); packaged builds use the build constant or policy.
  { name: "AVE_SERVICE_BASE_URL", lifecycle: "active", packaged: "scrub" },
  // The interpreter CI provisioned for the cross-language smoke's harness (§9.7 P5).
  { name: "AVE_SMOKE_PYTHON", lifecycle: "active", packaged: "scrub" },
  // Official Claude Code release artifacts CI pins for the real publisher-verifier tests; the flag turns a missing fixture into a failure.
  { name: "AVE_CLAUDE_CODE_RELEASE_BINARY", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_CLAUDE_CODE_RELEASE_METADATA", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_REQUIRE_PUBLISHER_FIXTURES", lifecycle: "active", packaged: "scrub" },
  // Explicit local test opt-out; ignored when CI is detected.
  { name: "AVE_SKIP_NATIVE_SANDBOX_TESTS", lifecycle: "active", packaged: "scrub" },
  { name: "AVE_TEST_NODE_EXEC_PATH", lifecycle: "active", packaged: "scrub" },
  // The PowerShell 7 executable the native pwsh host-terminal tests run (the Windows verification session sets it).
  { name: "AVE_TEST_PWSH", lifecycle: "active", packaged: "scrub" },
  // Explicitly source/test-only; packaged builds do not accept this env switch.
  { name: "AVE_TRACE", lifecycle: "active", packaged: "scrub" },
  // Kept the signed whitelist feed offline; host-secret grants no longer fetch anything.
  { name: "AVE_WHITELIST_OFFLINE", lifecycle: "tombstone", packaged: "scrub" },
  // Re-injected --no-sandbox into the dev ave:// registration; unpackaged launches no longer register.
  { name: "AVE_WIN_NO_SANDBOX", lifecycle: "tombstone", packaged: "scrub" },
  // Renderer-build development flag: deliberately covered despite not using the AVE_ namespace scanned by the env-surface policy gate.
  { name: "VITE_DEBUG_STREAM", lifecycle: "active", packaged: "scrub" },
] as const;

type DevelopmentEnvPolicyEntry = (typeof DEVELOPMENT_ENV_POLICY)[number];
type ActiveDevelopmentEnvPolicyEntry = Extract<
  DevelopmentEnvPolicyEntry,
  { lifecycle: "active" }
>;
type DevelopmentEnvTombstonePolicyEntry = Extract<
  DevelopmentEnvPolicyEntry,
  { lifecycle: "tombstone" }
>;

export type DevelopmentEnvVar = ActiveDevelopmentEnvPolicyEntry["name"];
export type DevelopmentEnvTombstone = DevelopmentEnvTombstonePolicyEntry["name"];
export type DevelopmentEnvPolicyName = DevelopmentEnvPolicyEntry["name"];

export const ACTIVE_DEVELOPMENT_ENV_VARS: readonly DevelopmentEnvVar[] =
  DEVELOPMENT_ENV_POLICY
    .filter((entry): entry is ActiveDevelopmentEnvPolicyEntry => entry.lifecycle === "active")
    .map((entry) => entry.name);

export const DEVELOPMENT_ENV_TOMBSTONES: readonly DevelopmentEnvTombstone[] =
  DEVELOPMENT_ENV_POLICY
    .filter(
      (entry): entry is DevelopmentEnvTombstonePolicyEntry => entry.lifecycle === "tombstone",
    )
    .map((entry) => entry.name);

export const PACKAGED_DEVELOPMENT_ENV_VARS: readonly DevelopmentEnvPolicyName[] =
  DEVELOPMENT_ENV_POLICY
    .filter((entry) => entry.packaged === "scrub")
    .map((entry) => entry.name);

/** Prefixes denied in packaged builds even before a newly introduced exact name is added to the inventory and classified by the env-surface gate. */
const DEVELOPMENT_ENV_PREFIXES = ["AVE_DEV"] as const;

const DEVELOPMENT_ENV_VAR_SET: ReadonlySet<string> = new Set(PACKAGED_DEVELOPMENT_ENV_VARS);

export function isDevelopmentOnlyEnvVar(name: string): boolean {
  return (
    DEVELOPMENT_ENV_VAR_SET.has(name)
    || DEVELOPMENT_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export function readDevelopmentOnlyEnvVar(
  name: DevelopmentEnvVar,
  env: NodeJS.ProcessEnv,
  packaged: boolean,
): string | undefined {
  if (!isDevelopmentOnlyEnvVar(name)) {
    throw new Error(`Unknown development-only environment variable: ${name}`);
  }
  return packaged ? undefined : Reflect.get(env, name) as string | undefined;
}
