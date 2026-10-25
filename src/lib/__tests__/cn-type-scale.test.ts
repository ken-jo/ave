import { describe, expect, it } from "vitest";
import { cn } from "../utils.js";

/** Classify theme text-scale utilities as font sizes so merging preserves text colors. */
describe("cn — theme type scale vs colour", () => {
  for (const size of ["text-body", "text-body-sm", "text-caption", "text-micro"]) {
    it(`keeps a colour utility alongside ${size}`, () => {
      const merged = cn("bg-primary text-primary-foreground", `h-6 ${size}`);
      expect(merged).toContain("text-primary-foreground");
      expect(merged).toContain(size);
    });

    it(`still lets a later colour override an earlier one with ${size} present`, () => {
      const merged = cn(`text-primary-foreground ${size}`, "text-destructive");
      expect(merged).toContain("text-destructive");
      expect(merged).not.toContain("text-primary-foreground");
      expect(merged).toContain(size);
    });
  }

  it("still collapses two type-scale sizes down to the last one", () => {
    expect(cn("text-body", "text-caption")).toBe("text-caption");
  });

  it("does not regress the stock font-size scale", () => {
    const merged = cn("bg-primary text-primary-foreground", "text-xs");
    expect(merged).toContain("text-primary-foreground");
    expect(merged).toContain("text-xs");
    expect(cn("text-xs", "text-lg")).toBe("text-lg");
  });
});
