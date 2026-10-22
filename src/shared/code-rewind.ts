export type RewindMode = "conversation" | "code" | "both";

export function isRewindMode(value: unknown): value is RewindMode {
  return value === "conversation" || value === "code" || value === "both";
}

export type RewindResult =
  | { ok: true; text: string; personaPromptId?: string }
  | { ok: false; error: string; conflictingFiles?: string[] };

/** Serialized snapshot budget, shared by all conversations in this profile. */
export const CODE_CHECKPOINT_POLICY = Object.freeze({
  maxStorageBytes: 64 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxSessionTurns: 100,
  maxTurns: 500,
});
