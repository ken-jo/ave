import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dialog } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../i18n/index.js";
import { AveHomeConfigurationUntrustedError } from "../../shared/ave-home.js";
import { showConfigurationBootError } from "../configuration-boot-error.js";

vi.mock("electron", () => ({ dialog: { showErrorBox: vi.fn() } }));
const locale = getLocale();
afterEach(() => { vi.mocked(dialog.showErrorBox).mockClear(); setLocale(locale); });

describe("configuration boot refusal", () => {
  it("limits configuration migration to the shared host instance owner", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "..", "boot.ts"), "utf8");
    expect(source).not.toContain("setAveHomeConfigurationOwner(");
    expect(source).toContain("const configurationDiagnostics = isAveHomeConfigurationOwner()");
    expect(source).toContain("? migrateAveHomeConfiguration(homePrivacy.home, homePrivacy) : []");
    const lock = readFileSync(join(import.meta.dirname, "..", "host-instance-lock.ts"), "utf8");
    expect(lock).toContain('database.exec("BEGIN EXCLUSIVE")');
    expect(lock).toContain("setAveHomeConfigurationOwner({ hasSingleInstanceLock: () => processLock?.open === true && processLock.inTransaction })");
    for (const entry of ["desktop-boot.ts", "headless-host.ts"]) {
      const caller = readFileSync(join(import.meta.dirname, "..", "..", entry), "utf8");
      expect(caller).toContain("await acquireHostInstanceLock()");
    }
  });
  it("shows the path cause and recovery instructions in English", () => {
    setLocale("en");
    const path = join(import.meta.dirname, "fixture-home", "config");
    showConfigurationBootError(new AveHomeConfigurationUntrustedError(path, "Foreign child deletion rights"));
    expect(dialog.showErrorBox).toHaveBeenCalledWith("Ave cannot trust its configuration", expect.stringContaining(path));
    expect(vi.mocked(dialog.showErrorBox).mock.calls[0]![1]).toContain("Foreign child deletion rights");
    expect(vi.mocked(dialog.showErrorBox).mock.calls[0]![1]).toContain("Remove other accounts' write and delete access");
    expect(vi.mocked(dialog.showErrorBox).mock.calls[0]![1]).toContain("restart Ave");
  });

  it("shows the path cause and recovery instructions in Korean", () => {
    setLocale("ko");
    const path = join(import.meta.dirname, "fixture-home", "config");
    showConfigurationBootError(new AveHomeConfigurationUntrustedError(path, "Configuration marker content is invalid"));
    expect(dialog.showErrorBox).toHaveBeenCalledWith("Ave 설정을 신뢰할 수 없습니다", expect.stringContaining(path));
    expect(vi.mocked(dialog.showErrorBox).mock.calls[0]![1]).toContain("Configuration marker content is invalid");
    expect(vi.mocked(dialog.showErrorBox).mock.calls[0]![1]).toContain("다른 계정의 쓰기 및 삭제 권한을 제거");
    expect(vi.mocked(dialog.showErrorBox).mock.calls[0]![1]).toContain("Ave를 다시 시작");
  });

  it("does not show a configuration dialog for unrelated boot failures", () => {
    showConfigurationBootError(new Error("Unrelated bootstrap failure"));
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
  });

  it("surfaces the native error before the bootstrap catch quits", () => {
    const source = readFileSync(join(import.meta.dirname, "..", "..", "main.ts"), "utf8");
    const start = source.indexOf("void main().catch(async (error) => {");
    expect(start).toBeGreaterThanOrEqual(0);
    const handler = source.slice(start, source.indexOf("\n    });", start));
    expect(handler).toContain('if (bootLaunch !== "headless" && execRequest === null) {');
    expect(handler).toContain("showConfigurationBootError(error);");
    expect(handler.indexOf("showConfigurationBootError(error)")).toBeLessThan(handler.indexOf("app.quit()"));
  });
});
