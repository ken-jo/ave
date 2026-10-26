import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const native = vi.hoisted(() => ({ showErrorBox: vi.fn() }));
vi.mock("electron", () => ({ dialog: { showErrorBox: native.showErrorBox } }));

import { SettingsService, settingsFilePath } from "../../data/settings-store.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";
import { showProviderSettingsStartupError } from "../provider-settings-startup-error.js";

describe("provider settings startup error", () => {
  it.each([
    ["en", { marketplace: { installedProviderIds: "invalid" } }, "marketplace.installedProviderIds", "Unable to load provider settings"],
    ["ko", { llm: { provider: "openai-compatible", vendors: { "openai-compatible": { wire: "invalid" } } } }, "llm.vendors.openai-compatible.wire", "공급자 설정을 불러올 수 없습니다"],
  ] as const)("shows the file and invalid field in %s without modifying the file", async (locale, settings, field, title) => {
    const userDataPath = mkdtempSync(join(tmpdir(), "provider-startup-error-"));
    try {
      const file = settingsFilePath(userDataPath);
      const source = JSON.stringify(settings);
      writeFileSync(file, source);
      let failure: unknown;
      try { new SettingsService({ userDataPath, encryption: unavailableSecretEncryption }); }
      catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(await showProviderSettingsStartupError(failure, userDataPath, locale)).toBe(true);
      expect(native.showErrorBox).toHaveBeenLastCalledWith(title, expect.stringContaining(file));
      expect(native.showErrorBox.mock.calls.at(-1)?.[1]).toContain(field);
      expect(readFileSync(file, "utf8")).toBe(source);
    } finally {
      await cleanupTmpDir(userDataPath);
    }
  });

  it("leaves unrelated startup failures to the caller", async () => {
    native.showErrorBox.mockClear();
    expect(await showProviderSettingsStartupError(new Error("unrelated"), tmpdir(), "en")).toBe(false);
    expect(native.showErrorBox).not.toHaveBeenCalled();
  });
});
