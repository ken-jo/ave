/** Copy exactly one valid legacy board only when the host board is absent; use feature-namespace atomic writes. */
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { aveHome } from "../../shared/ave-home.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { createLogger } from "../../lib/logger.js";
import { isMissingPathError } from "../../lib/atomic-file.js";

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

  try {
    // Read directly rather than testing existence to avoid a stat/read race.
    try {
      await readFile(destPath, "utf-8");
      return false;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
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

    await ns.writeJson(BOARD_FILE, parsed);
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
