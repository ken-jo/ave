import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPermissionSettings, setReviewerSettingsPersist } from "../permission-settings-store.js";
import { createRiskClassifier } from "../reviewer/risk-classifier.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();
afterEach(async () => { await resources.cleanup(); });

function writeProfile(reviewer: Record<string, unknown>): string {
  const path = join(resources.makeTmpDir("reviewer-model-migration-"), "settings.json");
  writeFileSync(path, JSON.stringify({ permissions: { reviewer }, unrelated: { preserved: true } }));
  return path;
}

describe("stored reviewer default model migration", () => {
  it("clears the removed reviewer default once and persists without losing unrelated settings", () => {
    const path = writeProfile({ provider: "openai", model: "gpt-4o-mini" });
    const reviewer = readPermissionSettings(path).permissions.reviewer;
    expect(reviewer.model).toBe("");
    expect(reviewer.modelDefaultMigratedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.permissions.reviewer.model).toBe("");
    expect(saved.permissions.reviewer.modelDefaultMigratedAt).toBe(reviewer.modelDefaultMigratedAt);
    expect(saved.unrelated).toEqual({ preserved: true });
  });

  it("stamps other selections without changing another model, another provider or whitespace", () => {
    for (const [provider, model] of [
      ["openai", "chosen-model"],
      ["anthropic", "gpt-4o-mini"],
      ["openai", " gpt-4o-mini "],
    ]) {
      const path = writeProfile({ provider, model });
      const reviewer = readPermissionSettings(path).permissions.reviewer;
      expect(reviewer.modelDefaultMigratedAt).toEqual(expect.any(String));
      expect(reviewer.model).toBe(model);
    }
    const path = writeProfile({ model: "gpt-4o-mini" });
    expect(readPermissionSettings(path).permissions.reviewer.model).toBe("");
  });

  it("is idempotent and keeps a later choice of the removed id, including a marked profile", async () => {
    const path = writeProfile({ provider: "openai", model: "gpt-4o-mini" });
    const migrated = readPermissionSettings(path);
    expect(migrated.permissions.reviewer.model).toBe("");
    const bytes = readFileSync(path, "utf8");
    expect(readPermissionSettings(path)).toEqual(migrated);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    await setReviewerSettingsPersist({ model: "gpt-4o-mini" }, path);
    expect(readPermissionSettings(path).permissions.reviewer.model).toBe("gpt-4o-mini");
    expect(readPermissionSettings(path).permissions.reviewer.modelDefaultMigratedAt)
      .toBe(migrated.permissions.reviewer.modelDefaultMigratedAt);
    const marked = writeProfile({ provider: "openai", model: "gpt-4o-mini", modelDefaultMigratedAt: "2026-10-24T00:00:00.000Z" });
    expect(readPermissionSettings(marked).permissions.reviewer.model).toBe("gpt-4o-mini");
  });

  it("marks a fresh first write before applying the user's model choice", async () => {
    for (const oldBlock of [undefined, null, []]) {
      const path = join(resources.makeTmpDir("reviewer-model-first-write-"), "settings.json");
      if (oldBlock !== undefined) writeFileSync(path, JSON.stringify({ permissions: { reviewer: oldBlock } }));
      await setReviewerSettingsPersist({ model: "gpt-4o-mini" }, path);
      const reviewer = readPermissionSettings(path).permissions.reviewer;
      expect(reviewer.modelDefaultMigratedAt).toEqual(expect.any(String));
      expect(reviewer.model).toBe("gpt-4o-mini");
    }
  });

  it("rejects the migrated reviewer as not configured before a provider request", () => {
    const path = writeProfile({ mode: "llm", provider: "openai", model: "gpt-4o-mini" });
    const reviewer = readPermissionSettings(path).permissions.reviewer;
    const provider = { complete: vi.fn() };
    expect(() => createRiskClassifier({ ...reviewer, provider })).toThrow(/model.*not configured/i);
    expect(provider.complete).not.toHaveBeenCalled();
  });
});
