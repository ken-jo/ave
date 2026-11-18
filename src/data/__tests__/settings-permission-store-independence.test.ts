import { useConfigurationOwner as configureTestOwner } from "../../__tests__/support/configuration-owner.js";

configureTestOwner();

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsService } from "../../__tests__/support/settings-service.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { aveHome, ensureAveHomePrivate } from "../../shared/ave-home.js";
import { migrateAveHomeConfiguration } from "../../shared/ave-home-configuration.js";
import { withAveHomeConfigurationWrite } from "../../shared/ave-home-configuration-access.js";
import { writeUtf8FileAtomicSync } from "../../lib/atomic-file.js";
import { permissionSettingsPath, writePermissionSettings, setJudgeSettingsPersist } from "../../permissions/permission-settings-store.js";

let userDataPath: string;
beforeEach(() => {
  userDataPath = mkdtempSync(join(tmpdir(), "settings-permission-independence-"));
  migrateAveHomeConfiguration(aveHome(), ensureAveHomePrivate(aveHome()));
});
afterEach(async () => { await cleanupTmpDir(userDataPath); });

describe("application and permission settings store ownership", () => {
  it("preserves reviewer, judge model and directory choices across unrelated app settings saves", async () => {
    const settings = createSettingsService(userDataPath);
    await settings.patch({});
    const directory = join(userDataPath, "project");
    await writePermissionSettings({ additionalDirectories: [directory], reviewer: { mode: "disabled" } });
    await setJudgeSettingsPersist({ model: { vendor: "openai", model: "fixture-model" } }, undefined,
      { optionsFor: () => ["fixture-model"] });
    const permissionFile = permissionSettingsPath();
    const before = readFileSync(permissionFile, "utf8");
    const parsed = JSON.parse(before);
    expect(parsed.permissions).toMatchObject({ reviewer: { mode: "disabled" }, additionalDirectories: [directory],
      judge: { model: "openai/fixture-model" } });
    expect(settings.getSettingsFilePath()).not.toBe(permissionFile);
    await settings.patch({ chat: { autoCompact: !settings.get("chat").autoCompact }, permissions: { ownerAwayAutoSkipMinutes: 60 } });
    expect(readFileSync(permissionFile, "utf8")).toBe(before);
    expect(createSettingsService(userDataPath).get("permissions")?.ownerAwayAutoSkipMinutes).toBe(60);
  });

  it.each([
    '{"permissions":{"reviewer":{"mode":"invalid"},"judge":{"model":27},"additionalDirectories":["/synthetic/project"],"pendingWorkspaceRootRemovals":[{"malformed":true}]}}',
    '{"permissions":',
  ])("does not repair or overwrite unreadable permission data while saving app settings", async (raw) => {
    const settings = createSettingsService(userDataPath);
    await settings.patch({});
    const permissionFile = permissionSettingsPath();
    await withAveHomeConfigurationWrite(permissionFile, async (path) => { writeUtf8FileAtomicSync(path, raw, 0o600); });
    await settings.patch({ chat: { autoCompact: !settings.get("chat").autoCompact } });
    expect(readFileSync(permissionFile, "utf8")).toBe(raw);
  });
});
