/**
 * seedAveHomeDocs — first-boot seed + `.new` upgrade-marker coverage.
 *
 * Covers the unit-testable acceptance criteria of issue #1108 (follow-up to
 * PR #1104's built-in agents/skills seed):
 *   - first-boot copy of packaged resources into ~/.ave/{AGENTS.md,agents,skills,prompts}
 *   - byte-identical re-run is a no-op (idempotent)
 *   - a byte-identical known packaged AGENTS.md predecessor is replaced in place
 *   - a user-edited AGENTS.md / skill / prompt copy survives upgrade; the new
 *     packaged version lands as `<file>.new` rather than clobbering the user's edit
 *   - user-edited agent profiles are seed-only and do not create `agents/*.md.new`
 *   - a second divergent upgrade lands a timestamped `<file>.new.<ts>` and
 *     leaves the prior `.new` untouched
 *   - an already-offered `.new` identical to the packaged copy is a no-op
 *   - a version any existing marker already carries — the stale undated one or
 *     a dated sibling — is not offered a second time
 *   - a dated marker whose bytes are on the shipped-version allowlist is
 *     dropped when a newer version is offered
 *   - seeded files are chmod 0o600 (POSIX)
 *
 * Dev-mode resolution (`app.isPackaged === false`) walks up from the module's
 * own location to the first ancestor containing `resources/skills` — a fully
 * cwd-independent anchor that also ignores `app.getAppPath()` (wrong under
 * `bun run start`, where the launcher passes a script-file arg and getAppPath
 * resolves to the script dir `dist/src/main`). The test points the
 * `AVE_RESOURCE_ROOT` override at a temp fixtures root and `AVE_HOME` at a
 * temp home — no real ~/.ave or repo resources are touched.
 *
 * The packaged launch smoke verifies that resources ship and seed on real
 * first launch; this file keeps the deterministic seed/upgrade semantics.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  lstatSync,
  statSync,
  symlinkSync,
  unlinkSync,
  constants as fsConstants,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { configureHostResources } from "../host-resources.js";


import {
  discardAveHomeDocUpgradeMarker,
  isShippedAgentsMdContent,
  listAveHomeDocUpgradeMarkers,
  readAveHomeDocSource,
  readAveHomeDocUpgradeMarker,
  retireAppliedAveHomeDocUpgradeMarkers,
  seedAveHomeDocs,
} from "../seed-ave-home-docs.js";
import * as atomicFile from "../../lib/atomic-file.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

let fixtures: string;
let home: string;
const prevAveHome = process.env.AVE_HOME;
const prevResourceRoot = process.env.AVE_RESOURCE_ROOT;
/** Write a packaged resource fixture under <fixtures>/resources/<rel>. */
function writeRes(rel: string, content: string): void {
  const p = join(fixtures, "resources", rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

beforeEach(() => {
  fixtures = mkdtempSync(join(tmpdir(), "ave-seed-fix-"));
  home = mkdtempSync(join(tmpdir(), "ave-seed-home-"));
  process.env.AVE_HOME = home;
  process.env.AVE_RESOURCE_ROOT = fixtures;
  configureHostResources({ resourcePath: join(fixtures, "resources"), isPackaged: false });

  writeRes("AGENTS.md", "AGENTS v1\n");
  writeRes("AGENTS.md.replaceable-sha256", `${sha256("AGENTS v1\n")}\n`);
  writeRes(join("agents", "executor.md"), "executor v1\n");
  writeRes(join("skills", "report-writing.md"), "report v1\n");
  writeRes(join("prompts", "summarizer.md"), "summarizer v1\n");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(fixtures);
  await cleanupTmpDir(home);
  if (prevAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = prevAveHome;
  if (prevResourceRoot === undefined) delete process.env.AVE_RESOURCE_ROOT;
  else process.env.AVE_RESOURCE_ROOT = prevResourceRoot;

});

describe("seedAveHomeDocs — first boot", () => {
  it("copies AGENTS.md + agents/*.md + skills/*.md + prompts/*.md into ~/.ave", () => {
    const r = seedAveHomeDocs();

    expect(r.seeded).toContain("AGENTS.md");
    expect(r.seeded).toContain(join("agents", "executor.md"));
    expect(r.seeded).toContain(join("skills", "report-writing.md"));
    expect(r.seeded).toContain(join("prompts", "summarizer.md"));
    expect(r.upgraded).toEqual([]);

    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("AGENTS v1\n");
    expect(readFileSync(join(home, "agents", "executor.md"), "utf8")).toBe(
      "executor v1\n",
    );
    expect(readFileSync(join(home, "skills", "report-writing.md"), "utf8")).toBe(
      "report v1\n",
    );
    expect(readFileSync(join(home, "prompts", "summarizer.md"), "utf8")).toBe(
      "summarizer v1\n",
    );
  });

  it("resolves dev resources independent of process.cwd() (regression: chdir-before-seed)", async () => {
    // ensureWorkspaceCwd() chdir()s the main process to ~/.ave/workspace before
    // boot. Seeding must still find the repo's resources/ via the module-anchored
    // walk-up, not a cwd-relative join (and not app.getAppPath(), which points at
    // the script dir under `bun run start`).
    const originalCwd = process.cwd();
    const elsewhere = mkdtempSync(join(tmpdir(), "ave-seed-cwd-"));
    process.chdir(elsewhere);
    try {
      const r = seedAveHomeDocs();
      expect(r.seeded).toContain("AGENTS.md");
      expect(r.seeded).toContain(join("skills", "report-writing.md"));
      expect(readFileSync(join(home, "skills", "report-writing.md"), "utf8")).toBe(
        "report v1\n",
      );
    } finally {
      process.chdir(originalCwd);
      await cleanupTmpDir(elsewhere);
    }
  });

  it("seeds files as 0o600 (POSIX)", () => {
    if (process.platform === "win32") return;
    seedAveHomeDocs();
    expect(statSync(join(home, "AGENTS.md")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "agents", "executor.md")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("is a no-op when re-run against byte-identical packaged content", () => {
    seedAveHomeDocs();
    const r2 = seedAveHomeDocs();
    expect(r2.seeded).toEqual([]);
    expect(r2.upgraded).toEqual([]);
    expect(existsSync(join(home, "AGENTS.md.new"))).toBe(false);
  });

it("uses the injected resources directory in a packaged runtime", async () => {
    const resourcesPath = mkdtempSync(join(tmpdir(), "ave-packaged-resources-"));
    try {
      configureHostResources({ resourcePath: resourcesPath, isPackaged: true });
      writeFileSync(join(resourcesPath, "AGENTS.md"), "PACKAGED AGENTS\n");
      mkdirSync(join(resourcesPath, "agents"), { recursive: true });
      mkdirSync(join(resourcesPath, "skills"), { recursive: true });
      mkdirSync(join(resourcesPath, "prompts"), { recursive: true });
      writeFileSync(join(resourcesPath, "agents", "executor.md"), "packaged executor\n");
      writeFileSync(join(resourcesPath, "skills", "report-writing.md"), "packaged report\n");
      writeFileSync(join(resourcesPath, "prompts", "summarizer.md"), "packaged prompt\n");

      const r = seedAveHomeDocs();

      expect(r.seeded).toContain("AGENTS.md");
      expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("PACKAGED AGENTS\n");
      expect(readFileSync(join(home, "skills", "report-writing.md"), "utf8")).toBe("packaged report\n");
    } finally {
      await cleanupTmpDir(resourcesPath);
    }
  });
});

describe("seedAveHomeDocs — upgrade markers", () => {
  it("replaces a known packaged predecessor only with no-follow validation", () => {
    seedAveHomeDocs();
    writeRes("AGENTS.md", "AGENTS v2\n");

    const r = seedAveHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    if (typeof fsConstants.O_NOFOLLOW === "number") {
      expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("AGENTS v2\n");
      expect(existsSync(join(home, "AGENTS.md.new"))).toBe(false);
    } else {
      expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("AGENTS v1\n");
      expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
    }
  });

  it("preserves a concurrent edit detected before the atomic replacement commit", () => {
    if (typeof fsConstants.O_NOFOLLOW !== "number") return;
    seedAveHomeDocs();
    writeRes("AGENTS.md", "AGENTS v2\n");
    const atomicReplace = atomicFile.replaceUtf8FileAtomicSyncIf;
    vi.spyOn(atomicFile, "replaceUtf8FileAtomicSyncIf").mockImplementationOnce(
      (target, content, precondition, mode) => {
        writeFileSync(target, "concurrent user edit\n");
        return atomicReplace(target, content, precondition, mode);
      },
    );

    const r = seedAveHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(
      "concurrent user edit\n",
    );
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
  });

  it("keeps the predecessor intact when atomic staging fails", () => {
    if (typeof fsConstants.O_NOFOLLOW !== "number") return;
    seedAveHomeDocs();
    writeRes("AGENTS.md", "AGENTS v2\n");
    vi.spyOn(atomicFile, "replaceUtf8FileAtomicSyncIf").mockImplementationOnce(() => {
      throw Object.assign(new Error("forced staging failure"), { code: "EIO" });
    });

    const r = seedAveHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("AGENTS v1\n");
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
  });

  it("does not follow an AGENTS.md symlink during packaged replacement", () => {
    if (process.platform === "win32") return;
    seedAveHomeDocs();
    const external = join(fixtures, "external-agents.md");
    writeFileSync(external, "AGENTS v1\n");
    unlinkSync(join(home, "AGENTS.md"));
    symlinkSync(external, join(home, "AGENTS.md"));
    writeRes("AGENTS.md", "AGENTS v2\n");

    const r = seedAveHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    expect(lstatSync(join(home, "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(readFileSync(external, "utf8")).toBe("AGENTS v1\n");
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
  });

  it("offers .new without replacing a non-regular AGENTS.md target", () => {
    seedAveHomeDocs();
    unlinkSync(join(home, "AGENTS.md"));
    mkdirSync(join(home, "AGENTS.md"));
    writeRes("AGENTS.md", "AGENTS v2\n");

    const r = seedAveHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    expect(lstatSync(join(home, "AGENTS.md")).isDirectory()).toBe(true);
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
  });

  it("preserves a user edit and writes the new packaged version to <file>.new", () => {
    seedAveHomeDocs();
    writeFileSync(join(home, "AGENTS.md"), "user edited\n");
    writeRes("AGENTS.md", "AGENTS v2\n");

    const r = seedAveHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    // user's edit is never clobbered
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("user edited\n");
    // upgrade content offered alongside
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
  });

  it("lands a timestamped <file>.new.<ts> on a second divergent upgrade, keeping the prior .new", () => {
    seedAveHomeDocs();
    writeFileSync(join(home, "AGENTS.md"), "user edited\n");
    writeRes("AGENTS.md", "AGENTS v2\n");
    seedAveHomeDocs(); // creates AGENTS.md.new = v2

    writeRes("AGENTS.md", "AGENTS v3\n"); // packaged diverges from the existing .new
    const r = seedAveHomeDocs();

    expect(r.upgraded).toContain("AGENTS.md");
    // prior .new is preserved (user's review work not lost)
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
    // newer upgrade lands as a dated sibling
    const dated = readdirSync(home).filter(
      (f) => f.startsWith("AGENTS.md.new.") && f !== "AGENTS.md.new",
    );
    expect(dated).toHaveLength(1);
    expect(readFileSync(join(home, dated[0]), "utf8")).toBe("AGENTS v3\n");
  });

  it("keeps user-edited agent profiles seed-only without creating .new markers", () => {
    seedAveHomeDocs();
    writeFileSync(join(home, "agents", "executor.md"), "user executor\n");
    writeRes(join("agents", "executor.md"), "executor v2\n");

    const r = seedAveHomeDocs();

    expect(r.upgraded).not.toContain(join("agents", "executor.md"));
    expect(readFileSync(join(home, "agents", "executor.md"), "utf8")).toBe(
      "user executor\n",
    );
    expect(existsSync(join(home, "agents", "executor.md.new"))).toBe(false);
  });

  it("lists pending .new upgrade markers without surfacing agent profile markers", () => {
    seedAveHomeDocs();
    writeFileSync(join(home, "AGENTS.md"), "user edited\n");
    writeFileSync(join(home, "skills", "report-writing.md"), "user report\n");
    writeFileSync(join(home, "agents", "executor.md"), "user executor\n");
    writeRes("AGENTS.md", "AGENTS v2\n");
    writeRes(join("skills", "report-writing.md"), "report v2\n");
    writeRes(join("agents", "executor.md"), "executor v2\n");

    seedAveHomeDocs();
    writeFileSync(join(home, "agents", "legacy.md.new"), "legacy agent marker\n");

    expect(listAveHomeDocUpgradeMarkers(home)).toEqual([
      { markerPath: "AGENTS.md.new", sourcePath: "AGENTS.md" },
      {
        markerPath: join("skills", "report-writing.md.new"),
        sourcePath: join("skills", "report-writing.md"),
      },
    ]);
  });

  it("is a no-op when the existing .new already matches the packaged content", () => {
    seedAveHomeDocs();
    writeFileSync(join(home, "AGENTS.md"), "user edited\n");
    writeRes("AGENTS.md", "AGENTS v2\n");
    seedAveHomeDocs(); // .new = v2

    const r = seedAveHomeDocs(); // packaged still v2, .new still v2

    expect(r.upgraded).not.toContain("AGENTS.md");
    const dated = readdirSync(home).filter((f) =>
      f.startsWith("AGENTS.md.new."),
    );
    expect(dated).toHaveLength(0);
  });
});

describe("seedAveHomeDocs — one offer per packaged version", () => {
  /**
   * A seed pass at a pinned wall clock. Dated marker names are minted from
   * `new Date()`, so two offers landing inside the same millisecond would
   * share a name; pinning the clock makes each case's expected file set exact
   * instead of dependent on how long the surrounding filesystem work took.
   */
  function seedAt(iso: string): ReturnType<typeof seedAveHomeDocs> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    try {
      return seedAveHomeDocs();
    } finally {
      vi.useRealTimers();
    }
  }

  /** Divergent user copy + `AGENTS.md.new` at v2 + one dated sibling at v3. */
  function offerThroughV3(): void {
    seedAveHomeDocs();
    writeFileSync(join(home, "AGENTS.md"), "user edited\n");
    writeRes("AGENTS.md", "AGENTS v2\n");
    seedAt("2026-01-01T00:00:00.000Z");
    writeRes("AGENTS.md", "AGENTS v3\n");
    seedAt("2026-01-02T00:00:00.000Z");
  }

  function datedMarkers(): string[] {
    return readdirSync(home)
      .filter((f) => f.startsWith("AGENTS.md.new.") && f !== "AGENTS.md.new")
      .sort();
  }

  it("adds nothing when a dated sibling already carries the packaged version", () => {
    offerThroughV3();
    // The undated marker is stale at v2 and is never refreshed; before the
    // dated siblings were consulted too, this relaunch minted another copy of
    // v3, and so did every relaunch after it.
    const before = readdirSync(home).sort();

    const r = seedAt("2026-01-03T00:00:00.000Z");

    expect(r.upgraded).not.toContain("AGENTS.md");
    expect(readdirSync(home).sort()).toEqual(before);
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
    expect(datedMarkers()).toHaveLength(1);
  });

  it("adds exactly one dated sibling for a genuinely new packaged version", () => {
    offerThroughV3();
    writeRes("AGENTS.md", "AGENTS v4\n");

    const r = seedAt("2026-01-03T00:00:00.000Z");

    expect(r.upgraded).toContain("AGENTS.md");
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("user edited\n");
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
    const dated = datedMarkers();
    expect(dated).toHaveLength(2);
    expect(dated.map((f) => readFileSync(join(home, f), "utf8")).sort()).toEqual([
      "AGENTS v3\n",
      "AGENTS v4\n",
    ]);
  });

  // Without O_NOFOLLOW the host deliberately retains existing markers.
  it.skipIf(process.platform === "win32")("removes a dated sibling whose bytes are an allowlisted shipped version", () => {
    writeRes(
      "AGENTS.md.replaceable-sha256",
      `${sha256("AGENTS v1\n")}\n${sha256("AGENTS v3\n")}\n`,
    );
    offerThroughV3();
    writeRes("AGENTS.md", "AGENTS v4\n");

    const r = seedAt("2026-01-03T00:00:00.000Z");

    expect(r.upgraded).toContain("AGENTS.md");
    // v3 shipped, so that marker holds no user work — the same evidence under
    // which the in-place path would have overwritten the user's own copy.
    const dated = datedMarkers();
    expect(dated).toHaveLength(1);
    expect(readFileSync(join(home, dated[0]), "utf8")).toBe("AGENTS v4\n");
    // The undated marker is the path a pending upgrade is surfaced under and
    // is left alone even when its bytes are allowlisted.
    expect(readFileSync(join(home, "AGENTS.md.new"), "utf8")).toBe("AGENTS v2\n");
  });

  it("offers each skill version once and keeps every skill marker", () => {
    const skill = join("skills", "report-writing.md");
    const skillDir = join(home, "skills");
    seedAveHomeDocs();
    writeFileSync(join(home, skill), "user report\n");
    writeRes(skill, "report v2\n");
    expect(seedAt("2026-01-01T00:00:00.000Z").upgraded).toContain(skill);
    expect(readFileSync(join(home, `${skill}.new`), "utf8")).toBe("report v2\n");

    writeRes(skill, "report v3\n");
    expect(seedAt("2026-01-02T00:00:00.000Z").upgraded).toContain(skill);
    const afterV3 = readdirSync(skillDir).sort();
    expect(afterV3.filter((f) => f.startsWith("report-writing.md.new"))).toHaveLength(2);

    // Skills ship no replaceable-hash allowlist, so nothing about them can be
    // shown to be a superseded shipped copy and nothing is pruned.
    expect(seedAt("2026-01-03T00:00:00.000Z").upgraded).not.toContain(skill);
    expect(readdirSync(skillDir).sort()).toEqual(afterV3);
    expect(readFileSync(join(home, skill), "utf8")).toBe("user report\n");
  });
});

describe("upgrade markers — reading, keeping, and retiring", () => {
  it("reads a marker and the live doc it would replace", () => {
    seedAveHomeDocs();
    writeFileSync(join(home, "AGENTS.md"), "mine\n");
    writeFileSync(join(home, "AGENTS.md.new"), "AGENTS v2\n");

    expect(readAveHomeDocUpgradeMarker("AGENTS.md.new", home)).toBe("AGENTS v2\n");
    expect(readAveHomeDocSource("AGENTS.md.new", home)).toBe("mine\n");
  });

  it("refuses any path the listing does not name, traversal included", () => {
    seedAveHomeDocs();
    writeFileSync(join(home, "secret.txt"), "private\n");

    for (const path of ["secret.txt", "../secret.txt", "AGENTS.md", join("..", "..", "etc", "hosts")]) {
      expect(readAveHomeDocUpgradeMarker(path, home)).toBeNull();
      expect(readAveHomeDocSource(path, home)).toBeNull();
      expect(discardAveHomeDocUpgradeMarker(path, home)).toBe(false);
    }
    expect(existsSync(join(home, "secret.txt"))).toBe(true);
  });

  it("keeps a sibling offer when one marker is dismissed", () => {
    seedAveHomeDocs();
    writeFileSync(join(home, "AGENTS.md.new"), "AGENTS v2\n");
    writeFileSync(join(home, "AGENTS.md.new.2026-02-01"), "AGENTS v3\n");

    expect(discardAveHomeDocUpgradeMarker("AGENTS.md.new", home)).toBe(true);
    expect(existsSync(join(home, "AGENTS.md.new"))).toBe(false);
    expect(existsSync(join(home, "AGENTS.md.new.2026-02-01"))).toBe(true);
  });

  it("retires every marker carrying the applied bytes and no other", () => {
    seedAveHomeDocs();
    writeFileSync(join(home, "AGENTS.md.new"), "AGENTS v2\n");
    writeFileSync(join(home, "AGENTS.md.new.2026-01-01"), "AGENTS v2\n");
    writeFileSync(join(home, "AGENTS.md.new.2026-02-01"), "AGENTS v3\n");

    retireAppliedAveHomeDocUpgradeMarkers("AGENTS.md.new", "AGENTS v2\n", home);

    expect(existsSync(join(home, "AGENTS.md.new"))).toBe(false);
    expect(existsSync(join(home, "AGENTS.md.new.2026-01-01"))).toBe(false);
    expect(existsSync(join(home, "AGENTS.md.new.2026-02-01"))).toBe(true);
  });

  it("recognizes both allowlisted and currently packaged bytes as shipped", () => {
    // "AGENTS v1" is the fixture's packaged copy AND its own allowlist entry.
    expect(isShippedAgentsMdContent("AGENTS v1\n")).toBe(true);
    writeRes("AGENTS.md", "AGENTS v2\n");
    expect(isShippedAgentsMdContent("AGENTS v2\n")).toBe(true);
    expect(isShippedAgentsMdContent("AGENTS v1\n")).toBe(true);
    expect(isShippedAgentsMdContent("my own rules\n")).toBe(false);
  });
});
