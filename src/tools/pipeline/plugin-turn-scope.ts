// Apply one plugin turn-scope rule to both tools and builtin skill loading (docs/development/README.md#skill-loading-policy).
import { parsePluginSkillSelector } from "../../shared/plugin-skill-selector.js";

export interface PluginTurnScopeToolFacts {
  readonly name: string;
  readonly source: string;
  readonly pluginId?: string;
}

export interface PluginTurnScopeTarget {
  // Unknown plugin ownership is null and must fail closed.
  readonly pluginId: string | null;
  readonly surface: "tool" | "skill";
}

// null means no plugin surface: ordinary builtins, external tools, or user skills.
export function pluginTurnScopeTarget(
  tool: PluginTurnScopeToolFacts,
  input: Record<string, unknown> | undefined,
): PluginTurnScopeTarget | null {
  if (tool.source === "plugin") {
    return { pluginId: tool.pluginId ?? null, surface: "tool" };
  }
  if (tool.name !== "skill_load") return null;
  const skillName = input?.skillName;
  if (typeof skillName !== "string") return null;
  const selector = parsePluginSkillSelector(skillName);
  // User skills have no plugin scope; malformed plugin selectors must be refused by the same pattern-backed allowlist.
  return selector ? { pluginId: selector.pluginId, surface: "skill" } : null;
}
