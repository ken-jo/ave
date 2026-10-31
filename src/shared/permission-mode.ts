/** Shared mode spelling keeps renderer consumers independent of the permission manager runtime. */
export const EXECUTION_MODES = ["strict", "default", "auto", "allow"] as const;

export const DEFAULT_EXECUTION_MODE = "strict" as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Use unknown before the first host read or for an unrecognized host value. */
export type ExecutionModeDisplay = ExecutionMode | "unknown";

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === "string" && (EXECUTION_MODES as readonly string[]).includes(value);
}

export function normalizeExecutionMode(raw: unknown): ExecutionModeDisplay {
  return isExecutionMode(raw) ? raw : "unknown";
}
