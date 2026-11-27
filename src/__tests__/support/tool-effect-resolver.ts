import type { ToolEffectResolver } from "../../permissions/tool-effect-evidence.js";

export const unknownToolEffects: ToolEffectResolver = { effectOf: () => "unknown" };
