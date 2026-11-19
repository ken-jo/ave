import { mayContainHomePath, redactHomePathsInText } from "./dlp-filter.js";

function redactAuditKeys(value: object): object {
  const entries = Object.entries(value).map(([source, entry]) => ({
    source, key: redactHomePathsInText(source), entry,
  }));
  if (entries.every(({ source, key }) => source === key)) return value;
  const groups = new Map<string, typeof entries>();
  for (const entry of entries) {
    const group = groups.get(entry.key);
    if (group) group.push(entry);
    else groups.set(entry.key, [entry]);
  }
  // Reserve preferred names first. An unchanged key keeps its name, then
  // source-key order gives the other entries stable suffixes across permutations.
  const reserved = new Set(groups.keys());
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      if (a.source === b.source) return 0;
      if (a.source === key) return -1;
      if (b.source === key) return 1;
      return a.source < b.source ? -1 : 1;
    });
    let suffix = 2;
    for (const entry of group.slice(1)) {
      do { entry.key = `${key}#${suffix++}`; } while (reserved.has(entry.key));
      reserved.add(entry.key);
    }
  }
  return Object.fromEntries(entries.map(({ key, entry }) => [key, entry]));
}

const isRawJson = (JSON as typeof JSON & { isRawJSON?: (value: unknown) => boolean }).isRawJSON;

function isPlainRecord(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Redact each value during serialization so numeric lexemes and hooks keep their usual behavior. */
export function stringifyHomeRedacted(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, current: unknown) => {
    if (typeof current === "string") return redactHomePathsInText(current);
    if (current && typeof current === "object" && !isRawJson?.(current)
      && isPlainRecord(current) && Object.keys(current).some(mayContainHomePath)) {
      return redactAuditKeys(current);
    }
    return current;
  });
}
