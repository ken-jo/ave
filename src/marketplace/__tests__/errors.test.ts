import { describe, expect, it } from "vitest";
import { MarketplaceError, scrubMarketplaceErrorDetail, scrubMarketplaceStrings } from "../errors.js";

describe("MarketplaceError detail (design §18.8)", () => {
  it("carries a detail that belongs to its code", () => {
    const error = new MarketplaceError("SOURCE_UNREACHABLE", "git fetch failed", { detail: { reason: "dns", host: "nowhere.invalid" } });
    expect(error.detail).toEqual({ reason: "dns", host: "nowhere.invalid" });
    expect(new MarketplaceError("PLAN_EXPIRED", "expired").detail).toBeUndefined();
  });

  it("refuses to be made with another code's detail", () => {
    expect(() => new MarketplaceError("SOURCE_UNREACHABLE", "git fetch failed", { detail: { reason: "token", host: "github.com" } })).toThrow(TypeError);
  });

  it("scrubs a detail's diagnostic text and keeps its identifiers", () => {
    expect(scrubMarketplaceErrorDetail("SOURCE_UNREACHABLE", { reason: "proxy", host: "git.example", proxy: "PROXY alice:canary@proxy.corp:8080" })).toEqual({
      reason: "proxy",
      host: "git.example",
      proxy: "PROXY [REDACTED:CREDENTIALS]@proxy.corp:8080",
    });
    const identifiers = { reason: "blocked-by-pattern" as const, target: "https://github.com/acme/market", pattern: "host:github.com", policyPath: "/Library/Ave/policy.json" };
    expect(scrubMarketplaceErrorDetail("SOURCE_POLICY_BLOCKED", identifiers)).toEqual(identifiers);
  });

  // Built here, never written out whole: a token-shaped ssh account name, which URL normalization keeps.
  const TOKEN = `ghp_${"a".repeat(36)}`;
  const pasted = `ssh://${TOKEN}@github.com/acme/market`;
  const ordinary = "ssh://git@github.com/acme/market";

  it.each([
    ["SOURCE_ID_TAKEN", (url: string) => ({ reason: "repository-already-added", url, existingId: "acme" }), "url"],
    ["SOURCE_POLICY_BLOCKED", (target: string) => ({ reason: "blocked-by-pattern", target, pattern: "host:github.com", policyPath: "/p.json" }), "target"],
    ["SOURCE_POLICY_BLOCKED", (target: string) => ({ reason: "not-in-allow-list", target, policyPath: "/p.json" }), "target"],
    ["SOURCE_POLICY_BLOCKED", (target: string) => ({ reason: "https-required", target, policyPath: "/p.json" }), "target"],
    ["SOURCE_POLICY_BLOCKED", (target: string) => ({ reason: "private-network-blocked", target, address: "10.0.0.1", policyPath: "/p.json" }), "target"],
    ["SOURCE_POLICY_BLOCKED", (target: string) => ({ reason: "local-sources-blocked", target, policyPath: "/p.json" }), "target"],
    ["SOURCE_POLICY_BLOCKED", (target: string) => ({ reason: "direct-install-blocked", target, policyPath: "/p.json" }), "target"],
    ["SOURCE_REF_NOT_FOUND", (repository: string) => ({ reason: "missing", ref: "main", repository, available: [] }), "repository"],
  ] as const)("masks a token pasted as the ssh account in %s's source address, and keeps an ordinary account (%#)", (code, detail, field) => {
    const masked = scrubMarketplaceErrorDetail(code, detail(pasted) as never) as Record<string, unknown>;
    expect(masked[field]).toBe("ssh://[REDACTED:TOKEN]@github.com/acme/market");
    expect(JSON.stringify(masked)).not.toContain(TOKEN);
    expect(scrubMarketplaceErrorDetail(code, detail(ordinary) as never)).toEqual(detail(ordinary));
  });

  it("refuses to scrub another code's detail", () => {
    expect(() => scrubMarketplaceErrorDetail("SOURCE_UNREACHABLE", { reason: "token", host: "github.com" } as never)).toThrow(TypeError);
  });
});

describe("scrubMarketplaceStrings (design §18.8)", () => {
  // Assembled here so no whole token sits in the source.
  const TOKEN = `npm${"_"}${"Ab12Cd34".repeat(5).slice(0, 36)}`;
  const OTHER = `glp${"at-"}${"Zy98Xw76".repeat(3)}`;

  it("scrubs keys as well as values, at any depth, and leaves ordinary keys alone", () => {
    const answer = {
      name: "team-tools",
      components: { mcpServers: { [TOKEN]: { command: "node" }, "test-marketplace2026": { command: "node" } } },
      list: [{ [OTHER]: OTHER }],
    };
    const scrubbed = scrubMarketplaceStrings(answer);
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
    expect(JSON.stringify(scrubbed)).not.toContain(OTHER);
    expect(Object.keys(scrubbed.components.mcpServers)).toEqual(["[REDACTED:TOKEN]", "test-marketplace2026"]);
    expect(scrubbed.list[0]).toEqual({ "[REDACTED:TOKEN]": "[REDACTED:TOKEN]" });
  });

  it("keeps two keys masked alike as two entries", () => {
    const scrubbed = scrubMarketplaceStrings({ [TOKEN]: 1, [OTHER]: 2 });
    expect(scrubbed).toEqual({ "[REDACTED:TOKEN]": 1, "[REDACTED:TOKEN] (2)": 2 });
  });

  it("returns an answer with nothing to scrub equal to itself", () => {
    const answer = { id: "test-marketplace2026", nested: { "skill-notes": ["sk-proj-tools", "live-notifications2026"] }, count: 2, none: null };
    expect(scrubMarketplaceStrings(answer)).toEqual(answer);
  });
});
