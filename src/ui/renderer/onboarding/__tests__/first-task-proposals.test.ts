/**
 * pickFirstTaskProposal must key on the BARE manifest id (the same id
 * `pluginCards[].id` carries — e.g. "meeting"), not the marketplace slug
 * (`ave-plugin-meeting`). The slug-keyed catalog meant the post-tour first
 * task card never matched any installed plugin.
 */
import { describe, it, expect } from "vitest";
import { pickFirstTaskProposal } from "../first-task-proposals.js";

describe("pickFirstTaskProposal", () => {
  it("matches an installed plugin by its bare manifest id", () => {
    expect(pickFirstTaskProposal(["meeting"])?.pluginId).toBe("meeting");
    expect(pickFirstTaskProposal(["vega-helper"])?.pluginId).toBe("vega-helper");
    expect(pickFirstTaskProposal(["local-indexer"])?.pluginId).toBe("local-indexer");
    expect(pickFirstTaskProposal(["agent-hub"])?.pluginId).toBe("agent-hub");
  });

  it("does NOT match marketplace slugs (the old slug-keyed bug)", () => {
    expect(pickFirstTaskProposal(["ave-plugin-meeting"])).toBeNull();
    expect(pickFirstTaskProposal(["ave-plugin-vega-helper"])).toBeNull();
  });

  it("returns the lowest-priority proposal when several plugins are installed", () => {
    // meeting (10) < agent-hub (40)
    expect(pickFirstTaskProposal(["agent-hub", "meeting"])?.pluginId).toBe("meeting");
  });

  it("returns null when no installed plugin has a proposal", () => {
    expect(pickFirstTaskProposal([])).toBeNull();
    expect(pickFirstTaskProposal(["some-unknown-plugin"])).toBeNull();
  });
});
