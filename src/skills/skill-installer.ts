/**
 * Removal of skill packages the retired marketplace server installed under
 * `~/.ave/skills/`. New skill packages arrive through the git marketplace
 * (design §16.2); these installs stay removable.
 */
import { resolve } from "node:path";
import { isResolvedPathWithin } from "../plugins/plugin-storage-containment.js";
import { forgetAveHomeInputSync, removeNoFollow } from "../shared/ave-home-trust.js";
import { SKILL_NAME_ALLOWLIST } from "../main/skill-store.js";
import { updateSkillRegistry } from "./skill-registry.js";

export async function uninstallSkillPackage(
  slug: string,
  opts: { installRoot: string; registryPath: string },
): Promise<{ skillId: string; slug: string; uninstalled: true }> {
  if (!SKILL_NAME_ALLOWLIST.test(slug)) {
    throw new Error(`invalid skill package id: ${slug}`);
  }
  let found = false;
  await updateSkillRegistry(opts.registryPath, (registry) => {
    const before = registry.skills.length;
    registry.skills = registry.skills.filter((entry) => entry.id !== slug);
    found = registry.skills.length !== before;
  });
  if (!found) throw new Error(`Skill package not installed: ${slug}`);
  const target = resolve(opts.installRoot, slug);
  if (!isResolvedPathWithin(opts.installRoot, target)) {
    throw new Error(`refusing to remove outside skill install root: ${target}`);
  }
  // No-follow removal: a link or junction inside the package is unlinked, never followed into its target.
  removeNoFollow(target);
  forgetAveHomeInputSync(target);
  return { skillId: slug, slug, uninstalled: true };
}
