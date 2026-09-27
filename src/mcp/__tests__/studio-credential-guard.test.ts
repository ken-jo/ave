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

  it("matches adjacent invalid bytes and up to three percent layers in every string position", () => {
    const key = "A1b2C3d4E5f6G7h8I9j0KLMN";
    const encoded = [...Buffer.from(key)].map((byte, index) => {
      const hex = byte.toString(16).padStart(2, "0");
      return `%${index % 2 ? hex.toUpperCase() : hex.toLowerCase()}`;
    }).join("");
    const twice = encodeURIComponent(encoded);
    const thrice = encodeURIComponent(twice);
    for (const value of [`%ff${encoded}`, `${encoded}%ff`, `%zz${encoded}`, `${encoded}%zz`, twice, thrice]) {
      expect(containsStoredCredential({ args: [`--token=${value}`], env: { TOKEN: value },
        url: `https://example.invalid/mcp#token=${value}` }, key)).toBe(true);
    }
    expect(containsStoredCredential(`progress=100%;token=${encoded.slice(0, Math.floor(encoded.length / 2))}`, key)).toBe(false);
  });
});
