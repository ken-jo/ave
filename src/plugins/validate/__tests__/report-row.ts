/** Require the named report row; failures list actual checks to reveal missing coverage. */
import type { ReportRow } from "../report.js";

export function row(rows: readonly ReportRow[], check: string): ReportRow {
  const found = rows.find((candidate) => candidate.check === check);
  if (!found) throw new Error(`no row '${check}' in ${JSON.stringify(rows.map((r) => r.check))}`);
  return found;
}
