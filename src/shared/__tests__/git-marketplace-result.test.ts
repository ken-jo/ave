import { describe, expect, it } from "vitest";
import { parseGitMarketplaceResult } from "../git-marketplace.js";

describe("the failure envelope across the bridge (design §18.8)", () => {
  it("keeps a detail whose reason belongs to the code", () => {
    const sent = { ok: false, code: "SOURCE_UNREACHABLE", message: "git fetch failed: Could not resolve host", detail: { reason: "dns", host: "nowhere.invalid" } };
    expect(parseGitMarketplaceResult(sent)).toEqual(sent);
  });

  it.each([
    ["a reason of another code", { reason: "token", host: "nowhere.invalid" }],
    ["an unknown reason", { reason: "cosmic-rays", host: "nowhere.invalid" }],
    ["a field of the wrong type", { reason: "http-status", host: "nowhere.invalid", status: "502" }],
    ["a missing field", { reason: "dns" }],
    ["an extra field", { reason: "dns", host: "nowhere.invalid", path: "/etc/passwd" }],
    ["not an object", "dns"],
  ])("drops %s and keeps the code and message", (_case, detail) => {
    expect(parseGitMarketplaceResult({ ok: false, code: "SOURCE_UNREACHABLE", message: "git fetch failed", detail })).toEqual({
      ok: false,
      code: "SOURCE_UNREACHABLE",
      message: "git fetch failed",
    });
  });

  it("drops a detail on a code that has no reasons", () => {
    expect(parseGitMarketplaceResult({ ok: false, code: "PLAN_EXPIRED", message: "expired", detail: { reason: "expired" } })).toEqual({
      ok: false,
      code: "PLAN_EXPIRED",
      message: "expired",
    });
  });

  it("still reads an unknown code as unavailable", () => {
    expect(parseGitMarketplaceResult({ ok: false, code: "SOURCE_FROM_THE_FUTURE", message: "x", detail: { reason: "dns", host: "h" } })).toEqual({
      ok: false,
      code: "unavailable",
      message: "the marketplace did not answer",
    });
  });
});
