import { useConfigurationOwner as configureConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

configureConfigurationOwner();

import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeFeatureFlags } from "../settings-normalization.js";
import { createSettingsService } from "../../__tests__/support/settings-service.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { containsSecuritySettings } from "../../shared/security-settings.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "settings-stale-shell-network-")); });
afterEach(async () => { await cleanupTmpDir(directory); });

// The Windows shell local-network consent setting is gone; a file saved while it existed still loads.
it.each([true, false])("loads a settings file that still carries the removed consent value %s", (stored) => {
  const file = join(directory, "ave-settings.json");
  writeFileSync(file, JSON.stringify({ features: { osToolSandbox: true, windowsShellLocalNetworkAccess: stored } }));
  const features = createSettingsService(directory).get("features");
  expect(features).toMatchObject({ osToolSandbox: true });
  expect(features).not.toHaveProperty("windowsShellLocalNetworkAccess");
  // The ordinary save on load keeps the rest of the file; nothing migrates the removed value.
  expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ features: { osToolSandbox: true } });
  expect(normalizeFeatureFlags({ windowsShellLocalNetworkAccess: stored })).not.toHaveProperty("windowsShellLocalNetworkAccess");
  expect(containsSecuritySettings({ features: { windowsShellLocalNetworkAccess: stored } })).toBe(false);
});
