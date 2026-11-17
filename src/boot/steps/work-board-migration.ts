/** Copy exactly one valid legacy board only when the host board is absent and no row id was ever issued, once: the run file marks the copy
 * started before the board is written and done only after; use feature-namespace atomic writes. */
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { aveHome } from "../../shared/ave-home.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
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

/** Return true only for a performed copy; ambiguity, existing state, and errors leave boot running. */
export async function migrateLegacyPluginBoardToWorkBoard(): Promise<boolean> {
  const ns = openFeatureNamespace("work-board");
  const destPath = join(ns.dir, BOARD_FILE);
  const pluginsRoot = join(aveHome(), "plugins");
  const runs = new WorkflowRunStore(join(ns.dir, "workflow-runs.json"));

  try {
    // Read directly rather than testing existence to avoid a stat/read race.
    let destPresent = true;
    try {
      await readFile(destPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      destPresent = false;
    }
    if (destPresent) {
      // A copy started and written whose done mark did not land is marked now, so a board deleted later is not copied again.
      await runs.finishLegacyBoardCopy();
      return false;
    }

    const legacyBoards = await findLegacyPluginBoards(pluginsRoot);
    if (legacyBoards.length === 0) {
      return false;
    }
    if (legacyBoards.length > 1) {
      log.warn(
        "boot: work-board migration skipped — multiple legacy plugin boards found (%s); cannot disambiguate the canonical source",
        legacyBoards.join(", "),
      );
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
      return false;
    }

    if (
      !isBoardShape(parsed)
    ) {
      log.warn(
        "boot: work-board migration skipped — legacy plugin board.json (%s) is not a board (expected an object with an items array)",
        legacyPath,
      );
      return false;
    }

    // The copy's ids go through the run file's row-id floor: only a home that never issued an id, or whose copy was started and never
    // finished with no id issued since, takes the copy. One write marks it started and raises the floor over every id it holds before
    // it is written, and it is marked done only after: a copy whose write fails is made again whole at the next boot, and one made, with
    // or without ids, is never made again; none of its ids is issued again.
    const copy = stripLegacyBoardTemplateRunFields(parsed);
    if (!(await runs.startLegacyBoardCopy(highestRowId(copy)))) {
      log.warn("boot: work-board migration skipped — row ids were already issued on this home, the copy was already made, or the workflow run file awaits review");
      return false;
    }
    await ns.writeJson(BOARD_FILE, copy);
    // One that does not land now is made at the next boot, which finds the board written.
    await runs.finishLegacyBoardCopy().catch((err: Error) => log.warn("boot: work-board migration copied the board but did not mark it done: %s", err.message));
    log.info(
      "boot: migrated legacy plugin board → work-board namespace (%s → %s)",
      legacyPath,
      destPath,
    );
    return true;
  } catch (err) {
    log.warn(
      "boot: work-board migration failed (non-fatal): %s",
      (err as Error).message,
    );
    return false;
  }
}
