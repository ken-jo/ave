/**
 * The plugin validator's report (`docs/design/plugin-hostapi-protocol.md`
 * §9.7 P2, §10.2).
 *
 * One row per check, written to stdout as one JSON object per line, and a
 * summary to stderr. A row is passed, failed or not exercised:
 *
 *  - `ok: true` — the check ran and held;
 *  - `ok: false` — the check ran and failed, or could not run because the
 *    plugin did something wrong first; this is what makes the exit code 1;
 *  - `ok: null` — the check did not run and says why in `message`, which
 *    starts with `not exercised`. A grant the validator does not apply, a tool
 *    with no arguments available, and every step after one that failed are
 *    reported this way, never as passed.
 *
 * `path` is a JSON pointer into `plugin.json` (`#/extensions/…`), or a file
 * relative to the plugin directory, when the row is about a place an author
 * edits.
 */

export interface ReportRow {
  readonly check: string;
  readonly ok: boolean | null;
  readonly path?: string;
  readonly message: string;
}

const NOT_EXERCISED = "not exercised";

export function passed(check: string, message: string, path?: string): ReportRow {
  return path === undefined ? { check, ok: true, message } : { check, ok: true, path, message };
}

export function failed(check: string, message: string, path?: string): ReportRow {
  return path === undefined ? { check, ok: false, message } : { check, ok: false, path, message };
}

export function notExercised(check: string, why: string, path?: string): ReportRow {
  const message = `${NOT_EXERCISED}: ${why}`;
  return path === undefined ? { check, ok: null, message } : { check, ok: null, path, message };
}

/** `0` when every row passed or was not exercised, else `1`. */
export function reportExitCode(rows: readonly ReportRow[]): 0 | 1 {
  return rows.some((row) => row.ok === false) ? 1 : 0;
}

/** The report as stdout carries it: one JSON object per row, each ended by `0x0A`. */
export function reportLines(rows: readonly ReportRow[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

/** The one-line count stderr carries, with each failure named after it. */
export function reportSummary(pluginDir: string, rows: readonly ReportRow[]): string {
  const failures = rows.filter((row) => row.ok === false);
  const skipped = rows.filter((row) => row.ok === null).length;
  const head =
    `ave-plugin-validate ${pluginDir}: ${rows.length - failures.length - skipped} passed, ` +
    `${failures.length} failed, ${skipped} not exercised`;
  const lines = failures.map(
    (row) => `  ✗ ${row.check}${row.path === undefined ? "" : ` (${row.path})`}: ${row.message}`,
  );
  return `${[head, ...lines].join("\n")}\n`;
}
