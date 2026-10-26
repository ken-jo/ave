import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsService } from "../settings-store.js";
import { DEFAULT_SETTINGS } from "../settings-defaults.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let directory: string;
let migrations: string[];
const load = () => new SettingsService({ userDataPath: directory, encryption: unavailableSecretEncryption });
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "settings-documents-"));
  const settings = load();
  await settings.patch({});
  migrations = settings.getAll().appliedMigrations!;
});
afterEach(async () => { await cleanupTmpDir(directory); });

describe("document opening settings", () => {
  it("defaults fresh and legacy settings to direct opening", async () => {
    expect(DEFAULT_SETTINGS).toHaveProperty("documents.openMode", "direct");
    expect(load().getAll()).toHaveProperty("documents.openMode", "direct");
    writeFileSync(join(directory, "ave-settings.json"), JSON.stringify({ appliedMigrations: migrations, chat: { autoCompact: false } }));
    const legacy = load();
    await legacy.patch({});
    const migrated = legacy.getAll();
    expect(migrated).toHaveProperty("documents.openMode", "direct");
    expect(migrated.chat.autoCompact).toBe(false);
  });

  it.each(["direct", "link"] as const)("persists the user's %s choice", async (openMode) => {
    const settings = load();
    await settings.patch({ documents: { openMode } });
    expect(load().getAll()).toHaveProperty("documents.openMode", openMode);
    expect(JSON.parse(readFileSync(join(directory, "ave-settings.json"), "utf8")))
      .toHaveProperty("documents.openMode", openMode);
  });

  it.each([null, [], "link", { openMode: "other" }, { openMode: true }].map((documents) => ({ documents })))("normalizes malformed stored settings $documents", async ({ documents }) => {
    writeFileSync(join(directory, "ave-settings.json"), JSON.stringify({ appliedMigrations: migrations, documents }));
    const settings = load();
    await settings.patch({});
    expect(settings.getAll()).toHaveProperty("documents.openMode", "direct");
  });

  it.each([null, [], "direct", { openMode: "other" }, { openMode: false }].map((documents) => ({ documents })))("rejects malformed patches $documents without resetting the user choice", async ({ documents }) => {
    const settings = load();
    await settings.patch({ documents: { openMode: "link" } });
    await settings.patch({ documents } as never);
    expect(load().getAll()).toHaveProperty("documents.openMode", "link");
  });
});
