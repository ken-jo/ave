/**
 * The revocation registry answers the load gates from the rules the snapshot
 * feed hands it (design §10.4): a version inside a rule's range is blocked
 * with that source's action and reason; anything else is allowed.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("../../../lib/logger.js", () => ({
  createLogger: () => ({ error: logs.error, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { revocationRegistry, type RevocationRule } from "../revocation-registry.js";

const rule = (overrides: Partial<RevocationRule> = {}): RevocationRule => ({
  kind: "plugin",
  name: "meeting",
  versions: ">=1.0.0 <1.2.0",
  reason: "leaks transcripts",
  at: "2026-09-24T00:00:00Z",
  action: "disable",
  sourceId: "ave",
  ...overrides,
});

afterEach(() => {
  revocationRegistry.resetForTesting();
  logs.error.mockClear();
});

describe("revocationRegistry", () => {
  it("blocks a version inside a rule's range with the source's action and reason", () => {
    revocationRegistry.replace([rule(), rule({ kind: "skill", name: "review", versions: "*", action: "uninstall", sourceId: "acme", reason: "prompt injection" })]);
    expect(revocationRegistry.evaluate("plugin", "meeting", "1.1.9")).toEqual({ kind: "block", sourceId: "ave", action: "disable", reason: "leaks transcripts" });
    expect(revocationRegistry.evaluate("plugin", "meeting", "1.2.0")).toEqual({ kind: "allow" });
    expect(revocationRegistry.evaluate("plugin", "meeting", "0.9.0")).toEqual({ kind: "allow" });
    expect(revocationRegistry.evaluate("skill", "review", "3.0.0")).toEqual({ kind: "block", sourceId: "acme", action: "uninstall", reason: "prompt injection" });
    // Kind and name together identify the package.
    expect(revocationRegistry.evaluate("skill", "meeting", "1.1.0")).toEqual({ kind: "allow" });
  });

  it("replaces every rule, and says whether the set changed", () => {
    expect(revocationRegistry.replace([rule()])).toBe(true);
    expect(revocationRegistry.replace([rule()])).toBe(false);
    expect(revocationRegistry.replace([])).toBe(true);
    expect(revocationRegistry.evaluate("plugin", "meeting", "1.1.0")).toEqual({ kind: "allow" });
  });

  it("counts the first feed as a change even when it holds no rules", () => {
    expect(revocationRegistry.replace([])).toBe(true);
    expect(revocationRegistry.replace([])).toBe(false);
  });

  it("allows before the first feed and reports that once", () => {
    expect(revocationRegistry.evaluate("plugin", "meeting", "1.1.0")).toEqual({ kind: "allow" });
    revocationRegistry.evaluate("plugin", "orion", "2.0.0");
    expect(logs.error).toHaveBeenCalledTimes(1);
    expect(logs.error.mock.calls[0]![0]).toContain("revocation_unconfigured");

    revocationRegistry.replace([]);
    revocationRegistry.evaluate("plugin", "meeting", "1.1.0");
    expect(logs.error).toHaveBeenCalledTimes(1);
  });
});
