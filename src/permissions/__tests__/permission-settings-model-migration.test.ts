import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readJudgeStoredModels, readPermissionSettings, setReviewerSettingsPersist } from "../permission-settings-store.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();
afterEach(async () => { await resources.cleanup(); });

function writeProfile(reviewer: Record<string, unknown>): string {
  const path = join(resources.makeTmpDir("reviewer-model-migration-"), "settings.json");
  writeFileSync(path, JSON.stringify({ permissions: { reviewer }, unrelated: { preserved: true } }));
  return path;
}

// Only permissions.judge.model selects the reviewer; legacy reviewer model fields must not reappear.
describe("retired reviewer model keys", () => {
  it.each([
    ["the removed built-in default", { provider: "openai", model: "gpt-4o-mini" }],
    ["an explicit older selection", { provider: "anthropic", model: "chosen-model" }],
  ])("drops %s on read and never promotes it to the judge model", (_name, legacy) => {
    const path = writeProfile({ mode: "llm", ...legacy });
    const reviewer = readPermissionSettings(path).permissions.reviewer;
    expect(reviewer).not.toHaveProperty("provider");
    expect(reviewer).not.toHaveProperty("model");
    expect(reviewer.mode).toBe("llm");
    expect(readJudgeStoredModels(path).reviewer).toBeNull();
  });

  it("removes the retired keys from the file on the next save without losing unrelated settings", async () => {
    const path = writeProfile({ mode: "llm", provider: "openai", model: "gpt-4o-mini" });
    await setReviewerSettingsPersist({ mode: "rule" }, path);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.permissions.reviewer.mode).toBe("rule");
    expect(saved.permissions.reviewer).not.toHaveProperty("provider");
    expect(saved.permissions.reviewer).not.toHaveProperty("model");
    expect(saved.unrelated).toEqual({ preserved: true });
  });
});
