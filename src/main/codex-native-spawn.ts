import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawnManaged } from "./managed-child-processes.js";
import { assertCodexExecutableLocation } from "./codex-executable-location.js";

const NATIVE_EXEC_BOOTSTRAP = [
  '"use strict";',
  "try {",
  "  if (typeof process.execve !== 'function') process.exit(126);",
  "  const [command, environment, ...args] = process.argv.slice(1);",
  "  const env = JSON.parse(environment);",
  "  delete process.env.ELECTRON_RUN_AS_NODE;",
  "  process.execve(command, [command, ...args], env);",
  "} catch { process.exit(126); }",
  "process.exit(126);",
].join("\n");

/** Admit the host's on-disk location before final artifact verification. */
export async function assertCodexNativeHostLocation(): Promise<void> {
  if (process.platform !== "win32") await assertCodexExecutableLocation(process.execPath);
}

/**
 * Execute a qualified artifact after the caller has admitted the host location.
 * Callers supply a complete native environment; omission means an empty one.
 */
export function spawnCodexNative(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  label: string,
): ChildProcess {
  if (process.platform === "win32") {
    return spawnManaged(command, args, { ...options, shell: false }, { label });
  }
  // Callers admit the host's disk location before verifying the artifact.
  // Replacement retains the managed PID, process group and standard streams.
  return spawnManaged(process.execPath, [
    "--no-warnings", "--eval", NATIVE_EXEC_BOOTSTRAP, "--",
    command, JSON.stringify(options.env ?? {}), ...args,
  ], {
    ...options,
    shell: false,
    env: { ...options.env, ELECTRON_RUN_AS_NODE: "1" },
  }, { label });
}
