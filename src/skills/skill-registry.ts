import { withInProcessFileQueue } from "../lib/with-file-lock.js";
import { writeUtf8FileAtomic } from "../lib/atomic-file.js";
import { assertAveHomeInputWritable, readAveHomeInput } from "../shared/ave-home-trust.js";

interface SkillRegistryEntry {
  id: string;
  version: string;
  source: "marketplace";
  manifestPath: string;
  skillPath: string;
  installedAt: string;
  enabled?: boolean;
  artifactSha256?: string;
  signerKeyId?: string;
}

export interface SkillRegistry {
  version: 1;
  skills: SkillRegistryEntry[];
}

/** Read for a rewrite through the verified loader: a registry pending review is refused before it is read (R4). */
async function readSkillRegistry(registryPath: string): Promise<SkillRegistry> {
  assertAveHomeInputWritable(registryPath);
  const input = await readAveHomeInput(registryPath);
  if (input.status === "absent") return { version: 1, skills: [] };
  const raw = input.bytes.toString("utf-8");
  const parsed = JSON.parse(raw) as Partial<SkillRegistry>;
  if (!Array.isArray(parsed.skills)) {
    throw new Error(`Invalid skill registry: ${registryPath}`);
  }
  return { version: 1, skills: parsed.skills };
}

async function writeSkillRegistry(registryPath: string, registry: SkillRegistry): Promise<void> {
  // The guarded atomic write records the new bytes in the home content trust manifest.
  await writeUtf8FileAtomic(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
}

export async function updateSkillRegistry(
  registryPath: string,
  mutator: (registry: SkillRegistry) => void | Promise<void>,
): Promise<void> {
  await withInProcessFileQueue(registryPath, async () => {
    const registry = await readSkillRegistry(registryPath);
    await mutator(registry);
    await writeSkillRegistry(registryPath, registry);
  });
}
