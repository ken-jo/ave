/** Use a per-test AVE_HOME so migration never reads or writes the real home. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, promises as fsPromises } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLegacyPluginBoardToWorkBoard } from "../work-board-migration.js";
import { WorkBoardStore } from "../../../main/work-board-store.js";
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
  const runsPath = () => join(home, "work-board", "workflow-runs.json");

  afterEach(async () => {
    vi.restoreAllMocks();
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

  it("strips template authority and stage state from every migrated row and history", async () => {
    const legacy = { ...SAMPLE_BOARD, items: [1, 2].map(id => ({ ...SAMPLE_BOARD.items[0], id,
      templateId: "template", runTemplateVersion: 1, runTemplateGraphHash: "a".repeat(64),
      runStartedBy: { kind: "schedule-attachment", pin: { templateId: "template" } }, pin: { templateId: "template" },
      stageRuns: [{ gate: { status: "approved" } }], stageJoins: [{ status: "integrated" }], runWorkspace: { kind: "git" },
      runHistory: [{ runId: "old", status: "completed", templateVersion: 1, templateGraphHash: "a".repeat(64), stageRuns: [] }],
      planApproval: { status: "approved", templateGraphHash: "a".repeat(64) },
    })) };
    const source = JSON.stringify(legacy);
    const legacyPath = writePluginBoard(home, "samplehub", source);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    expect(JSON.parse(readFileSync(destPath, "utf8"))).toEqual({ ...SAMPLE_BOARD, items: [1, 2].map(id => ({
      ...SAMPLE_BOARD.items[0], id, runHistory: [{ runId: "old", status: "completed" }], planApproval: { status: "approved" },
    })) });
    expect(readFileSync(legacyPath, "utf8")).toBe(source);
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

  it("raises the run file's row-id floor over every id the copy holds before it is written, so a new row is above them", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify({ ...SAMPLE_BOARD, items: [5, 1].map(id => ({ ...SAMPLE_BOARD.items[0], id })) }));
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    expect(JSON.parse(readFileSync(runsPath(), "utf-8")).rowIdFloor).toBe(5);
    expect(await new WorkBoardStore(destPath).create({ title: "next" })).toMatchObject({ status: "created", itemId: 6 });
  });

  it("never copies the legacy board again once it was copied: a host board deleted later stays deleted", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify(SAMPLE_BOARD));
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  /** Renames onto `target` (the board or the run file) fail with EIO for the calls `failing` picks; every other rename goes on. */
  function failRenamesOnto(target: string, failing: (call: number) => boolean) {
    const rename = fsPromises.rename.bind(fsPromises);
    let calls = 0;
    return vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith(join("work-board", target)) && failing(++calls)) throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
      return rename(from, to);
    });
  }
  const copyMark = () => JSON.parse(readFileSync(runsPath(), "utf-8")).legacyBoardCopy;

  it("a copy whose board write fails is made again whole at the next boot, and is marked done only once it is written", async () => {
    const legacy = { ...SAMPLE_BOARD, items: [5, 1].map(id => ({ ...SAMPLE_BOARD.items[0], id })) };
    writePluginBoard(home, "samplehub", JSON.stringify(legacy));
    const failing = failRenamesOnto("board.json", () => true);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
    expect(JSON.parse(readFileSync(runsPath(), "utf-8")).rowIdFloor).toBe(5);
    expect(copyMark()).toEqual({ through: 5 });
    failing.mockRestore();
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    expect(JSON.parse(readFileSync(destPath, "utf-8"))).toEqual(legacy);
    expect(copyMark()).toEqual({ through: 5, done: true });
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
    expect(await new WorkBoardStore(destPath).create({ title: "next" })).toMatchObject({ status: "created", itemId: 6 });
  });

  it("a copy whose board write failed is not made once an id was issued since: that row is not in the copy", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify({ ...SAMPLE_BOARD, items: [5, 1].map(id => ({ ...SAMPLE_BOARD.items[0], id })) }));
    const failing = failRenamesOnto("board.json", () => true);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    failing.mockRestore();
    // Before the next boot a create issues id 6, which a run may start on, and its board file is then removed.
    expect(await new WorkBoardStore(destPath).create({ title: "new" })).toMatchObject({ status: "created", itemId: 6 });
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
    expect(copyMark()).toEqual({ through: 5 });
  });

  it("copies a legacy board that holds no row id once: a host board deleted later stays deleted", async () => {
    const idless = { version: 1, items: [{ title: "no id", status: "planned" }] };
    writePluginBoard(home, "samplehub", JSON.stringify(idless));
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    expect(JSON.parse(readFileSync(destPath, "utf-8"))).toEqual(idless);
    expect(copyMark()).toEqual({ through: 0, done: true });
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it("a copy written whose done mark did not land is marked done at the next boot, so a board deleted later is not copied again", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify(SAMPLE_BOARD));
    // The first rename onto the run file marks the copy started; the second, its done mark, fails.
    const failing = failRenamesOnto("workflow-runs.json", call => call === 2);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    expect(copyMark()).toEqual({ through: 2 });
    failing.mockRestore();
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(copyMark()).toEqual({ through: 2, done: true });
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it.each([
    ["has issued row ids", `${JSON.stringify({ version: 1, rowIdFloor: 4, runs: [] })}\n`],
    ["holds a copy mark that does not read", `${JSON.stringify({ version: 1, rowIdFloor: 0, runs: [], legacyBoardCopy: { through: "x" } })}\n`],
    ["cannot be read", "{ not valid json"],
  ])("skips while the workflow run file %s: the legacy ids could be ids already issued", async (_label, runFile) => {
    writePluginBoard(home, "samplehub", JSON.stringify(SAMPLE_BOARD));
    mkdirSync(join(home, "work-board"), { recursive: true });
    writeFileSync(runsPath(), runFile, "utf-8");
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
    expect(readFileSync(runsPath(), "utf-8")).toBe(runFile);
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
