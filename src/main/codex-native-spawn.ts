import type { ChildProcess, SpawnOptions } from "node:child_process";
import { posix } from "node:path";
import { spawnManaged } from "./managed-child-processes.js";

/**
 * Runs in the Electron-as-Node bootstrap, then replaces it with the program.
 *
 * Opening a pipe or socket as a stdio stream makes libuv set O_NONBLOCK on it
 * (`uv_pipe_open`), a flag of the open file description that the program keeps
 * across `execve`. Electron 45 opens `process.stderr` while it starts a
 * run-as-node process, so without the reset the program would get a
 * non-blocking stderr: a write it does not retry fails with EAGAIN, the
 * program exits on an I/O error, and the host's input write fails with EPIPE.
 * Standard input is never opened here and keeps the blocking state libuv gave
 * it when it spawned this process.
 */
const NATIVE_EXEC_BOOTSTRAP = [
  '"use strict";',
  "try {",
  "  if (typeof process.execve !== 'function') process.exit(126);",
  "  const [command, environment, ...args] = process.argv.slice(1);",
  "  const env = JSON.parse(environment);",
  "  delete process.env.ELECTRON_RUN_AS_NODE;",
  "  for (const stream of [process.stdout, process.stderr]) stream._handle?.setBlocking?.(true);",
  "  process.execve(command, [command, ...args], env);",
  "} catch { process.exit(126); }",
  "process.exit(126);",
].join("\n");

/**
 * Execute a qualified artifact without invoking a shell when the loader rejects it.
 * Callers supply a complete native environment; omission means an empty one.
 */
export function spawnCodexNative(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
  label: string,
): ChildProcess {
  if (process.platform === "darwin") {
    // Supported systems use explicit-path native spawning. Account changes and
    // detached sessions can select a legacy fork path, so reject those options.
    if (!posix.isAbsolute(command) || options.uid !== undefined || options.gid !== undefined || options.detached) {
      throw new Error("Native launch requires an absolute path and the current account session");
    }
  }
  if (process.platform === "win32" || process.platform === "darwin") {
    return spawnManaged(command, args, { ...options, shell: false, env: options.env ?? {} }, { label });
  }
  // A new bootstrap process uses the trusted application host installation.
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
