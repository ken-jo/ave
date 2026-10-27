import { isRecord } from "./is-record.js";
import { OBSERVATION_LIMITS } from "./agent-observation.js";

export type DocumentEditJournalRecord =
  | { v: 1; kind: "begin"; editId: string; target: string; beforeHash: string }
  | { v: 1; kind: "cell"; editId: string; sheet: string; cell: string; before: string; after: string }
  | { v: 1; kind: "commit"; editId: string; afterHash: string };

const JOURNAL_KEYS = Object.freeze({
  begin: ["v", "kind", "editId", "target", "beforeHash"],
  cell: ["v", "kind", "editId", "sheet", "cell", "before", "after"],
  commit: ["v", "kind", "editId", "afterHash"],
});

function isCellAddress(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const address = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value);
  if (!address || Number(address[2]) > 1_048_576) return false;
  let column = 0;
  for (const character of address[1]!) column = column * 26 + character.charCodeAt(0) - 64;
  return column <= 16_384;
}

/** Validates display-only records; location and invocation authority remain with the reader. */
export function isDocumentEditJournalRecord(value: unknown): value is DocumentEditJournalRecord {
  if (!isRecord(value) || value.v !== 1 || typeof value.editId !== "string"
    || !/^[A-Za-z0-9_-]{1,80}$/.test(value.editId)
    || (value.kind !== "begin" && value.kind !== "cell" && value.kind !== "commit")) return false;
  const keys = JOURNAL_KEYS[value.kind];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return false;
  if (value.kind === "begin") return typeof value.target === "string" && value.target.length > 0
    && value.target.length <= 4096 && /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(value.target)
    && !/[\u0000\r\n]/u.test(value.target)
    && typeof value.beforeHash === "string" && /^[a-f0-9]{64}$/.test(value.beforeHash);
  if (value.kind === "commit") return typeof value.afterHash === "string" && /^[a-f0-9]{64}$/.test(value.afterHash);
  return typeof value.sheet === "string" && value.sheet.length > 0 && value.sheet.length <= 128
    && isCellAddress(value.cell) && typeof value.before === "string" && value.before.length <= OBSERVATION_LIMITS.maxValueChars
    && typeof value.after === "string" && value.after.length <= OBSERVATION_LIMITS.maxValueChars;
}
