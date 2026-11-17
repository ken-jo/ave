/** Copy exactly one valid legacy board only when the host board is absent and no row id was ever issued, once: the run file marks the copy
 * started before the board is written and done only once the board is read back as its bytes. */
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { aveHome } from "../../shared/ave-home.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { rewriteKeepingBytes } from "../../main/storage/rewrite-keeping-bytes.js";
import { WorkflowRunStore } from "../../main/workflow-run-store.js";
import { createLogger } from "../../lib/logger.js";
import { isMissingPathError } from "../../lib/atomic-file.js";

import { stripLegacyBoardTemplateRunFields } from "../../work-board/template-run-fields.js";

const log = createLogger("ave");

const BOARD_FILE = "board.json";

/** Reject parseable values without an items array so invalid migration cannot masquerade as success. */
function isBoardShape(value: unknown): value is { items: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { items?: unknown }).items)
  );
}

/** The highest row id a board holds: its rows' ids and the id below its `nextId`. */
function highestRowId(board: { items: unknown[]; nextId?: unknown }): number {
  const ids = board.items.flatMap((row) => {
    const id = typeof row === "object" && row !== null ? (row as { id?: unknown }).id : undefined;
    return typeof id === "number" && Number.isSafeInteger(id) && id >= 1 ? [id] : [];
  });
  const below = typeof board.nextId === "number" && Number.isSafeInteger(board.nextId) && board.nextId >= 1 ? board.nextId - 1 : 0;
  return ids.reduce((highest, id) => Math.max(highest, id), below);
}

/** Read candidates directly to avoid stat/read races; a missing plugin root means no migration. */
async function findLegacyPluginBoards(pluginsRoot: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(pluginsRoot, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Plugin storage resolves under data/, not the plugin directory root.
    const candidate = join(pluginsRoot, entry.name, "data", BOARD_FILE);
    try {
      await readFile(candidate, "utf-8");
      found.push(candidate);
    } catch (err) {
      if (!isMissingPathError(err)) throw err;
    }
  }
  return found.sort();
}

const sha256 = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** At boot: true when the copy was made, or was started and is not done (no sample rows are seeded then); errors leave boot running.
 * `kept` hears of legacy boards left as they are, since none or more than one reads as a board. */
export async function migrateLegacyPluginBoardToWorkBoard(kept?: (paths: readonly string[]) => void): Promise<boolean> {
  const ns = openFeatureNamespace("work-board");
  const runs = new WorkflowRunStore(join(ns.dir, "workflow-runs.json"));
  const copied = await copyLegacyPluginBoard(join(ns.dir, BOARD_FILE), runs, kept).catch((err: Error) => {
    log.warn("boot: work-board migration failed (non-fatal): %s", err.message);
    return false;
  });
  return copied || Boolean(await runs.pendingLegacyBoardCopy().catch(() => undefined));
}

/** The copy onto `destPath` beside the run file `runs`, made at boot and by a create while one is started and not done: true only when it
 * wrote the board. A board already there is never written over; it marks such a copy done only when it holds the copy's bytes. A skip
 * returns false; a failure before or of the board write throws. A legacy board is only read, never written over or removed; `kept` hears
 * of those left so because none or more than one reads as a board. */
export async function copyLegacyPluginBoard(destPath: string, runs: WorkflowRunStore, kept?: (paths: readonly string[]) => void): Promise<boolean> {
  // Read directly rather than testing existence to avoid a stat/read race.
  let dest: Buffer | undefined;
  try {
    dest = await readFile(destPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (dest !== undefined) {
    // A copy written whose done mark did not land is marked now, so a board deleted later is not copied again; any other board (one a
    // create wrote) never marks it.
    await runs.finishLegacyBoardCopy(sha256(dest));
    return false;
  }

  const legacyBoards = await findLegacyPluginBoards(join(aveHome(), "plugins"));
  if (legacyBoards.length === 0) {
    return false;
  }
  if (legacyBoards.length > 1) {
    log.warn(
      "boot: work-board migration skipped — multiple legacy plugin boards found (%s); cannot disambiguate the canonical source",
      legacyBoards.join(", "),
    );
    kept?.(legacyBoards);
    return false;
  }

  const legacyPath = legacyBoards[0];
  const legacyRaw = await readFile(legacyPath, "utf-8");

  // Parse before adoption and write through the namespace helper for atomic permissions-safe persistence.
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacyRaw);
  } catch {
    log.warn(
      "boot: work-board migration skipped — legacy plugin board.json (%s) is not valid JSON",
      legacyPath,
    );
    kept?.(legacyBoards);
    return false;
  }

  if (
    !isBoardShape(parsed)
  ) {
    log.warn(
      "boot: work-board migration skipped — legacy plugin board.json (%s) is not a board (expected an object with an items array)",
      legacyPath,
    );
    kept?.(legacyBoards);
    return false;
  }

  // The copy's ids go through the run file's row-id floor: only a home that never issued an id, or whose copy was started and never
  // finished with no id issued since, takes the copy. One write marks it started, with the hash of its bytes, and raises the floor over
  // every id it holds before it is written, and it is marked done only once the board is read back as those bytes: a copy whose write
  // fails is made again whole by the next create or boot, and one made, with or without ids, is never made again; none of its ids is
  // issued again.
  const copy = stripLegacyBoardTemplateRunFields(parsed);
  const bytes = `${JSON.stringify(copy, null, 2)}\n`;
  if (!(await runs.startLegacyBoardCopy(highestRowId(copy), sha256(bytes)))) {
    log.warn("boot: work-board migration skipped — row ids were already issued on this home, the copy was already made, or the workflow run file awaits review");
    return false;
  }
  // A board that appeared since it was read above is the host's: the copy is refused, and the board stays as it is.
  await rewriteKeepingBytes(destPath, bytes, { tag: "invalid-rows", check: (prior) => {
    if (prior !== undefined) throw new Error("a host board appeared before the legacy copy was written");
  } });
  // One not marked now is marked by the next board write or boot, which finds the board holding its bytes.
  const marked = await readFile(destPath).then((written) => runs.finishLegacyBoardCopy(sha256(written))).catch((err: Error) => err.message);
  if (marked !== true) {
    log.warn("boot: work-board migration copied the board but did not mark it done: %s", marked || "the board read back is not the copy, or the mark was not stored");
  }
  log.info(
    "boot: migrated legacy plugin board → work-board namespace (%s → %s)",
    legacyPath,
    destPath,
  );
  return true;
}
