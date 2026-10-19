import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RETIRED_PLUGIN_IDS, RETIRED_PLUGIN_PATTERNS, retiredPluginId, retiredPluginPattern } from "../../../scripts/lib/retired-plugin-ids.mjs";

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

/**
 * Retired plugin ids, from the one list the retired-name gate also reads. A
 * live plugin id must not be hard-coded in app runtime either, but those are
 * found by review; a retired one is found here and by the gate.
 */
const FORBIDDEN_PLUGIN_IDS = RETIRED_PLUGIN_PATTERNS;

/**
 * Directories where literal plugin-id references are by-design allowed:
 *   - `onboarding/` — discovery cards, tour scenarios, plugin-recommendation
 *     matrices. The whole purpose of these files is to *recommend specific
 *     plugins* to a fresh user; that recommendation list MUST mention
 *     concrete plugin ids. The rule the host-runtime decoupling test
 *     guards (host does not *invoke* a plugin by hardcoded id) is a
 *     different concern from onboarding's recommendation data tables.
 *   - `i18n/` — the translation catalog (seed + generated fragments). These
 *     are pure display copy: onboarding tour / recommendation strings that
 *     were extracted out of `onboarding/` during the i18n migration legitimately
 *     name plugins (e.g. "select agents from the meeting plugin"). Naming a
 *     plugin in UI copy is the same allowed concern as onboarding above — never
 *     a runtime invocation of a plugin by hardcoded id.
 */
const ALLOWED_DIRS = new Set(["onboarding", "i18n"]);

/**
 * No file is exempt. `plugins/isolation/out-of-process-plugins.ts` used to
 * name plugin ids as the routing census of the process boundary; since
 * Admission (`docs/design/plugin-hostapi-protocol.md` §9.8 A1, decision 50)
 * routing has no input and that census is gone, so every source file is held
 * to the same rule.
 */

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
