import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";
useConfigurationOwner();
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPermissionSettings, setReviewerSettingsPersist } from "../permission-settings-store.js";
import { PermissionTestResources } from "./test-resources.js";

const resources = new PermissionTestResources();
afterEach(async () => { await resources.cleanup(); });

describe("reviewer mode validation", () => {
  it.each(["strict", "rule"])("fails clearly on a stored retired %s mode without rewriting policy", mode => {
    const path = join(resources.makeTmpDir("reviewer-modes-"), "settings.json");
    const original = JSON.stringify({ permissions: { reviewer: { mode, fallbackOnError: "deny" } }, unrelated: true });
    writeFileSync(path, original);
    expect(() => readPermissionSettings(path)).toThrow(`Retired reviewer mode '${mode}'`);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each(["disabled", "llm"] as const)("preserves the supported %s mode on read and save", async mode => {
    const path = join(resources.makeTmpDir("reviewer-modes-"), "settings.json");
    writeFileSync(path, JSON.stringify({ permissions: { reviewer: { mode, fallbackOnError: "deny" } }, unrelated: true }));
    expect(readPermissionSettings(path).permissions.reviewer).toEqual({ mode, fallbackOnError: "deny" });
    await setReviewerSettingsPersist({ mode }, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ permissions: { reviewer: { mode, fallbackOnError: "deny" } }, unrelated: true });
  });

  it.each(["strict", "rule"])("rejects saving the retired %s mode", async mode => {
    const path = join(resources.makeTmpDir("reviewer-modes-"), "settings.json");
    await expect(setReviewerSettingsPersist({ mode } as never, path)).rejects.toThrow("permissions.reviewer.mode invalid");
  });
});
