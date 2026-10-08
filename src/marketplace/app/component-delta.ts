import type { AgentPluginComponents } from "../catalog/types.js";

export interface ComponentIdentity {
  kind: "skill" | "mcp" | "prompt" | "agent" | "routine" | "hook";
  name: string;
  digest: string;
}

export interface ComponentDelta {
  added: ComponentIdentity[];
  removed: ComponentIdentity[];
  changed: ComponentIdentity[];
}

/** The digest, not only the display name, decides whether a component changed. */
export function componentInventory(components: AgentPluginComponents): ComponentIdentity[] {
  return [
    ...components.skills.map((item) => ({ kind: "skill" as const, name: item.name, digest: item.digest })),
    ...Object.entries(components.mcpServers).map(([name, item]) => ({ kind: "mcp" as const, name, digest: item.digest })),
    ...components.prompts.map((item) => ({ kind: "prompt" as const, name: item.name, digest: item.digest })),
    ...components.agents.map((item) => ({ kind: "agent" as const, name: item.name, digest: item.digest })),
    ...components.routineTemplates.map((item) => ({ kind: "routine" as const, name: item.id, digest: item.digest })),
    ...components.hooks.map((item, index) => ({ kind: "hook" as const, name: `${item.event}#${index}`, digest: item.digest })),
  ].sort((a, b) => `${a.kind}:${a.name}`.localeCompare(`${b.kind}:${b.name}`));
}

export function componentDelta(before: AgentPluginComponents, after: AgentPluginComponents): ComponentDelta {
  const prior = new Map(componentInventory(before).map((item) => [`${item.kind}:${item.name}`, item]));
  const next = new Map(componentInventory(after).map((item) => [`${item.kind}:${item.name}`, item]));
  return {
    added: [...next].filter(([key]) => !prior.has(key)).map(([, item]) => item),
    removed: [...prior].filter(([key]) => !next.has(key)).map(([, item]) => item),
    changed: [...next].filter(([key, item]) => prior.has(key) && prior.get(key)!.digest !== item.digest).map(([, item]) => item),
  };
}
