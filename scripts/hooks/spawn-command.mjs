import { spawnSync } from "node:child_process";

const TRUSTED_WINDOWS_BATCH_COMMANDS = new Set(["npm.cmd", "npx.cmd"]);
const UNSAFE_WINDOWS_BATCH_ARGUMENT = /[&|<>^%!()"\0\r\n]/;

function isTrustedWindowsBatchCommand(command) {
  return TRUSTED_WINDOWS_BATCH_COMMANDS.has(command.toLowerCase());
}

function normalizeSpawnInvocation(
  command,
  args,
  { platform = process.platform, comSpec = process.env.ComSpec } = {}
) {
  if (platform !== "win32" || !isTrustedWindowsBatchCommand(command)) {
    return { command, args };
  }

  if (
    args.some(
      (arg) => typeof arg !== "string" || UNSAFE_WINDOWS_BATCH_ARGUMENT.test(arg)
    )
  ) {
    throw new Error(
      "[unsafe-windows-command-argument] refusing cmd.exe metacharacters in npm/npx arguments"
    );
  }

  return {
    command: comSpec || "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args],
  };
}

/**
 * The command-line budget of every argument list the hooks spawn, in
 * characters. Windows CreateProcess caps a command line at 32,767 characters,
 * and the Vitest file list reaches the runner twice more (bun -> node runner
 * -> Electron) with an interpreter, a script and a loader path prepended each
 * time; half the platform cap leaves that headroom. The budget is fixed and
 * applies on every platform, so a push splits the same way everywhere and the
 * tests that pin it are portable.
 */
export const COMMAND_LINE_BUDGET_CHARS = 16_384;

/**
 * The length a command line takes: each part plus a separator and a pair of
 * quotes, the most a Windows argv quoting of a space-free path adds.
 */
export function commandLineLength(command, args) {
  return [command, ...args].reduce((total, part) => total + part.length + 3, 0);
}

/**
 * Split `items` into consecutive chunks whose command lines
 * (`command` + `buildArgs(chunk, index)`) each fit `budget`. The chunks keep
 * every item once and in order, so running every chunk covers exactly the list
 * a single spawn would have. An empty list yields no chunk; an item that cannot
 * fit even alone throws instead of being dropped.
 */
export function splitArgumentsWithinBudget(
  command,
  items,
  buildArgs,
  { budget = COMMAND_LINE_BUDGET_CHARS } = {}
) {
  const chunks = [];
  let chunk = [];
  let length = commandLineLength(command, buildArgs([], 0));
  for (const item of items) {
    const itemLength = item.length + 3;
    if (chunk.length > 0 && length + itemLength > budget) {
      chunks.push(chunk);
      chunk = [];
      length = commandLineLength(command, buildArgs([], chunks.length));
    }
    if (length + itemLength > budget) {
      throw new Error(
        `[command-line-budget-exceeded] ${command} ${buildArgs([item], chunks.length).join(" ").slice(0, 200)} ` +
          `needs ${length + itemLength} characters; the budget is ${budget}`
      );
    }
    chunk.push(item);
    length += itemLength;
  }
  if (chunk.length > 0) chunks.push(chunk);
  for (const [index, current] of chunks.entries()) {
    const actual = commandLineLength(command, buildArgs(current, index));
    if (actual > budget) {
      throw new Error(
        `[command-line-budget-exceeded] chunk ${index + 1}/${chunks.length} of ${command} needs ${actual} characters; ` +
          `the budget is ${budget} (buildArgs must append each item as one argument)`
      );
    }
  }
  return chunks;
}

export function spawnSyncPortable(command, args, options) {
  const invocation = normalizeSpawnInvocation(command, args);
  return spawnSync(invocation.command, invocation.args, options);
}

/**
 * Run a command with inherited stdio, echo it under `label`, and throw on a
 * spawn failure or a non-zero exit. The build, release, screenshot and
 * pre-push scripts each carried a private copy of this loop; the copies
 * agreed on everything but the log prefix, and one of them exited the
 * process instead of throwing, which skipped its caller's cleanup.
 */
export function runCommand(command, args, { cwd, label, env = process.env, ...options } = {}) {
  console.log(`[${label}] $ ${command} ${args.join(" ")}`);
  const result = spawnSyncPortable(command, args, {
    cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    ...options,
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with code ${result.status} in ${cwd}`);
  }
}
