import { describe, expect, it } from "vitest";
import { buildTitlebarCss, buildTitlebarHtml } from "../window-titlebar-shell.js";

const order = (html: string) => [...html.matchAll(/id="(minimize|maximize|close|title)"/g)].map((match) => match[1]);

describe("link/auth shell titlebar", () => {
  it("draws no bottom rule on any platform, as the main window's band", () => {
    expect(buildTitlebarCss()).not.toMatch(/border-bottom/);
  });

  it("leads with close, minimize, maximize on Linux and trails with minimize, maximize, close on Windows", () => {
    const linux = buildTitlebarHtml({ platform: "linux", title: "Link" });
    expect(order(linux)).toEqual(["close", "minimize", "maximize", "title"]);
    expect(linux).toContain('class="titlebar titlebar-leading"');
    const windows = buildTitlebarHtml({ platform: "win32", title: "Link" });
    expect(order(windows)).toEqual(["title", "minimize", "maximize", "close"]);
    expect(windows).not.toContain("titlebar-leading");
  });

  it("leaves macOS to its own lights", () => {
    expect(order(buildTitlebarHtml({ platform: "darwin", title: "Link" }))).toEqual([]);
  });

  it("takes its sizes from the shared shell geometry", () => {
    const css = buildTitlebarCss();
    expect(css).toMatch(/\.titlebar-btn \{\s*width: 44px;\s*height: 36px;/);
    expect(css).toMatch(/\.titlebar \{\s*height: 36px;\s*flex: 0 0 36px;/);
    expect(css).toMatch(/\.title \{\s*min-width: 0;\s*padding-left: 12px;/);
    expect(css).toContain(".titlebar-leading .title { padding-right: 12px; }");
  });
});
