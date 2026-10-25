import { initializeAsrtSandbox, isAsrtSandboxActive } from "../../permissions/asrt-sandbox.js";

/** Native enforcement is mandatory in CI; only an explicit local opt-out may skip it. */
export function shouldSkipNativeSandboxTests(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === "win32" || (
    !env.CI && !env.GITHUB_ACTIONS && env.AVE_SKIP_NATIVE_SANDBOX_TESTS === "1"
  );
}

/** A native case cannot report success after an unavailable-runtime early return. */
export async function initializeRequiredSandbox(
  ...args: Parameters<typeof initializeAsrtSandbox>
): Promise<void> {
  await initializeAsrtSandbox(...args);
  if (!isAsrtSandboxActive()) throw new Error("Native sandbox enforcement is required");
}
