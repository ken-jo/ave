import { describe, expect, it } from "vitest";
import { readBootWiring } from "../__tests__/support/boot-wiring-source.js";
import { readRepoFile } from "./test-helpers.js";

describe("main process plugin lifecycle regression guards", () => {
  it("bridges plugin events to every main window without dropping another window's bridge", async () => {
    // Each window owns its plugin-event bridge; opening another must not dispose existing bridges.
    const mainWindowSource = readRepoFile("src/main/main-window.ts");
    const traySource = readRepoFile("src/main/app-tray.ts");
    const bootSource = await readBootWiring();

    expect(traySource).toContain("registerMainWindowPluginEventBridge(win)");
    expect(mainWindowSource).toContain("getServices()?.registerPluginEventBridge?.(win)");
    expect(bootSource).toContain("registerPluginEventBridge: ctx.addPluginEventBridgeWindow");
    expect(bootSource).toContain("ctx.refreshPluginEventBridges();");
    expect(bootSource).toContain("ctx.addPluginEventBridgeWindow(mainWindow);");
    expect(bootSource).toContain("const dispose = registerPluginEventBridge(pluginRuntime, win");
    expect(bootSource).toContain("pluginEventBridges.set(win, dispose);");
    expect(bootSource).not.toContain("replacePluginEventBridge");
    expect(bootSource).not.toContain("pluginEventBridgeWindow");
  });
});
