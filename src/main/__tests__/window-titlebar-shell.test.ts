import { describe, expect, it } from "vitest";
import { buildTitlebarCss } from "../window-titlebar-shell.js";

describe("link/auth shell titlebar", () => {
  it("draws no bottom rule on any platform, as the main window's band", () => {
    expect(buildTitlebarCss()).not.toMatch(/border-bottom/);
  });
});
