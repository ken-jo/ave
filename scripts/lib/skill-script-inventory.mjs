import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const SKILL_SCRIPT_ENTRIES = Object.freeze({ "edit-xlsx": "src/skills/xlsx-edit-cli.ts" });

export function assertSkillScriptInventory(directory) {
  if (!lstatSync(directory).isDirectory()) throw new Error("Skill script resources must be a real directory");
  const scripts = Object.keys(SKILL_SCRIPT_ENTRIES).map(name => `${name}.cjs`).sort();
  const expected = ["manifest.json", ...scripts].sort();
  const entries = readdirSync(directory, { withFileTypes: true });
  const actual = entries.map(entry => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Skill script inventory mismatch: unexpected [${actual.filter(name => !expected.includes(name)).join(", ")}], missing [${expected.filter(name => !actual.includes(name)).join(", ")}]`);
  }
  if (entries.some(entry => !entry.isFile())) throw new Error("Skill script resources must be regular files");
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
  if (manifest?.version !== 1 || !manifest.scripts || typeof manifest.scripts !== "object" || Array.isArray(manifest.scripts)
      || JSON.stringify(Object.keys(manifest.scripts).sort()) !== JSON.stringify(scripts)) {
    throw new Error("Skill script manifest does not match the canonical inventory");
  }
  for (const name of scripts) {
    const digest = createHash("sha256").update(readFileSync(join(directory, name))).digest("hex");
    if (manifest.scripts[name] !== digest) throw new Error(`Skill script digest mismatch: ${name}`);
  }
}
