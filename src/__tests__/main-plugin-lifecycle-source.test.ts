import { describe, expect, it } from "vitest";
import { readBootWiring } from "../__tests__/support/boot-wiring-source.js";
import { readRepoFile } from "./test-helpers.js";

describe("main process plugin lifecycle regression guards", () => {
  it("replaces plugin event bridge subscriptions when the main window is recreated", async () => {
    // The tray's window-recreation path re-registers the plugin event bridge
    // for the freshly created main window. C18: the bridge replacement wiring
    // moved from boot.ts into boot/steps/conversation-wiring.ts +
    // boot/assemble-services.ts as BootContext (`ctx.*`) fields.
    const traySource = readRepoFile("src/main/app-tray.ts");
    const bootSource = await readBootWiring();

    expect(traySource).toContain("registerMainWindowPluginEventBridge(mainWindow)");
    expect(bootSource).toContain("replacePluginEventBridge = (win: BrowserWindow | null) => {");
    expect(bootSource).toContain("pluginEventBridgeWindow = mainWindow;");
    expect(bootSource).toContain("pluginEventBridgeWindow = win;");
    expect(bootSource).toContain("disposePluginEventBridge();");
    expect(bootSource).toContain("replacePluginEventBridge(ctx.pluginEventBridgeWindow);");
    expect(bootSource).toContain("registerPluginEventBridge: ctx.replacePluginEventBridge");
    // The assertions above pin the replace/dispose CLOSURES. They do not pin
    // that the bridge is ever registered: replacing both call sites with
    // `ctx.disposePluginEventBridge = () => {}` left all 52 src/boot suites
    // (399 tests) green. These two pin the call sites themselves — boot-time
    // registration for the first main window, and re-registration for a
    // window recreated after `closed`.
    expect(bootSource).toContain(
      "ctx.disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, mainWindow",
    );
    expect(bootSource).toContain(
      "ctx.disposePluginEventBridge = registerPluginEventBridge(pluginRuntime, win",
    );
  });
});
