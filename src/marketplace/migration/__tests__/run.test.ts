/**
 * When the first-boot migration runs: not before the official snapshot
 * exists, plugins before content, once after both finished without a
 * failure, and never over a marker it cannot read.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "../../sources/snapshot.js";
import type { LegacyContentKind, LegacyContentReport } from "../legacy-content.js";
import type { LegacyPluginReport } from "../legacy-plugins.js";
import { officialPluginsFrom, runLegacyMigration } from "../run.js";

const CLEAN: LegacyPluginReport = { bound: ["meeting"], unmanaged: [], lostGrants: [], failed: [] };
const ADOPTED: LegacyContentReport = { adopted: [{ source: "ave", kind: "theme", name: "aurora" }], failed: [] };

const snapshot = {
  sourceId: "ave",
  commit: "c".repeat(40),
  fetchedAt: "2026-09-24T00:00:00.000Z",
  marketplace: { name: "ave" },
  packages: [
    {
      kind: "plugin",
      name: "meeting",
      path: "plugins/meeting",
      versions: [
        { version: "0.5.0", commit: "d".repeat(40), minAppVersion: "0.7.0", publishedAt: "2026-05-01T00:00:00Z", artifact: { release: { sha256: "A".repeat(64) }, archive: { url: "https://x.example/a.zip", sha256: "b".repeat(64) } } },
        { version: "0.4.0", commit: "e".repeat(40), minAppVersion: "0.7.0", publishedAt: "2026-04-01T00:00:00Z", artifact: { tree: "plugins/meeting" } },
      ],
    },
    { kind: "skill", name: "review", path: "skills/review", versions: [] },
    { kind: "theme", name: "aurora", path: "themes/aurora", versions: [] },
  ],
  revocations: [],
  diagnostics: [],
} as unknown as SourceSnapshot;

describe("officialPluginsFrom", () => {
  it("finds plugins only, with the snapshot commit and each version's pins in lower case", () => {
    const lookup = officialPluginsFrom(snapshot);
    const meeting = lookup("meeting")!;
    expect(meeting.snapshotCommit).toBe("c".repeat(40));
    expect(meeting.packagePath).toBe("plugins/meeting");
    expect(meeting.pins("0.5.0")).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(meeting.pins("0.4.0")).toEqual([]);
    expect(meeting.pins("0.3.0")).toEqual([]);
    expect(lookup("review")).toBeNull();
    expect(lookup("orion")).toBeNull();
  });
});

describe("runLegacyMigration", () => {
  let dir: string;
  let markerPath: string;
  const now = () => new Date("2026-09-24T00:00:00.000Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-legacy-run-"));
    markerPath = join(dir, "legacy-migration.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("waits for the official snapshot, then migrates plugins before content, once", async () => {
    const order: string[] = [];
    const plugins = vi.fn(async () => (order.push("plugins"), CLEAN));
    const content = vi.fn(async () => (order.push("content"), ADOPTED));
    expect(await runLegacyMigration({ markerPath, officialSnapshot: null, plugins, content, now })).toBeNull();
    expect(plugins).not.toHaveBeenCalled();

    expect(await runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, content, now })).toEqual({ plugins: CLEAN, content: ADOPTED });
    expect(await runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, content, now })).toBeNull();
    expect(order).toEqual(["plugins", "content"]);
  });

  it("tells the content half what the official snapshot lists, by kind and name", async () => {
    let listed: ((kind: LegacyContentKind, name: string) => boolean) | null = null;
    await runLegacyMigration({
      markerPath,
      officialSnapshot: snapshot,
      plugins: async () => CLEAN,
      content: async (lookup) => ((listed = lookup), ADOPTED),
      now,
    });
    expect(listed!("theme", "aurora")).toBe(true);
    expect(listed!("provider", "aurora")).toBe(false);
    expect(listed!("theme", "review")).toBe(false);
  });

  it.each([
    ["a plugin entry could not be read", { ...CLEAN, failed: [{ plugin: "calendar", message: "unreadable" }] }, ADOPTED],
    ["a content install failed", CLEAN, { adopted: [], failed: [{ key: { source: "ave", kind: "theme" as const, name: "aurora" }, message: "offline" }] }],
  ])("runs again while %s", async (_what, firstPlugins, firstContent) => {
    const plugins = vi.fn().mockResolvedValueOnce(firstPlugins).mockResolvedValue(CLEAN);
    const content = vi.fn().mockResolvedValueOnce(firstContent).mockResolvedValue(ADOPTED);
    await runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, content, now });
    await runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, content, now });
    await runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, content, now });
    expect(plugins).toHaveBeenCalledTimes(2);
    expect(content).toHaveBeenCalledTimes(2);
  });

  it("names an unlisted plugin once, though a failure makes the migration run again", async () => {
    const failing = { adopted: [], failed: [{ key: { source: "ave", kind: "theme" as const, name: "aurora" }, message: "offline" }] };
    const plugins = vi.fn()
      .mockResolvedValueOnce({ ...CLEAN, unmanaged: ["calendar"] })
      .mockResolvedValue({ bound: [], unmanaged: ["calendar", "notes"], lostGrants: [], failed: [] });
    const content = vi.fn().mockResolvedValueOnce(failing).mockResolvedValueOnce(failing).mockResolvedValue(ADOPTED);
    const run = () => runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, content, now });

    expect((await run())?.plugins.unmanaged).toEqual(["calendar"]);
    expect((await run())?.plugins.unmanaged).toEqual(["notes"]);
    expect((await run())?.plugins.unmanaged).toEqual([]);
    expect(await run()).toBeNull();
  });

  it("refuses a marker it cannot read rather than migrating again", async () => {
    writeFileSync(markerPath, `{"version":2}`);
    const plugins = vi.fn(async () => CLEAN);
    const content = vi.fn(async () => ADOPTED);
    await expect(runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, content, now })).rejects.toThrow(/not a migration marker/);
    expect(plugins).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
  });
});
