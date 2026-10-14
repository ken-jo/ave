import { describe, expect, it } from "vitest";
import { readBootWiring } from "../__tests__/support/boot-wiring-source.js";
import { readRepoFile } from "./test-helpers.js";

describe("main process plugin lifecycle regression guards", () => {
  it("bridges plugin events to every main window without dropping another window's bridge", async () => {
    // Every main window opened after boot (tray, "New Window", second launch,
    // macOS re-activation) goes through `registerMainWindowPluginEventBridge`,
    // which reaches `ctx.addPluginEventBridgeWindow` — one bridge per window,
    // so opening a second window must never dispose the first one's.
    const mainWindowSource = readRepoFile("src/main/main-window.ts");
    const traySource = readRepoFile("src/main/app-tray.ts");
    const bootSource = await readBootWiring();

    expect(traySource).toContain("registerMainWindowPluginEventBridge(win)");
    expect(mainWindowSource).toContain("getServices()?.registerPluginEventBridge?.(win)");
    expect(bootSource).toContain("registerPluginEventBridge: ctx.addPluginEventBridgeWindow");
    expect(bootSource).toContain("ctx.refreshPluginEventBridges();");
    // Boot-time registration for the first main window, and the per-window
    // registration call site itself (replacing it with a no-op must fail).
    expect(bootSource).toContain("ctx.addPluginEventBridgeWindow(mainWindow);");
    expect(bootSource).toContain("const dispose = registerPluginEventBridge(pluginRuntime, win");
    expect(bootSource).toContain("pluginEventBridges.set(win, dispose);");
    // No single-window replace path survives.
    expect(bootSource).not.toContain("replacePluginEventBridge");
    expect(bootSource).not.toContain("pluginEventBridgeWindow");
  });
});
