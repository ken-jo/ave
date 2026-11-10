// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it } from "vitest";
import { registerNativePageBranch } from "../native-page-branches.js";

describe("native page ancestor painting", () => {
  it("clears only the page branch and restores shared ancestors after the last page leaves", () => {
    const root = document.createElement("div");
    const first = document.createElement("div");
    const second = document.createElement("div");
    const chrome = document.createElement("header");
    root.append(first, second, chrome);
    document.body.append(root);
    const releaseFirst = registerNativePageBranch(first);
    const releaseSecond = registerNativePageBranch(second);
    try {
      expect(first).toHaveAttribute("data-ave-native-branch");
      expect(second).toHaveAttribute("data-ave-native-branch");
      expect(root).toHaveAttribute("data-ave-native-branch");
      expect(document.documentElement).toHaveAttribute("data-ave-native-branch");
      expect(chrome).not.toHaveAttribute("data-ave-native-branch");
      releaseFirst();
      expect(first).not.toHaveAttribute("data-ave-native-branch");
      expect(root).toHaveAttribute("data-ave-native-branch");
      releaseSecond();
      expect(root).not.toHaveAttribute("data-ave-native-branch");
      expect(document.documentElement).not.toHaveAttribute("data-ave-native-branch");
    } finally { releaseFirst(); releaseSecond(); root.remove(); }
  });
});
