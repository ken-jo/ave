import { describe, expect, it, vi } from "vitest";

const warn = vi.fn();
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ warn: (...args: unknown[]) => warn(...args), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { normalizeMainLayout } = await import("../settings-normalization.js");

describe("normalizeMainLayout", () => {
  it("logs why a saved layout was refused, never the layout itself", () => {
    const secret = "https://example.com/callback?token=s3cr3t";
    const layout = {
      version: 1,
      tree: { kind: "leaf", chatGroupId: "main" },
      focusedId: "group-9",
      surfaces: {},
      panelOpenIds: [],
      thumbnailOpenIds: [],
      sideTabs: { main: [{ kind: "browser", tabId: "browser:0000000a-1", ordinal: 1, cwd: null, url: secret }] },
    };
    expect(normalizeMainLayout(layout)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain('focusedId names pane "group-9"');
    expect(logged).not.toContain("s3cr3t");
  });

  it("says nothing about a layout that was never saved", () => {
    warn.mockClear();
    expect(normalizeMainLayout(undefined)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
