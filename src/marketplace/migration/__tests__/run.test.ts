/**
 * When the first-boot migration runs: not before the official snapshot
 * exists, once after every entry was read, and never over a marker it cannot
 * read.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "../../sources/snapshot.js";
import type { LegacyPluginReport } from "../legacy-plugins.js";
import { officialPluginsFrom, runLegacyMigration } from "../run.js";

const CLEAN: LegacyPluginReport = { bound: ["meeting"], unmanaged: [], lostGrants: [], failed: [] };

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

  it("waits for the official snapshot, then runs once", async () => {
    const plugins = vi.fn(async () => CLEAN);
    expect(await runLegacyMigration({ markerPath, officialSnapshot: null, plugins, now })).toBeNull();
    expect(plugins).not.toHaveBeenCalled();

    expect(await runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, now })).toEqual(CLEAN);
    expect(await runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, now })).toBeNull();
    expect(plugins).toHaveBeenCalledOnce();
  });

  it("runs again while an entry could not be read", async () => {
    const plugins = vi.fn()
      .mockResolvedValueOnce({ ...CLEAN, failed: [{ plugin: "calendar", message: "unreadable" }] })
      .mockResolvedValueOnce(CLEAN);
    await runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, now });
    await runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, now });
    await runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, now });
    expect(plugins).toHaveBeenCalledTimes(2);
  });

  it("refuses a marker it cannot read rather than migrating again", async () => {
    writeFileSync(markerPath, `{"version":2}`);
    const plugins = vi.fn(async () => CLEAN);
    await expect(runLegacyMigration({ markerPath, officialSnapshot: snapshot, plugins, now })).rejects.toThrow(/not a migration marker/);
    expect(plugins).not.toHaveBeenCalled();
  });
});
