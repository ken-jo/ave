import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SkillStore } from "../main/skill-store.js";
import type { AgentProfileStore } from "../main/agent-profile-store.js";
import type { PersonaPromptStore } from "../main/persona-prompt-store.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { McpManager } from "../mcp/mcp-manager.js";
import type { McpServerConfigDto } from "../mcp/types.js";
import type { StudioAvailableParts, StudioOrigin, StudioWriteRequest } from "../shared/plugin-studio.js";

const COMPONENT = /^[a-z][a-z0-9-]{0,62}$/u;

export interface StudioReferenceSources {
  skillStore?: SkillStore;
  agentProfileStore?: AgentProfileStore;
  personaPromptStore?: PersonaPromptStore;
  routinesStore?: RoutinesStore;
  mcpManager?: McpManager;
  getMcpConfigs?: () => Promise<McpServerConfigDto[]>;
}

async function configuredConnectors(sources: StudioReferenceSources): Promise<McpServerConfigDto[]> {
  return sources.getMcpConfigs?.() ?? sources.mcpManager?.getConfigs() ?? [];
}

export async function listStudioParts(sources: StudioReferenceSources): Promise<StudioAvailableParts> {
  const [skills, agents, prompts, connectors] = await Promise.all([
    sources.skillStore?.list() ?? [], sources.agentProfileStore?.list() ?? [],
    sources.personaPromptStore?.list() ?? [], configuredConnectors(sources),
  ]);
  return {
    skills: skills.filter((item) => COMPONENT.test(item.name)).map(({ name, description }) => ({ name, description })),
    routines: (sources.routinesStore?.list() ?? []).map((item) => ({ name: item.id, description: item.title ?? item.id })),
    connectors: connectors.map((item) => ({ name: item.id, description: item.transport })),
    prompts: prompts.filter((item) => COMPONENT.test(item.id)).map((item) => ({ name: item.id, description: item.description })),
    agents: agents.filter((item) => COMPONENT.test(item.name)).map(({ name, description }) => ({ name, description })),
  };
}

async function skillFiles(name: string, entry: string): Promise<Array<{ path: string; data: Buffer }>> {
  const root = dirname(entry);
  const files: Array<{ path: string; data: Buffer }> = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error(`Skill ${name} contains a symbolic link`);
      if (item.isDirectory()) await walk(join(dir, item.name), path);
      else if (item.isFile()) files.push({ path: `skills/${name}/${path}`, data: await readFile(join(dir, item.name)) });
      else throw new Error(`Skill ${name} contains a non-file`);
      if (files.length > 64) throw new Error(`Skill ${name} exceeds the file limit`);
    }
  };
  await walk(root, "");
  return files;
}

/** Resolve identities from current stores at the boundary; never accept model-supplied paths. */
export async function resolveStudioReferences(input: StudioWriteRequest, sources: StudioReferenceSources): Promise<Array<{ path: string; data: Buffer; origin: StudioOrigin }>> {
  const copied: Array<{ path: string; data: Buffer; origin: StudioOrigin }> = [];
  const references = input.references ?? [];
  if (!Array.isArray(references) || references.length > 64) throw new Error("Studio references are invalid");
  const [skills, agents, prompts] = await Promise.all([
    sources.skillStore?.list() ?? [], sources.agentProfileStore?.list() ?? [], sources.personaPromptStore?.list() ?? [],
  ]);
  const templates: Array<Record<string, unknown>> = [];
  for (const reference of references) {
    if (!reference || typeof reference.name !== "string") throw new Error("Studio reference is invalid");
    switch (reference.kind) {
      case "skill": {
        const skill = skills.find((item) => item.name === reference.name);
        if (!skill || !COMPONENT.test(skill.name)) throw new Error(`Skill ${reference.name} is not available`);
        const origin: StudioOrigin = skill.agentPluginOwner
          ? { kind: "copied", from: { kind: "agent-plugin", name: skill.agentPluginOwner.packageName, version: skill.agentPluginOwner.version } }
          : { kind: "user-store", path: skill.filePath };
        for (const file of await skillFiles(skill.name, skill.filePath)) copied.push({ ...file, origin });
        break;
      }
      case "prompt": {
        const prompt = prompts.find((item) => item.id === reference.name);
        if (!prompt || !COMPONENT.test(prompt.id)) throw new Error(`Prompt ${reference.name} is not available`);
        const text = `---\nname: ${prompt.id}\ndescription: ${JSON.stringify(prompt.description || prompt.name)}\nkind: persona\n---\n${prompt.systemPromptAdd}\n`;
        copied.push({ path: `ai.agent-connector.ave/prompts/${prompt.id}.md`, data: Buffer.from(text), origin: { kind: "user-store", path: prompt.filePath } });
        break;
      }
      case "agent": {
        const agent = agents.find((item) => item.name === reference.name);
        if (!agent || !COMPONENT.test(agent.name)) throw new Error(`Profile ${reference.name} is not available`);
        copied.push({ path: `ai.agent-connector.ave/agents/${agent.name}/AGENTS.md`, data: await readFile(agent.filePath), origin: { kind: "user-store", path: agent.filePath } });
        break;
      }
      case "routine": {
        const routine = sources.routinesStore?.list().find((item) => item.id === reference.name);
        if (!routine) throw new Error(`Routine ${reference.name} is not available`);
        const id = `routine-${routine.id.replace(/[^a-z0-9-]/giu, "-").toLowerCase().slice(0, 54)}`;
        const template: Record<string, unknown> = { id, title: routine.title ?? id,
          description: routine.title ?? id, trigger: routine.trigger, execution: routine.execution,
          ...(routine.schedule ? { schedule: routine.schedule } : {}),
          ...(routine.prePrompt ? { prePrompt: routine.prePrompt } : {}),
          ...(routine.notificationTitle ? { notificationTitle: routine.notificationTitle } : {}),
          ...(routine.notificationBody ? { notificationBody: routine.notificationBody } : {}),
          ...(routine.scope?.pluginIds.mode === "allow" ? { suggestedScope: { pluginIds: routine.scope.pluginIds.ids } } : {}),
        };
        templates.push(template);
        break;
      }
      case "connector": {
        const connector = (await configuredConnectors(sources)).find((item) => item.id === reference.name);
        if (!connector) throw new Error(`Connector ${reference.name} is not available`);
        break;
      }
      default: throw new Error("Studio reference kind is unsupported");
    }
  }
  if (templates.length) copied.push({ path: "ai.agent-connector.ave/routines.json", data: Buffer.from(`${JSON.stringify({ version: 1, templates }, null, 2)}\n`),
    origin: { kind: "copied", from: { kind: "routine", name: templates.map((item) => item.id).join(",") } } });
  return copied;
}
