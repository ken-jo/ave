import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RETIRED_PLUGIN_IDS, RETIRED_PLUGIN_PATTERNS, retiredPluginId, retiredPluginPattern } from "../../../scripts/lib/retired-plugin-ids.mjs";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** Retired IDs come from the naming gate inventory; live IDs still require review. */
const FORBIDDEN_PLUGIN_IDS = RETIRED_PLUGIN_PATTERNS;

/** Onboarding recommendations and display copy may name plugins; runtime dispatch may not hardcode IDs. */
const ALLOWED_DIRS = new Set(["onboarding", "i18n"]);

/** Every runtime source file is checked; routing has no plugin-ID exemptions. */

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      if (entry === "__tests__") continue;
      if (ALLOWED_DIRS.has(entry)) continue;
      files.push(...listSourceFiles(fullPath));
      continue;
    }
    if (stat.isFile() && SOURCE_EXTENSIONS.has(extname(entry))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("app runtime stays decoupled from plugin-specific tool names", () => {
  it("detects each retired id in the forms app code would spell it", () => {
    for (const entry of RETIRED_PLUGIN_IDS) {
      const id = retiredPluginId(entry);
      const pattern = retiredPluginPattern(entry);
      const camel = entry.words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
      for (const spelling of [`"${id}"`, `${id.replaceAll("-", "_")}_status`, `plugin:${id}`, `migrate${camel}Board`]) {
        expect(pattern.test(spelling), `${id}: ${spelling}`).toBe(true);
      }
    }
  });

  it("does not hard-code a retired plugin id in live app source", () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const content = readFileSync(file, "utf-8");
      for (const [id, pattern] of FORBIDDEN_PLUGIN_IDS) {
        if (pattern.test(content)) {
          violations.push(`${relative(SRC_ROOT, file)} names the retired plugin id '${id}'`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
