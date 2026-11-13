import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { dialog } from "electron";
import { transformSync } from "esbuild";
import * as ts from "typescript/unstable/ast";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSourceTexts } from "../../../scripts/lib/ts7-ast.mjs";
import { deferred } from "../../__tests__/support/deferred.js";
import { getLocale, setLocale } from "../../i18n/index.js";
import { AveHomeConfigurationUntrustedError } from "../../shared/ave-home.js";
import { showConfigurationBootError } from "../configuration-boot-error.js";
import { EXEC_FAILURE_EXIT_CODE, GUI_BOOT_FAILURE_EXIT_CODE } from "../exec-mode.js";

vi.mock("electron", () => ({ dialog: { showErrorBox: vi.fn() } }));
const locale = getLocale();
afterEach(() => { vi.mocked(dialog.showErrorBox).mockClear(); setLocale(locale); });

function bootstrapFailureHandler(options: { headless?: boolean; quitting?: boolean; cancelled?: boolean } = {}) {
  const source = readFileSync(join(import.meta.dirname, "..", "..", "main.ts"), "utf8");
  const syntax = parseSourceTexts(new Map([["main.ts", source]])).get("main.ts") as ts.SourceFile | undefined;
  if (!syntax) throw new Error("Boot entry could not be parsed");
  const callbacks: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "catch" && ts.isCallExpression(node.expression.expression)
      && ts.isIdentifier(node.expression.expression.expression) && node.expression.expression.expression.text === "main") {
      const callback = node.arguments[0];
      if (callback && ts.isArrowFunction(callback)) callbacks.push(callback.getText());
    }
    node.forEachChild(visit);
  };
  visit(syntax);
  expect(callbacks).toHaveLength(1);
  // Execute the entry's actual callback without starting the app; only its external effects are substituted.
  const script = transformSync(`(${callbacks[0]})`, {
    loader: "ts", format: "cjs", target: "es2022", supported: { "dynamic-import": false },
  }).code;
  const controller = new AbortController();
  if (options.cancelled) controller.abort();
  const quit = vi.fn();
  const showProviderError = vi.fn(async () => false);
  const context = {
    isAppQuitRequested: () => options.quitting ?? false,
    resourceStartupController: controller,
    bootLaunch: options.headless ? "headless" : "interactive",
    execRequest: options.headless ? {} : null,
    guiBootstrapFailed: false,
    process: { exitCode: undefined as number | undefined },
    GUI_BOOT_FAILURE_EXIT_CODE,
    EXEC_FAILURE_EXIT_CODE,
    log: { error: vi.fn() },
    bootstrapErrorForLog: (error: unknown) => error,
    showConfigurationBootError,
    require: (path: string) => {
      expect(path).toBe("./main/provider-settings-startup-error.js");
      return { showProviderSettingsStartupError: showProviderError };
    },
    app: { quit, getPath: () => join(import.meta.dirname, "fixture-home"), getLocale: () => "en" },
  };
  const handle = runInNewContext(script, context) as (error: unknown) => Promise<void>;
  return { handle, quit, showProviderError, context, controller };
}

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

  it("surfaces the native error before the bootstrap catch quits", async () => {
    setLocale("en");
    const boot = bootstrapFailureHandler();
    const presentation = deferred<boolean>();
    boot.showProviderError.mockReturnValueOnce(presentation.promise);
    const error = new AveHomeConfigurationUntrustedError(join(import.meta.dirname, "fixture-home", "config"), "Foreign child deletion rights");
    const stopped = boot.handle(error);
    try {
      expect(dialog.showErrorBox).toHaveBeenCalledOnce();
      expect(dialog.showErrorBox).toHaveBeenCalledWith("Ave cannot trust its configuration", expect.stringContaining(error.path));
      await vi.waitFor(() => expect(boot.showProviderError).toHaveBeenCalledOnce());
      expect(boot.quit).not.toHaveBeenCalled();
      presentation.resolve(false);
      await stopped;
      expect(boot.quit).toHaveBeenCalledOnce();
      const quitOrder = boot.quit.mock.invocationCallOrder[0];
      if (quitOrder === undefined) throw new Error("Quit was not observed");
      expect(vi.mocked(dialog.showErrorBox).mock.invocationCallOrder[0]).toBeLessThan(quitOrder);
      expect(boot.context.process.exitCode).toBe(GUI_BOOT_FAILURE_EXIT_CODE);
    } finally {
      presentation.resolve(false);
      await stopped;
    }
  });

  it("quits a headless configuration refusal without opening a dialog", async () => {
    const boot = bootstrapFailureHandler({ headless: true });
    await boot.handle(new AveHomeConfigurationUntrustedError(join(import.meta.dirname, "fixture-home", "config"), "Configuration marker content is invalid"));
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect(boot.showProviderError).not.toHaveBeenCalled();
    expect(boot.quit).toHaveBeenCalledOnce();
    expect(boot.context.process.exitCode).toBe(EXEC_FAILURE_EXIT_CODE);
  });

  it("does not open a late failure dialog after quit was requested", async () => {
    const boot = bootstrapFailureHandler({ quitting: true });
    await boot.handle(new AveHomeConfigurationUntrustedError(join(import.meta.dirname, "fixture-home", "config"), "Configuration marker content is invalid"));
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect(boot.showProviderError).not.toHaveBeenCalled();
    expect(boot.quit).toHaveBeenCalledOnce();
  });

  it("leaves an intentional startup cancellation with the shutdown owner", async () => {
    const boot = bootstrapFailureHandler({ quitting: true, cancelled: true });
    await boot.handle(boot.controller.signal.reason);
    expect(dialog.showErrorBox).not.toHaveBeenCalled();
    expect(boot.showProviderError).not.toHaveBeenCalled();
    expect(boot.quit).not.toHaveBeenCalled();
    expect(boot.context.process.exitCode).toBeUndefined();
  });
});
