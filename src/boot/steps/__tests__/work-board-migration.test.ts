/** Use a per-test AVE_HOME so migration never reads or writes the real home. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLegacyPluginBoardToWorkBoard } from "../work-board-migration.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const SAMPLE_BOARD = { version: 1, nextId: 3, items: [{ id: 1, title: "legacy task", status: "planned", priority: "medium", created_at: "x", updated_at: "x" }] };

function pluginBoardPath(home: string, pluginId: string): string {
  // Plugins persist under their PluginStorage `data/` subdir.
  return join(home, "plugins", pluginId, "data", "board.json");
}

function writePluginBoard(home: string, pluginId: string, contents: string): string {
  const path = pluginBoardPath(home, pluginId);
  mkdirSync(join(home, "plugins", pluginId, "data"), { recursive: true });
  writeFileSync(path, contents, "utf-8");
  return path;
}

describe("work-board migration", () => {
  let prevAveHome: string | undefined;
  let home: string;
  let destPath: string;

  beforeEach(() => {
    prevAveHome = process.env.AVE_HOME;
    home = mkdtempSync(join(tmpdir(), "ave-wb-mig-"));
    process.env.AVE_HOME = home;
    destPath = join(home, "work-board", "board.json");
  });

  afterEach(async () => {
    if (prevAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = prevAveHome;
    await cleanupTmpDir(home);
  });

  it("migrates once: dest absent + exactly one legacy board → copies + returns true", async () => {
    const legacyPath = writePluginBoard(home, "samplehub", JSON.stringify(SAMPLE_BOARD));

    const migrated = await migrateLegacyPluginBoardToWorkBoard();

    expect(migrated).toBe(true);
    expect(existsSync(destPath)).toBe(true);
    expect(JSON.parse(readFileSync(destPath, "utf-8"))).toEqual(SAMPLE_BOARD);
    // Copy rather than move to preserve the source for inspection.
    expect(existsSync(legacyPath)).toBe(true);
    expect(JSON.parse(readFileSync(legacyPath, "utf-8"))).toEqual(SAMPLE_BOARD);
  });

  it("is idempotent: a second run with the dest present skips and returns false", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify(SAMPLE_BOARD));
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);

    // A pre-existing destination is the idempotency marker.
    const second = await migrateLegacyPluginBoardToWorkBoard();
    expect(second).toBe(false);
  });

  it("skips when the destination already exists (never overwrites host board)", async () => {
    mkdirSync(join(home, "work-board"), { recursive: true });
    const hostBoard = { version: 1, nextId: 1, items: [] };
    writeFileSync(destPath, JSON.stringify(hostBoard), "utf-8");
    writePluginBoard(home, "samplehub", JSON.stringify(SAMPLE_BOARD));

    const migrated = await migrateLegacyPluginBoardToWorkBoard();

    expect(migrated).toBe(false);
    expect(JSON.parse(readFileSync(destPath, "utf-8"))).toEqual(hostBoard);
  });

  it("skips + warns when more than one legacy board exists (ambiguous source)", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify(SAMPLE_BOARD));
    writePluginBoard(home, "sampleassistant", JSON.stringify({ version: 1, nextId: 1, items: [] }));

    const migrated = await migrateLegacyPluginBoardToWorkBoard();

    expect(migrated).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it("returns false when there is no legacy plugin board at all", async () => {
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it("skips when the single legacy board is not valid JSON", async () => {
    writePluginBoard(home, "samplehub", "{ not valid json");

    const migrated = await migrateLegacyPluginBoardToWorkBoard();

    expect(migrated).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it.each([
    ["a JSON array", "[]"],
    ["a JSON string", "\"x\""],
    ["a JSON number", "42"],
    ["a JSON null", "null"],
    ["an object whose items is not an array", JSON.stringify({ version: 1, nextId: 1, items: "x" })],
  ])("skips a parseable-but-wrong-shape legacy board (%s)", async (_label, contents) => {
    writePluginBoard(home, "samplehub", contents);

    const migrated = await migrateLegacyPluginBoardToWorkBoard();

    expect(migrated).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });
});
