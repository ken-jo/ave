import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivePluginGeneration } from "../../plugins/plugin-generation-coordinator.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PersonaPromptStore } from "../persona-prompt-store.js";
import { SkillStore } from "../skill-store.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ave-plugin-catalog-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => cleanupTmpDir(dir)));
});

function generation(
  pluginId: string,
  generationId: string,
  contribution: { kind: "skill" | "prompt"; localId: string; path: string; filePath: string; content: string },
): ActivePluginGeneration {
  const fingerprint = "a".repeat(64);
  return {
    pluginId,
    pluginVersion: "1.0.0",
    artifactGenerationId: "3".repeat(64),
    generationId,
    manifestSha256: "1".repeat(64),
    receiptSha256: "2".repeat(64),
    state: {},
    contributions: [{
      ownerPluginId: pluginId,
      ownerVersion: "1.0.0",
      kind: contribution.kind,
      localId: contribution.localId,
      path: contribution.path,
      fingerprint,
      files: [{ path: contribution.filePath, content: contribution.content, sha256: fingerprint }],
    }],
  };
}

function skillGeneration(pluginId: string, generationId: string): ActivePluginGeneration {
  return generation(pluginId, generationId, {
    kind: "skill",
    localId: "notes",
    path: "skills/notes",
    filePath: "skills/notes/SKILL.md",
    content: "---\nname: notes\ndescription: Notes guidance\n---\nbody",
  });
}

function promptGeneration(pluginId: string, kind: "template" | "persona" = "template"): ActivePluginGeneration {
  return generation(pluginId, "g1", {
    kind: "prompt",
    localId: "brief",
    path: "prompts/brief.md",
    filePath: "prompts/brief.md",
    content: `---\nname: brief\ndescription: Brief guidance\nkind: ${kind}\n---\nWrite a brief.`,
  });
}

describe("plugin catalog publication under concurrent plugin loads", () => {
  it("keeps a plugin's Skills published while another plugin's generation was being prepared", () => {
    const store = new SkillStore({ userDir: tempDir() });
    const first = store.preparePluginGeneration(skillGeneration("catalog_first", "g1"));
    const second = store.preparePluginGeneration(skillGeneration("catalog_second", "g1"));

    first.publish();
    second.publish();

    expect(store.listCatalogSync().map((entry) => entry.name)).toEqual([
      "plugin:catalog_first:notes",
      "plugin:catalog_second:notes",
    ]);
  });

  it("keeps a plugin's Skills published while another plugin's removal was being prepared", () => {
    const store = new SkillStore({ userDir: tempDir() });
    store.publishPluginGeneration(skillGeneration("catalog_first", "g1"));
    const removal = store.preparePluginRemoval("catalog_first", "g1");

    store.publishPluginGeneration(skillGeneration("catalog_second", "g1"));
    removal.publish();

    expect(store.listCatalogSync().map((entry) => entry.name)).toEqual(["plugin:catalog_second:notes"]);
  });

  it("keeps a plugin's prompts published while another plugin's generation was being prepared", () => {
    const store = new PersonaPromptStore({ userDir: tempDir() });
    const first = store.preparePluginGeneration(promptGeneration("catalog_first"));
    const second = store.preparePluginGeneration(promptGeneration("catalog_second"));

    first.publish();
    second.publish();

    expect(store.listTemplates().map((template) => template.id)).toEqual([
      "extension:catalog_first:brief",
      "extension:catalog_second:brief",
    ]);
  });

  it("keeps a plugin's prompts published while another plugin's removal was being prepared", () => {
    const store = new PersonaPromptStore({ userDir: tempDir() });
    store.preparePluginGeneration(promptGeneration("catalog_first")).publish();
    const removal = store.preparePluginRemoval("catalog_first");

    store.preparePluginGeneration(promptGeneration("catalog_second")).publish();
    removal.publish();

    expect(store.listTemplates().map((template) => template.id)).toEqual(["extension:catalog_second:brief"]);
  });

  it("keeps a plugin's personas published while another plugin's generation was being prepared", async () => {
    const store = new PersonaPromptStore({ userDir: tempDir() });
    const first = store.preparePluginGeneration(promptGeneration("first-plugin", "persona"));
    const second = store.preparePluginGeneration(promptGeneration("second-plugin", "persona"));

    first.publish();
    second.publish();

    expect((await store.list()).map((persona) => persona.id)).toEqual([
      "extension:first-plugin:brief",
      "extension:second-plugin:brief",
    ]);
    expect(await store.get("extension:first-plugin:brief")).toMatchObject({ systemPromptAdd: "Write a brief." });
  });

  it("keeps a plugin's personas published while another plugin's removal was being prepared", async () => {
    const store = new PersonaPromptStore({ userDir: tempDir() });
    store.preparePluginGeneration(promptGeneration("first-plugin", "persona")).publish();
    const removal = store.preparePluginRemoval("first-plugin");

    store.preparePluginGeneration(promptGeneration("second-plugin", "persona")).publish();
    removal.publish();

    expect(await store.get("extension:first-plugin:brief")).toBeNull();
    expect(await store.get("extension:second-plugin:brief")).toMatchObject({ systemPromptAdd: "Write a brief." });
  });
});
