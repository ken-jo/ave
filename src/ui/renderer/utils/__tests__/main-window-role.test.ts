import { describe, expect, it } from "vitest";
import { isSecondaryMainWindow } from "../main-window-role.js";

describe("isSecondaryMainWindow", () => {
  it("reads the role main puts on a secondary window's document", () => {
    expect(isSecondaryMainWindow("?aveWindow=secondary")).toBe(true);
    expect(isSecondaryMainWindow("")).toBe(false);
    expect(isSecondaryMainWindow("?aveWindow=primary")).toBe(false);
    expect(isSecondaryMainWindow("?other=secondary")).toBe(false);
  });
});
