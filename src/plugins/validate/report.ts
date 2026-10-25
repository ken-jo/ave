/** Emit one JSON report row per check; diagnostic paths remain relative to the plugin directory. */

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

export function reportExitCode(rows: readonly ReportRow[]): 0 | 1 {
  return rows.some((row) => row.ok === false) ? 1 : 0;
}

export function reportLines(rows: readonly ReportRow[]): string {
  return rows.map((row) => `${JSON.stringify(row)}\n`).join("");
}

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
