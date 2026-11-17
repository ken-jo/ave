/** Use a per-test AVE_HOME so migration never reads or writes the real home. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
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
  // The sha256 of the bytes a copy of `board` writes.
  const copyHash = (board: unknown) => createHash("sha256").update(`${JSON.stringify(board, null, 2)}\n`).digest("hex");
  const LEGACY_5_1 = { ...SAMPLE_BOARD, items: [5, 1].map(id => ({ ...SAMPLE_BOARD.items[0], id })) };
  const boardIds = () => JSON.parse(readFileSync(destPath, "utf-8")).items.map((row: { id: number }) => row.id).sort((a: number, b: number) => a - b);

  it("a copy whose board write fails is left started (no samples are seeded), made again whole at the next boot, and marked done only once it is read back", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify(LEGACY_5_1));
    const failing = failRenamesOnto("board.json", () => true);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    expect(existsSync(destPath)).toBe(false);
    expect(JSON.parse(readFileSync(runsPath(), "utf-8")).rowIdFloor).toBe(5);
    expect(copyMark()).toEqual({ through: 5, board: copyHash(LEGACY_5_1) });
    failing.mockRestore();
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    expect(JSON.parse(readFileSync(destPath, "utf-8"))).toEqual(LEGACY_5_1);
    expect(copyMark()).toEqual({ through: 5, board: copyHash(LEGACY_5_1), done: true });
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
    expect(await new WorkBoardStore(destPath).create({ title: "next" })).toMatchObject({ status: "created", itemId: 6 });
  });

  it("a create before the next boot first makes a copy whose board write failed whole, and is refused, issuing no id, while it cannot", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify(LEGACY_5_1));
    const failing = failRenamesOnto("board.json", () => true);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    const store = new WorkBoardStore(destPath);
    expect(await store.create({ title: "new" })).toEqual({ status: "invalid", reason: "work-board-copy-pending" });
    expect(existsSync(destPath)).toBe(false);
    expect(JSON.parse(readFileSync(runsPath(), "utf-8"))).toMatchObject({ rowIdFloor: 5, legacyBoardCopy: { through: 5, board: copyHash(LEGACY_5_1) } });
    failing.mockRestore();
    // The copy is written and marked done first; the row goes above its ids.
    expect(await store.create({ title: "new" })).toMatchObject({ status: "created", itemId: 6 });
    expect(boardIds()).toEqual([1, 5, 6]);
    expect(copyMark()).toEqual({ through: 5, board: copyHash(LEGACY_5_1), done: true });
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it("a copy a create wrote whose done mark cannot be stored refuses the create, shows the copied rows and is written over by nothing", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify(LEGACY_5_1));
    const failingBoard = failRenamesOnto("board.json", () => true);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    failingBoard.mockRestore();
    const store = new WorkBoardStore(destPath);
    expect(await store.list()).toMatchObject({ status: "ok", items: [] });
    // The create marks the copy started again and writes it; every done mark after that fails.
    const failingMark = failRenamesOnto("workflow-runs.json", call => call >= 2);
    expect(await store.create({ title: "new" })).toEqual({ status: "invalid", reason: "work-board-copy-pending" });
    const copied = readFileSync(destPath);
    expect(JSON.parse(copied.toString("utf8"))).toEqual(LEGACY_5_1);
    const listed = await store.list();
    expect(listed.status === "ok" && listed.items.map(item => item.id)).toEqual([5, 1]);
    await expect(store.update(1, { title: "edited" })).rejects.toThrow(/not marked done/);
    expect(readFileSync(destPath)).toEqual(copied);
    expect(copyMark()).toEqual({ through: 5, board: copyHash(LEGACY_5_1) });
    failingMark.mockRestore();
    expect(await store.create({ title: "new" })).toMatchObject({ status: "created", itemId: 6 });
    expect(boardIds()).toEqual([1, 5, 6]);
    expect(copyMark()).toEqual({ through: 5, board: copyHash(LEGACY_5_1), done: true });
  });

  it("copies a legacy board that holds no row id once: a host board deleted later stays deleted", async () => {
    const idless = { version: 1, items: [{ title: "no id", status: "planned" }] };
    writePluginBoard(home, "samplehub", JSON.stringify(idless));
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    expect(JSON.parse(readFileSync(destPath, "utf-8"))).toEqual(idless);
    expect(copyMark()).toEqual({ through: 0, board: copyHash(idless), done: true });
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it("a copy written whose done mark did not land is marked done at the next boot, so a board deleted later is not copied again", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify(SAMPLE_BOARD));
    // The first rename onto the run file marks the copy started; the second, its done mark, fails.
    const failing = failRenamesOnto("workflow-runs.json", call => call === 2);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    expect(copyMark()).toEqual({ through: 2, board: copyHash(SAMPLE_BOARD) });
    failing.mockRestore();
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(copyMark()).toEqual({ through: 2, board: copyHash(SAMPLE_BOARD), done: true });
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it.each([
    ["an update", (store: WorkBoardStore) => store.update(1, { title: "edited" })],
    ["a reconcile", (store: WorkBoardStore) => store.reconcileInterruptedRuns()],
  ])("a copy written whose done mark did not land is marked done by the next board write (%s) before it changes the board", async (_label, write) => {
    writePluginBoard(home, "samplehub", JSON.stringify({ ...SAMPLE_BOARD, items: [{ ...SAMPLE_BOARD.items[0], runStatus: "executing" }] }));
    const failing = failRenamesOnto("workflow-runs.json", call => call >= 2);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    const copied = readFileSync(destPath);
    const store = new WorkBoardStore(destPath);
    // While the mark cannot be stored, nothing is written over the copy.
    await expect(write(store)).rejects.toThrow(/not marked done/);
    expect(readFileSync(destPath)).toEqual(copied);
    failing.mockRestore();
    await write(store);
    expect(readFileSync(destPath)).not.toEqual(copied);
    expect(copyMark()).toMatchObject({ through: 2, done: true });
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it("a board that is not the copy's bytes never marks a copy left started done and is never written over; a create goes on above its ids", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify(SAMPLE_BOARD));
    const failing = failRenamesOnto("board.json", () => true);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    failing.mockRestore();
    // A board put there by hand before the next boot.
    const host = { version: 1, nextId: 1, items: [] };
    writeFileSync(destPath, JSON.stringify(host), "utf-8");
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    expect(JSON.parse(readFileSync(destPath, "utf-8"))).toEqual(host);
    expect(copyMark()).toEqual({ through: 2, board: copyHash(SAMPLE_BOARD) });
    expect(await new WorkBoardStore(destPath).create({ title: "new" })).toMatchObject({ status: "created", itemId: 3 });
    expect(boardIds()).toEqual([3]);
    expect(copyMark()).toEqual({ through: 2, board: copyHash(SAMPLE_BOARD) });
    // An id was issued above the copy's: it is never made.
    rmSync(destPath);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(false);
    expect(existsSync(destPath)).toBe(false);
  });

  it("a create goes on when a copy left started has nothing left to copy, and does not mark it done", async () => {
    writePluginBoard(home, "samplehub", JSON.stringify(SAMPLE_BOARD));
    const failing = failRenamesOnto("board.json", () => true);
    expect(await migrateLegacyPluginBoardToWorkBoard()).toBe(true);
    failing.mockRestore();
    rmSync(join(home, "plugins"), { recursive: true, force: true });
    expect(await new WorkBoardStore(destPath).create({ title: "new" })).toMatchObject({ status: "created", itemId: 3 });
    expect(boardIds()).toEqual([3]);
    expect(copyMark()).toEqual({ through: 2, board: copyHash(SAMPLE_BOARD) });
  });

  it.each([
    ["has issued row ids", `${JSON.stringify({ version: 1, rowIdFloor: 4, runs: [] })}\n`],
    ["holds a copy mark that does not read", `${JSON.stringify({ version: 1, rowIdFloor: 0, runs: [], legacyBoardCopy: { through: "x" } })}\n`],
    ["holds a copy mark without the hash of its board", `${JSON.stringify({ version: 1, rowIdFloor: 0, runs: [], legacyBoardCopy: { through: 0 } })}\n`],
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
