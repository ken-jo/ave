// Base temp grants must survive new conversations and cover both per-user temp roots and conventional /tmp. Test candidates through the real scope builder without assuming host paths exist.
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { baseAllowedDirectories } from "../base-allowed-directories.js";
import { buildAllowedScope, isPathAllowed } from "../allowed-directories.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../sensitive-paths.js";

// Match the way the product does: candidates go through `buildAllowedScope`, which canonicalizes and case-folds them, and the probe path is normalized the same way before the segment-aligned compare.
function allowedUnderBase(candidate: string): boolean {
  const scope = buildAllowedScope(baseAllowedDirectories());
  return isPathAllowed(caseFoldForMatch(canonicalizePathForMatch(candidate)), scope);
}

describe("base allowed directories", () => {
  it("offers at least the per-user temp directory", () => {
    expect(baseAllowedDirectories()).toContain(tmpdir());
  });

  it("makes a child of every offered candidate reachable", () => {
    // The invariant that matters, and the one that holds on any platform: whatever this function offers must survive the scope builder and match.
    for (const dir of baseAllowedDirectories()) {
      expect(allowedUnderBase(join(dir, "ave-scratch", "notes.txt"))).toBe(true);
    }
  });

  it("reaches a file staged under the per-user temp directory", () => {
    expect(allowedUnderBase(join(tmpdir(), "ave-scratch", "notes.txt"))).toBe(true);
  });

  it.runIf(process.platform !== "win32")("offers the conventional shared /tmp on POSIX", () => {
    // The reported case: this project's workflow clones into /tmp/<task>/<repo>, which `os.tmpdir` alone would not cover.
    expect(baseAllowedDirectories()).toContain("/tmp");
  });

  it("does not offer a shared POSIX path on Windows", () => {
    if (process.platform !== "win32") return;
    expect(baseAllowedDirectories()).not.toContain("/tmp");
  });

  it("does not make unrelated paths reachable", () => {
    // Deliberately not `process.cwd`: this suite often runs from a clone under a temp directory, where cwd genuinely IS reachable — asserting otherwise would fail for the same reason the feature works.
    expect(allowedUnderBase("/etc/shadow")).toBe(false);
  });
});
