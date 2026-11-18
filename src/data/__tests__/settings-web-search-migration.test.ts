import { useConfigurationOwner as configureTestOwner } from "../../__tests__/support/configuration-owner.js";

configureTestOwner();

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsService } from "../../__tests__/support/settings-service.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "settings-web-search-migration-")); });
afterEach(async () => { await cleanupTmpDir(directory); });

describe("retired web search provider migration", () => {
  it("rewrites the unsupported legacy provider to the implemented keyless provider", async () => {
    const original = createSettingsService(directory);
    await original.patch({});
    const file = join(directory, "ave-settings.json");
    writeFileSync(file, JSON.stringify({ ...original.getAll(), webSearch: { provider: "google" } }));
    const migrated = createSettingsService(directory);
    expect(migrated.get("webSearch").provider).toBe("duckduckgo");
    await migrated.patch({});
    expect(JSON.parse(readFileSync(file, "utf8")).webSearch.provider).toBe("duckduckgo");
  });
});
