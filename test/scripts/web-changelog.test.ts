import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseChangelog, type Release } from "../../web/lib/changelog.js";
import { englishRelease, staleEnglishNotes } from "../../web/lib/changelog-en.js";

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

describe("English release notes", () => {
  function currentRelease(): Release {
    const current = parseChangelog(readFileSync("CHANGELOG.md", "utf8"))[0];
    if (!current) throw new Error("Missing current release");
    return current;
  }

  it("translates every published release and preserves the grouped section order", () => {
    const all = parseChangelog(readFileSync("CHANGELOG.md", "utf8"));
    const published = all.slice(0, all.findIndex((r) => r.name === "v0.14.0") + 1);
    expect(published.map((r) => r.name)).toEqual(["v0.15.0", "v0.14.0"]);
    expect(staleEnglishNotes(published.map((r) => r.name))).toEqual([]);
    for (const r of published) {
      expect(englishRelease(r).blocks.map((b) => b.kind)).toEqual(r.blocks.map((b) => b.kind));
    }
    const blocks = englishRelease(currentRelease()).blocks;
    expect(blocks.filter((b) => b.kind === "h3").map((b) => b.text)).toEqual([
      [{ t: "text", v: "Before you update" }],
      [{ t: "text", v: "New features" }],
      [{ t: "text", v: "Permissions and security" }],
      [{ t: "text", v: "For extension developers" }],
      [{ t: "text", v: "Fixes" }],
    ]);
    const upgrades = blocks[1];
    if (upgrades?.kind !== "list") throw new Error("Missing upgrade list");
    expect(upgrades.items[0]?.title).toEqual([{ t: "text", v: "0.15.0 is the first host protocol 5 release" }]);
  });

  it("keeps the ungrouped release as one list", () => {
    const r = parseChangelog(readFileSync("CHANGELOG.md", "utf8")).find((r) => r.name === "v0.14.0");
    if (!r) throw new Error("Missing first release");
    const blocks = englishRelease(r).blocks;
    expect(blocks.map((b) => b.kind)).toEqual(["list"]);
    const list = blocks[0];
    if (list?.kind !== "list") throw new Error("Missing release list");
    expect(list.items[0]?.title).toEqual([{ t: "text", v: "Ave’s website and distribution addresses" }]);
  });

  it("rejects item drift between sections even when the total item count is unchanged", () => {
    const r = currentRelease();
    const first = r.blocks[1];
    const next = r.blocks[3];
    if (first?.kind !== "list" || next?.kind !== "list") throw new Error("Missing grouped lists");
    const moved = first.items.pop();
    if (!moved) throw new Error("Missing upgrade note");
    next.items.unshift(moved);
    expect(() => englishRelease(r)).toThrow(/block 2 has \d+ items, CHANGELOG.md has \d+/u);
  });

  it("rejects missing sections and mismatched block kinds", () => {
    const r = currentRelease();
    r.blocks.pop();
    expect(() => englishRelease(r)).toThrow(/has 10 blocks, CHANGELOG.md has 9/u);
    const changed = currentRelease();
    changed.blocks[0] = { kind: "p", text: [{ t: "text", v: "Unexpected paragraph" }] };
    expect(() => englishRelease(changed)).toThrow("block 1 is h3, CHANGELOG.md has p");
  });

  it("rejects a release without English notes", () => {
    expect(() => englishRelease({ ...currentRelease(), name: "v9.9.9" })).toThrow("no English notes for v9.9.9");
  });
});
