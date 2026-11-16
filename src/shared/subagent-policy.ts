/** Keep orchestration budgets import-free for engine and renderer consumers. */

/** Tie fan-out to the per-round tool-call cap because spawning is an ordinary tool call. */
export const MAX_AGENT_SPAWNS_PER_ROUND = 5;

export const MAX_TOOL_CALLS_PER_ROUND = MAX_AGENT_SPAWNS_PER_ROUND;

/** Engine and settings share the configurable round budget bounds. */
export const SUBAGENT_MAX_ROUNDS_MIN = 1;

export const SUBAGENT_MAX_ROUNDS_DEFAULT = 60;

export const SUBAGENT_MAX_ROUNDS_MAX = 1000;
export function isSubAgentMaxRounds(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= SUBAGENT_MAX_ROUNDS_MIN && value <= SUBAGENT_MAX_ROUNDS_MAX;
}
