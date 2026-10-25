/** Manifest declarations authorize work kinds; a malformed declaration must grant nothing, including valid sibling entries. */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getDeclaredWorkProposalKinds } from "../runtime/manifest-validation.js";
import { MAX_PROPOSAL_KINDS } from "../../shared/work-board-types.js";
import type { PluginManifest } from "../types.js";

type Declaration = PluginManifest["workProposals"];

function kinds(workProposals: unknown): string[] {
  return getDeclaredWorkProposalKinds(
    { workProposals: workProposals as Declaration },
    "indexer",
  );
}

describe("workProposals — declaration is the grant", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("grants exactly the declared kinds", () => {
    expect(
      kinds({
        reasoning: "Raises folders whose index has gone stale.",
        kinds: [
          { id: "stale-index", label: "Stale index" },
          { id: "embed-failed", label: "Documents that failed to embed" },
        ],
      }),
    ).toEqual(["stale-index", "embed-failed"]);
  });

  it("grants nothing when the block is absent — deny by default", () => {
    expect(kinds(undefined)).toEqual([]);
  });

  it("grants nothing for an empty kind list", () => {
    expect(kinds({ kinds: [] })).toEqual([]);
  });

  it("grants NOTHING — not the valid half — when one entry is malformed", () => {
    // A valid sibling must not survive a malformed consent label as a partial grant.
    for (const bad of [
      [{ id: "stale-index", label: "Stale index" }, { id: "Embed-Failed", label: "Nope" }],
      [{ id: "stale-index", label: "Stale index" }, { id: "embed-failed", label: "" }],
      [{ id: "stale-index", label: "Stale index" }, { id: "embed-failed" }],
      [{ id: "stale-index", label: "Stale index" }, { label: "no id" }],
      [{ id: "stale-index", label: "Stale index" }, { id: "stale-index", label: "duplicate" }],
    ]) {
      expect(kinds({ kinds: bad })).toEqual([]);
    }
  });

  it("grants nothing past the declared-kind ceiling", () => {
    const overCeiling = Array.from({ length: MAX_PROPOSAL_KINDS + 1 }, (_unused, i) => ({
      id: `kind-${i}`,
      label: `Kind ${i}`,
    }));
    expect(kinds({ kinds: overCeiling })).toEqual([]);
    expect(kinds({ kinds: overCeiling.slice(0, MAX_PROPOSAL_KINDS) })).toHaveLength(
      MAX_PROPOSAL_KINDS,
    );
  });

  it("grants nothing for a block of the wrong shape entirely", () => {
    expect(kinds(null)).toEqual([]);
    expect(kinds("stale-index")).toEqual([]);
    expect(kinds({ kinds: "stale-index" })).toEqual([]);
    expect(kinds({ kinds: [{ id: "stale-index", label: "Stale index" }], reasoning: 7 })).toEqual([]);
  });
});
