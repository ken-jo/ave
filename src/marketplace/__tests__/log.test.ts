import { afterEach, describe, expect, it, vi } from "vitest";
import { createMarketplaceLogger } from "../log.js";

// A real token shape, assembled here so no whole token sits in the source.
const TOKEN = `gh${"p_"}${"A1b2C3d4".repeat(5).slice(0, 36)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the marketplace's logger (§18.8)", () => {
  it.each(["debug", "info", "warn", "error"] as const)("scrubs a token from a %s line's message and its context", (level) => {
    const consoleMethod = level === "warn" ? "warn" : level === "error" ? "error" : "log";
    const printed = vi.spyOn(console, consoleMethod).mockImplementation(() => {});
    const log = createMarketplaceLogger("marketplace-log-test");
    log[level](`folder \\\\server\\share\\${TOKEN} unreadable`);
    log[level]({ path: `/srv/${TOKEN}`, nested: { refs: [`refs/heads/${TOKEN}`] } }, `read ${TOKEN} failed`);
    const output = JSON.stringify(printed.mock.calls);
    expect(printed).toHaveBeenCalledTimes(2);
    expect(output).toContain("[REDACTED:TOKEN]");
    expect(output).not.toContain(TOKEN);
  });

  it("keeps a line without a token as it is", () => {
    const printed = vi.spyOn(console, "warn").mockImplementation(() => {});
    createMarketplaceLogger("marketplace-log-test").warn({ path: "/srv/live-captions" }, "repair: could not list test-server01.corp");
    expect(JSON.stringify(printed.mock.calls)).toContain("/srv/live-captions");
    expect(JSON.stringify(printed.mock.calls)).toContain("repair: could not list test-server01.corp");
  });
});
