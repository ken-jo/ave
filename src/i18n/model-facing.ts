/**
 * Catalog keys whose text the model reads: system prompt sections, tool
 * descriptions and results, reviewer instructions (the `be_` namespace), the
 * shell execution environment the system prompt describes, and the routine
 * request the routine panel sends as the user's own message.
 *
 * An installed language package translates the interface only: it may not
 * carry these keys, and the compiled catalogs always answer them
 * (design §5.5). `model-facing-keys.test.ts` fails when a key reaches the
 * model from outside this set.
 */
const MODEL_FACING_PREFIXES = ["be_", "shellExecution."] as const;
const MODEL_FACING_KEYS: ReadonlySet<string> = new Set([
  "routinePanel.naturalRoutinePrompt",
  "pluginPromptOrigin.notDirectInput",
  "pluginPromptOrigin.packageAuthored",
  "pluginPromptOrigin.confirmBeforeAction",
]);

export function isModelFacingKey(key: string): boolean {
  return MODEL_FACING_KEYS.has(key) || MODEL_FACING_PREFIXES.some((prefix) => key.startsWith(prefix));
}
