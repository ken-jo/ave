import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomic } from "../lib/atomic-file.js";
import { assertAveHomeInputWritable, readAveHomeInput } from "../shared/ave-home-trust.js";

interface AgentRegistryEntry {
  id: string;
  version: string;
  source: "marketplace";
  manifestPath: string;
  profilePath: string;
  installedAt: string;
  enabled?: boolean;
  artifactSha256?: string;
  signerKeyId?: string;
}

export interface AgentRegistry {
  version: 1;
  agents: AgentRegistryEntry[];
}

/** Read for a rewrite through the verified loader: a registry pending review is refused before it is read (R4). */
async function readAgentRegistry(registryPath: string): Promise<AgentRegistry> {
  assertAveHomeInputWritable(registryPath);
  const input = await readAveHomeInput(registryPath);
  if (input.status === "absent") return { version: 1, agents: [] };
  const raw = input.bytes.toString("utf-8");
  const parsed = JSON.parse(raw) as Partial<AgentRegistry>;
  if (!Array.isArray(parsed.agents)) {
    throw new Error(`Invalid agent registry: ${registryPath}`);
  }
  return { version: 1, agents: parsed.agents };
}

async function writeAgentRegistry(registryPath: string, registry: AgentRegistry): Promise<void> {
  // The guarded atomic write records the new bytes in the home content trust manifest.
  await writeUtf8FileAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

export async function updateAgentRegistry(
  registryPath: string,
  mutator: (registry: AgentRegistry) => void | Promise<void>,
): Promise<void> {
  await withInProcessFileQueue(registryPath, async () => {
    const registry = await readAgentRegistry(registryPath);
    await mutator(registry);
    await writeAgentRegistry(registryPath, registry);
  });
}
