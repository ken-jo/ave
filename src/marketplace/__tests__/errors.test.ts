import { describe, expect, it } from "vitest";
import { MarketplaceError, scrubMarketplaceErrorDetail } from "../errors.js";

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

  it("refuses to scrub another code's detail", () => {
    expect(() => scrubMarketplaceErrorDetail("SOURCE_UNREACHABLE", { reason: "token", host: "github.com" } as never)).toThrow(TypeError);
  });
});
