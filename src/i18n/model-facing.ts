/** Catalog keys for system prompts, tool descriptions and results, reviewer instructions,
 * shell execution guidance, routine requests, and notices recorded in conversation history.
 * Compiled catalogs supply these keys. `model-facing-keys.test.ts` guards their coverage. */
const MODEL_FACING_PREFIXES = ["be_", "shellExecution.", "sandboxPolicy."] as const;
const MODEL_FACING_KEYS: ReadonlySet<string> = new Set([
  "app.retiredModelNoticeTitle",
  "routinePanel.naturalRoutinePrompt",
  "pluginPromptOrigin.notDirectInput",
  "pluginPromptOrigin.packageAuthored",
  "pluginPromptOrigin.confirmBeforeAction",
]);

export function isModelFacingKey(key: string): boolean {
  return MODEL_FACING_KEYS.has(key) || MODEL_FACING_PREFIXES.some((prefix) => key.startsWith(prefix));
}
