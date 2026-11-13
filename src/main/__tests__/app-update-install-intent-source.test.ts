import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("app update install intent source contract", () => {
  it("lets updater-owned window close bypass hide-to-tray", () => {
    const source = readFileSync(new URL("../main-window.ts", import.meta.url), "utf8");
    const closeHandlerStart = source.indexOf('win.on("close"');
    const closeHandler = source.slice(
      closeHandlerStart,
      source.indexOf('win.on("closed"', closeHandlerStart),
    );
    expect(closeHandler).toContain("if (isAppUpdateInstallRequested()) return;");
    expect(closeHandler.indexOf("isAppUpdateInstallRequested")).toBeLessThan(
      closeHandler.indexOf("event.preventDefault();"),
    );
  });

  it("runs cleanup before resuming updater-owned before-quit", () => {
    const mainSource = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
    expect(mainSource).toContain('app.on("before-quit", createAppBeforeQuitHandler({');
    expect(mainSource).toContain("app.quit();");
    const shutdownSource = readFileSync(new URL("../app-shutdown.ts", import.meta.url), "utf8");
    const handlerStart = shutdownSource.indexOf("export function createAppBeforeQuitHandler");
    const source = shutdownSource.slice(handlerStart, shutdownSource.indexOf("async function flushLogger", handlerStart));
    expect(source).toContain("if (isAppUpdateInstallPrepared()) return;");
    expect(source).toContain('reason: appUpdateInstallRequested ? "app-update-install" : "before-quit"');
    expect(source).toContain("markAppUpdateInstallPrepared();");
    const cleanup = source.indexOf("await runAppShutdownCleanup({");
    const prepared = source.indexOf("markAppUpdateInstallPrepared();");
    expect(cleanup).toBeGreaterThan(-1);
    expect(prepared).toBeGreaterThan(cleanup);
    expect(source.indexOf("options.quit(", prepared)).toBeGreaterThan(prepared);
  });

  it("keeps boot-time plugin cleanup in the ordered shutdown lifecycle", () => {
    const pluginSource = readFileSync(new URL("../../boot/steps/plugin-runtime.ts", import.meta.url), "utf8");
    expect(pluginSource).toContain("registerBootPluginShutdown({");
    expect(pluginSource).toContain("closeAdmission: () => pluginRuntime.beginShutdown()");
    expect(pluginSource).toContain("stopRuntime: (signal) => pluginRuntime.stopAll({ signal })");
    const shutdownSource = readFileSync(new URL("../app-shutdown.ts", import.meta.url), "utf8");
    const incompleteBootStart = shutdownSource.indexOf("export async function runIncompleteBootShutdown");
    const incompleteBoot = shutdownSource.slice(incompleteBootStart, shutdownSource.indexOf("export async function runAppShutdownCleanup", incompleteBootStart));
    expect(incompleteBoot).toContain("() => bootPluginShutdown?.closeAdmission()");
    expect(incompleteBoot.indexOf("bootPluginShutdown?.closeAdmission()")).toBeLessThan(
      incompleteBoot.indexOf("bootMcpDisconnect?.()"),
    );
    expect(incompleteBoot.indexOf("bootMcpDisconnect?.()")).toBeLessThan(
      incompleteBoot.indexOf("bootPluginShutdown?.stopRuntime(signal)"),
    );
    const normalShutdown = shutdownSource.slice(shutdownSource.indexOf("export async function runAppShutdownCleanup"));
    expect(normalShutdown).toContain("svc.pluginRuntime.beginShutdown();");
    expect(normalShutdown).toContain("await svc.shutdown?.();");
    expect(normalShutdown).toContain("await svc.pluginRuntime.stopAll({ signal });");
    expect(normalShutdown.indexOf("svc.pluginRuntime.beginShutdown()")).toBeLessThan(
      normalShutdown.indexOf("await svc.shutdown?.()"),
    );
    expect(normalShutdown.indexOf("await svc.shutdown?.()")).toBeLessThan(
      normalShutdown.indexOf("await svc.pluginRuntime.stopAll({ signal })"),
    );
    const source = readFileSync(new URL("../../boot/desktop-host-runtime.ts", import.meta.url), "utf8");
    const beforeQuitStart = source.indexOf('app.once("before-quit"');
    const beforeQuitHandler = source.slice(
      beforeQuitStart,
      source.indexOf("initializeNotificationPresenter:", beforeQuitStart),
    );
    expect(beforeQuitHandler).toContain(
      "if (isAppUpdateInstallRequested() || isAppShutdownStarted() || !needed()) return;",
    );
    expect(beforeQuitHandler.indexOf("isAppUpdateInstallRequested")).toBeLessThan(
      beforeQuitHandler.indexOf("event.preventDefault();"),
    );
    expect(beforeQuitHandler.indexOf("isAppShutdownStarted")).toBeLessThan(
      beforeQuitHandler.indexOf("event.preventDefault();"),
    );
  });
});
