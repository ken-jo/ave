import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSkillScriptInventory, SKILL_SCRIPT_ENTRIES } from "../../scripts/lib/skill-script-inventory.mjs";

const require = createRequire(import.meta.url);
const PACKAGE = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { build: { beforePack: string } };
const beforePack = require(fileURLToPath(new URL(`../../${PACKAGE.build.beforePack}`, import.meta.url))) as (context: {
  electronPlatformName: string; packager: { projectDir: string };
}) => Promise<void>;
const temporary: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "skill-inventory-"));
  temporary.push(root);
  const directory = join(root, "dist", "skill-scripts");
  mkdirSync(directory, { recursive: true });
  const scripts: Record<string, string> = {};
  for (const name of Object.keys(SKILL_SCRIPT_ENTRIES)) {
    const filename = `${name}.cjs`;
    const bytes = Buffer.from(`module.exports = ${JSON.stringify(name)};\n`);
    writeFileSync(join(directory, filename), bytes);
    scripts[filename] = createHash("sha256").update(bytes).digest("hex");
  }
  const manifest = { version: 1, scripts };
  writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
  const main = join(root, "dist", "src", "main");
  mkdirSync(main, { recursive: true });
  writeFileSync(join(main, "bundle-manifest.json"), JSON.stringify({ mxcVerificationBuild: false, files: [] }));
  return { root, directory, manifest };
}

describe("packaged skill script inventory", () => {
  it("accepts exactly the generated scripts and matching manifest", () => {
    expect(() => assertSkillScriptInventory(fixture().directory)).not.toThrow();
    const generator = readFileSync(new URL("../../scripts/build-skill-scripts.mjs", import.meta.url), "utf8");
    expect(generator).toContain('import { SKILL_SCRIPT_ENTRIES } from "./lib/skill-script-inventory.mjs"');
    expect(generator).toContain("Object.entries(SKILL_SCRIPT_ENTRIES)");
  });

  it.each([false, true])("rejects a leaked generated wrapper even when its manifest entry is %s", (listed) => {
    const { directory, manifest } = fixture();
    const name = "xlsx-publication-012345abcdef.cjs";
    const bytes = Buffer.from("module.exports = 'owned fixture';\n");
    writeFileSync(join(directory, name), bytes);
    if (listed) {
      manifest.scripts[name] = createHash("sha256").update(bytes).digest("hex");
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
    }
    const before = readFileSync(join(directory, "manifest.json"));
    expect(() => assertSkillScriptInventory(directory)).toThrow(name);
    expect(readFileSync(join(directory, "manifest.json"))).toEqual(before);
    expect(readFileSync(join(directory, name))).toEqual(bytes);
  });

  it("rejects an extra manifest entry even when its file is absent", () => {
    const { directory, manifest } = fixture();
    manifest.scripts["xlsx-publication-012345abcdef.cjs"] = "0".repeat(64);
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest));
    expect(() => assertSkillScriptInventory(directory)).toThrow(/manifest does not match/);
  });

  it("rejects changed producer bytes and a missing canonical script", () => {
    const { directory } = fixture();
    const script = join(directory, "edit-xlsx.cjs");
    writeFileSync(script, "changed producer");
    expect(() => assertSkillScriptInventory(directory)).toThrow(/digest mismatch: edit-xlsx\.cjs/);
    rmSync(script);
    expect(() => assertSkillScriptInventory(directory)).toThrow(/missing \[edit-xlsx\.cjs\]/);
  });

  it("rejects an unexpected directory and a directory in place of a canonical script", () => {
    const { directory } = fixture();
    mkdirSync(join(directory, "leftover"));
    expect(() => assertSkillScriptInventory(directory)).toThrow(/unexpected \[leftover\]/);
    rmSync(join(directory, "leftover"), { recursive: true });
    const script = join(directory, "edit-xlsx.cjs");
    rmSync(script);
    mkdirSync(script);
    expect(() => assertSkillScriptInventory(directory)).toThrow(/regular files/);
  });

  it.each(["darwin", "linux"])("checks existing output before packaging the %s payload without a rebuild", async (platform) => {
    vi.stubEnv("AVE_MXC_VERIFICATION_BUILD", "0");
    const { root, directory } = fixture();
    const context = { electronPlatformName: platform, packager: { projectDir: root } };
    await expect(beforePack(context)).resolves.toBeUndefined();
    writeFileSync(join(directory, "xlsx-publication-012345abcdef.cjs"), "leftover fixture");
    await expect(beforePack(context)).rejects.toThrow(/xlsx-publication-012345abcdef\.cjs/);
  });

  it("rejects an extra script before entering native platform preparation", async () => {
    vi.stubEnv("AVE_MXC_VERIFICATION_BUILD", "0");
    const { root, directory } = fixture();
    writeFileSync(join(directory, "xlsx-publication-012345abcdef.cjs"), "leftover fixture");
    await expect(beforePack({ electronPlatformName: "win32", packager: { projectDir: root } }))
      .rejects.toThrow(/xlsx-publication-012345abcdef\.cjs/);
  });
});
