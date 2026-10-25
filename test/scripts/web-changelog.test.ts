import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChangelog } from "../../web/lib/changelog.js";

// The site's changelog page renders released versions only; the
// `## Unreleased` section that release commits rename stays off the page.

const release = "## v0.14.0 — 2026-10-16\n\n- Shipped item.\n";

describe("web changelog parser", () => {
  it("leaves the Unreleased section out of the releases", () => {
    const parsed = parseChangelog(`# Changelog\n\n## Unreleased\n\n- **Pending** item.\n  continued.\n\n${release}`);
    expect(parsed.map((r) => r.name)).toEqual(["v0.14.0"]);
    expect(parsed[0]!.date).toBe("2026-10-16");
    expect(parsed[0]!.blocks).toEqual([{ kind: "list", items: [{ text: [{ t: "text", v: "Shipped item." }], children: [] }] }]);
  });

  it("still checks the Unreleased entries", () => {
    expect(() => parseChangelog(`# Changelog\n\n## Unreleased\n\n#### Deep\n\n${release}`)).toThrow(
      "CHANGELOG.md line 5: unsupported heading: #### Deep",
    );
  });

  it("rejects a release heading without the dash", () => {
    expect(() => parseChangelog(`# Changelog\n\n## v0.15.0 2026-10-30\n\n${release}`)).toThrow(
      'CHANGELOG.md line 3: release heading without " — ": v0.15.0 2026-10-30',
    );
  });

  it("rejects an Unreleased heading that is not the plain, single, topmost one", () => {
    expect(() => parseChangelog(`# Changelog\n\n## unreleased\n\n${release}`)).toThrow('release heading without " — ": unreleased');
    expect(() => parseChangelog(`# Changelog\n\n## Unreleased — 2026-10-30\n\n${release}`)).toThrow(
      'the Unreleased heading takes no " — " suffix',
    );
    expect(() => parseChangelog(`# Changelog\n\n${release}\n## Unreleased\n`)).toThrow("Unreleased section below a release");
    expect(() => parseChangelog(`# Changelog\n\n## Unreleased\n\n## Unreleased\n\n${release}`)).toThrow("a second Unreleased section");
  });

  it("parses the repository's CHANGELOG.md", () => {
    const parsed = parseChangelog(readFileSync("CHANGELOG.md", "utf8"));
    expect(parsed.some((r) => r.name === "Unreleased")).toBe(false);
    expect(parsed.some((r) => r.name === "v0.14.0")).toBe(true);
  });
});
