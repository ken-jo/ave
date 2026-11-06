import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceSnapshot } from "../../sources/snapshot.js";
import type { LegacyContentKind, LegacyContentReport } from "../legacy-content.js";
import { runLegacyMigration } from "../run.js";
const ADOPTED: LegacyContentReport = { adopted: [{ source: "ave", kind: "theme", name: "aurora" }], failed: [] };
const snapshot = { packages: [{ kind: "theme", name: "aurora" }, { kind: "skill", name: "review" }] } as SourceSnapshot;
describe("runLegacyMigration", () => {
  let dir: string;
  let markerPath: string;
  const now = () => new Date("2026-09-24T00:00:00.000Z");
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ave-legacy-run-")); markerPath = join(dir, "legacy-migration.json"); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  it("waits for the official snapshot and adopts content once", async () => {
    const content = vi.fn(async () => ADOPTED);
    expect(await runLegacyMigration({ markerPath, officialSnapshot: null, content, now })).toBeNull();
    expect(content).not.toHaveBeenCalled();
    expect(await runLegacyMigration({ markerPath, officialSnapshot: snapshot, content, now })).toEqual({ content: ADOPTED });
    expect(await runLegacyMigration({ markerPath, officialSnapshot: snapshot, content, now })).toBeNull();
    expect(content).toHaveBeenCalledTimes(1);
  });
  it("lists content by kind and name", async () => {
    let listed: ((kind: LegacyContentKind, name: string) => boolean) | undefined;
    await runLegacyMigration({ markerPath, officialSnapshot: snapshot, content: async lookup => { listed = lookup; return ADOPTED; }, now });
    expect(listed!("theme", "aurora")).toBe(true);
    expect(listed!("provider", "aurora")).toBe(false);
    expect(listed!("theme", "review")).toBe(false);
  });
  it("retries failed content adoption including a previously incomplete marker", async () => {
    writeFileSync(markerPath, JSON.stringify({ version: 1, reportedUnmanaged: ["old-plugin"] }));
    const content = vi.fn().mockResolvedValueOnce({ adopted: [], failed: [{ key: { source: "ave", kind: "theme", name: "aurora" }, message: "offline" }] }).mockResolvedValue(ADOPTED);
    const run = () => runLegacyMigration({ markerPath, officialSnapshot: snapshot, content, now });
    await run(); await run(); expect(await run()).toBeNull();
    expect(content).toHaveBeenCalledTimes(2);
  });
  it("refuses an unreadable marker without adopting", async () => {
    writeFileSync(markerPath, JSON.stringify({ version: 2 }));
    const content = vi.fn(async () => ADOPTED);
    await expect(runLegacyMigration({ markerPath, officialSnapshot: snapshot, content, now })).rejects.toThrow(/not a migration marker/);
    expect(content).not.toHaveBeenCalled();
  });
});
