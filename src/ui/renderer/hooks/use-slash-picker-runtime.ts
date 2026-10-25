/** Fetch live tool and skill catalogs on each picker open; missing host APIs leave honest empty lists. */
import { useEffect, useState } from "react";
import type {
  McpPromptEntry,
  McpToolEntry,
  SkillEntry,
} from "../components/slash-picker-data.js";
import type { AgentPluginTemplatePrompt } from "../../../shared/agent-plugin-prompt.js";

export interface SlashPickerRuntime {
  mcpTools: McpToolEntry[];
  /** Server-declared prompts — a USER-controlled primitive, never model-callable. */
  mcpPrompts: McpPromptEntry[];
  pluginPrompts: AgentPluginTemplatePrompt[];
  skills: SkillEntry[];
}

/**
 * One read of both live sources. The hook below subscribes with it; the native
 * command menu calls it directly at click time, because a menu is built and
 * popped in a single call and has nowhere to show a pending state — what it
 * draws must be what is connected at the moment it opens.
 */
export async function loadSlashPickerRuntime(): Promise<SlashPickerRuntime> {
  const [servers, skillResult, promptResult] = await Promise.all([
    (async () => (await window.ave?.mcp?.servers?.()) ?? [])(),
    (async () => await window.aveApi?.listSkills?.())(),
    (async () => await window.aveApi?.listPersonaPrompts?.())(),
  ]);
  const mcpTools: McpToolEntry[] = [];
  const mcpPrompts: McpPromptEntry[] = [];
  for (const s of servers) {
    if (s.status !== "connected") continue;
    for (const name of s.registeredTools) mcpTools.push({ name, serverId: s.id });
    for (const prompt of s.prompts ?? []) {
      mcpPrompts.push({
        name: prompt.name,
        serverId: s.id,
        ...(prompt.title ? { title: prompt.title } : {}),
        ...(prompt.description ? { description: prompt.description } : {}),
        arguments: (prompt.arguments ?? []).map((argument) => ({
          name: argument.name,
          ...(argument.description ? { description: argument.description } : {}),
          required: argument.required === true,
        })),
      });
    }
  }
  return {
    mcpTools,
    mcpPrompts,
    pluginPrompts: promptResult?.templates ?? [],
    skills: (skillResult?.skills ?? []).map((skill) => ({
      name: skill.name,
      description: skill.description,
    })),
  };
}

const EMPTY_RUNTIME: SlashPickerRuntime = { mcpTools: [], mcpPrompts: [], pluginPrompts: [], skills: [] };

export function useSlashPickerRuntime(enabled: boolean): SlashPickerRuntime {
  const [runtime, setRuntime] = useState<SlashPickerRuntime>(EMPTY_RUNTIME);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void loadSlashPickerRuntime().then((next) => {
      if (!cancelled) setRuntime(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return runtime;
}
