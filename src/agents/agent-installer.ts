/**
 * Removal of agent packages the retired marketplace server installed under
 * `~/.ave/agents/`. New agent packages arrive through the git marketplace
 * (design §16.2); these installs stay removable.
 */
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isResolvedPathWithin } from "../plugins/plugin-storage-containment.js";
import { AGENT_NAME_ALLOWLIST } from "../main/agent-profile-store.js";
import { updateAgentRegistry } from "./agent-registry.js";

export async function uninstallAgentPackage(
  slug: string,
  opts: { installRoot: string; registryPath: string },
): Promise<{ agentId: string; slug: string; uninstalled: true }> {
  if (!AGENT_NAME_ALLOWLIST.test(slug)) {
    throw new Error(`invalid agent package id: ${slug}`);
  }
  let found = false;
  await updateAgentRegistry(opts.registryPath, (registry) => {
    const before = registry.agents.length;
    registry.agents = registry.agents.filter((entry) => entry.id !== slug);
    found = registry.agents.length !== before;
  });
  if (!found) throw new Error(`Agent package not installed: ${slug}`);
  const target = resolve(opts.installRoot, slug);
  if (!isResolvedPathWithin(opts.installRoot, target)) {
    throw new Error(`refusing to remove outside agent install root: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
  return { agentId: slug, slug, uninstalled: true };
}
