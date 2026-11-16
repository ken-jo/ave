import { useConfigurationOwner as configureTestOwner } from "../../__tests__/support/configuration-owner.js";

configureTestOwner();

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS } from "../settings-defaults.js";
import { createSettingsService } from "../../__tests__/support/settings-service.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "settings-boundary-validation-")); });
afterEach(async () => { await cleanupTmpDir(directory); });

describe("settings field validation at load and patch boundaries", () => {
  it.each(["unknown", 3, false, null, [], {}])("retains the selected web provider after an invalid patch %j", async (provider) => {
    const service = createSettingsService(directory);
    await service.patch({ webSearch: { provider: "tavily" } });
    await service.patch({ webSearch: { provider, injected: true } } as never);
    expect(service.get("webSearch")).toEqual({ provider: "tavily" });
    expect(createSettingsService(directory).get("webSearch")).toEqual({ provider: "tavily" });
  });

  it.each(["false", 1, null, [], {}])("retains the privacy choice after an invalid patch %j", async (piiRedactEnabled) => {
    const service = createSettingsService(directory);
    await service.patch({ privacy: { piiRedactEnabled: true } });
    await service.patch({ privacy: { piiRedactEnabled, injected: true } } as never);
    expect(service.get("privacy")).toEqual({ piiRedactEnabled: true });
    expect(createSettingsService(directory).get("privacy")).toEqual({ piiRedactEnabled: true });
  });

  it.each(["other", true, 4, {}, []])("retains stream smoothing after an invalid patch %j", async (streamSmoothing) => {
    const service = createSettingsService(directory);
    await service.patch({ llm: { streamSmoothing: "word" } });
    await service.patch({ llm: { streamSmoothing } } as never);
    expect(service.get("llm").streamSmoothing).toBe("word");
    expect(createSettingsService(directory).get("llm").streamSmoothing).toBe("word");
  });

  it("uses validated defaults for malformed stored values and drops unknown fields", async () => {
    const original = createSettingsService(directory);
    await original.patch({});
    const file = join(directory, "ave-settings.json");
    const baseline = original.getAll();
    writeFileSync(file, JSON.stringify({ ...baseline,
      webSearch: { provider: false, injected: true }, privacy: { piiRedactEnabled: "false", injected: true },
      llm: { ...baseline.llm, streamSmoothing: "invalid" },
    }));
    const loaded = createSettingsService(directory);
    expect(loaded.get("webSearch")).toEqual(DEFAULT_SETTINGS.webSearch);
    expect(loaded.get("privacy")).toEqual(DEFAULT_SETTINGS.privacy);
    expect(loaded.get("llm").streamSmoothing).toBe(DEFAULT_SETTINGS.llm.streamSmoothing);
    await loaded.patch({});
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored.webSearch).toEqual(DEFAULT_SETTINGS.webSearch);
    expect(stored.privacy).toEqual(DEFAULT_SETTINGS.privacy);
  });
});
