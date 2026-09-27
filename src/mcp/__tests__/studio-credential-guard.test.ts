import { describe, expect, it } from "vitest";
import { containsStoredCredential } from "../studio-credential-guard.js";

describe("Studio stored credential matching", () => {
  it("decodes valid percent runs around malformed escapes and invalid UTF-8", () => {
    expect(containsStoredCredential("progress=100%;token=%41%7a", "Az")).toBe(true);
    expect(containsStoredCredential("token=%41%7A;bad=%zz", "Az")).toBe(true);
    expect(containsStoredCredential("bad=%ff;token=%41%7a", "Az")).toBe(true);
    expect(containsStoredCredential("bad=%ff;token=%41%7a", "missing")).toBe(false);
    expect(containsStoredCredential("progress=100%;bad=%zz", "Az")).toBe(false);
  });

  it("reads URL query values with plus while leaving malformed percent text inert", () => {
    expect(containsStoredCredential("https://example.invalid/mcp?token=alpha+beta&progress=100%", "alpha beta")).toBe(true);
    expect(containsStoredCredential("https://example.invalid/mcp?progress=100%&token=%41%7a", "Az")).toBe(true);
    expect(containsStoredCredential("https://example.invalid/mcp?progress=100%&bad=%zz", "Az")).toBe(false);
  });
});
