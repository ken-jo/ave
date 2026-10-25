/** Packaged builds ignore development flags; the cache defaults to packaged until boot seeds it. */

import {
  isDevelopmentOnlyEnvVar,
  readDevelopmentOnlyEnvVar,
  type DevelopmentEnvVar,
} from "../shared/development-env-policy.js";

let isPackagedCached = true;
let configured = false;

/** Capture forbidden flags before the startup scrub so tampering still appears in the audit log. */
export const isPackagedForbiddenEnvVar = isDevelopmentOnlyEnvVar;

const tamperedAtBoot: ReadonlySet<string> = Object.freeze(
  new Set(Object.keys(process.env).filter(isPackagedForbiddenEnvVar)),
);

/** Pass null to restore the real module-load snapshot. */
let tamperedOverrideForTest: ReadonlySet<string> | null = null;

function effectiveTamperedSet(): ReadonlySet<string> {
  return tamperedOverrideForTest ?? tamperedAtBoot;
}

/** Boot seeds packaged state once; tests may overwrite it. */
export function setIsPackaged(packaged: boolean): void {
  isPackagedCached = packaged;
  configured = true;
}

/** Test-only — reset internal state. Not exported via barrel. */
export function _resetForTest(): void {
  isPackagedCached = true;
  configured = false;
  tamperedOverrideForTest = null;
}

function envEquals(actual: string | undefined, expected: string): boolean {
  return actual === expected;
}

/** Explicit environment input keeps tests deterministic without mutating process.env. */
export function readDevelopmentEnvVar(
  name: DevelopmentEnvVar,
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedCached,
): string | undefined {
  return readDevelopmentOnlyEnvVar(name, env, packaged);
}

/** Development mode requires an unpackaged build and an explicit development flag. */
export function isDevModeUnlocked(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return (
    envEquals(process.env.AVE_DEV, "1")
    || envEquals(process.env.AVE_DEV_RELOAD, "1")
  );
}

export function devPluginReloadEnabled(packaged: boolean = isPackagedCached): boolean {
  if (packaged) return false;
  return envEquals(process.env.AVE_DEV_RELOAD, "1");
}

/** Read the pre-scrub snapshot; retain retired flag names to detect stale launchers. */
export function shouldWarnPackagedFlagsIgnored(packaged: boolean = isPackagedCached): boolean {
  if (!packaged) return false;
  return effectiveTamperedSet().size > 0;
}

/** Return a defensive copy of the forbidden flags present at module load. */
export function tamperedVarsAtBoot(): readonly string[] {
  return Array.from(effectiveTamperedSet());
}

/** Pass null to restore the captured boot snapshot. */
export function _setTamperedSnapshotForTest(names: readonly string[] | null): void {
  tamperedOverrideForTest = names === null ? null : Object.freeze(new Set(names));
}

export function isConfigured(): boolean {
  return configured;
}

/** Returns the cached isPackaged value set by boot. Defaults to true until boot wires the gate. */
export function getIsPackaged(): boolean {
  return isPackagedCached;
}

/** Before boot seeds the cache, derive packaging from runtime facts; user-controlled dev flags cannot change it. */
export function isPackagedElectronProcess(
  proc: { versions?: { electron?: string }; defaultApp?: boolean } = process,
): boolean {
  return Boolean(proc.versions?.electron) && !proc.defaultApp;
}

/** E2E-only surfaces require both AVE_E2E=1 and NODE_ENV=test. */
export function isE2eTestRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AVE_E2E === "1" && env.NODE_ENV === "test";
}

/** Real scheduler tests require the E2E harness and an isolated AVE_HOME. */
export function isE2eMarketplaceSchedulerRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return isE2eTestRuntime(env) && env.AVE_E2E_MARKETPLACE_SCHEDULER === "1";
}
