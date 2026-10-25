import type { SpawnSyncOptions, SpawnSyncReturns } from "node:child_process";

export const COMMAND_LINE_BUDGET_CHARS: number;
export function commandLineLength(command: string, args: readonly string[]): number;
export function splitArgumentsWithinBudget(
  command: string,
  items: readonly string[],
  buildArgs: (chunk: string[], index: number) => string[],
  options?: { budget?: number },
): string[][];
export function spawnSyncPortable(
  command: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<string | Buffer>;
export function runCommand(
  command: string,
  args: readonly string[],
  options?: { cwd?: string; label?: string; env?: NodeJS.ProcessEnv } & SpawnSyncOptions,
): void;
