import { describe, expect, it } from "vitest";
import { dockAssetArgs, readDockAssetArgs } from "../floating-dock-args.js";

const URLS = { pluginShellUrl: "file:///app/dist/src/plugin-ui-shell.html", pluginPreloadUrl: "file:///app/dist/src/plugin-preload.cjs" };

describe("floating dock asset arguments", () => {
  it("round-trips the URLs main resolves through the window's argv", () => {
    expect(readDockAssetArgs(["/Electron", "--type=renderer", ...dockAssetArgs(URLS)])).toEqual(URLS);
  });

  it.each([
    ["no arguments", []],
    ["only the shell", [dockAssetArgs(URLS)[0]!]],
    ["a non-file URL", dockAssetArgs({ ...URLS, pluginPreloadUrl: "https://example.test/plugin-preload.cjs" })],
  ])("refuses %s: the dock reports its bridge missing rather than mount from a guessed path", (_label, argv) => {
    expect(() => readDockAssetArgs(argv)).toThrow(/floating dock preload: main passed no ave-dock-plugin-(shell|preload) file URL/u);
  });
});
