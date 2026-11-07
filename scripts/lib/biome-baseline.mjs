// Biome has no native baseline file, so accepted lint debt is a committed
// count per file and diagnostic category. Positions are dropped, like the
// Knip baseline does, so an unrelated edit above a baselined diagnostic does
// not churn the snapshot.

export const BIOME_BASELINE_SCHEMA_VERSION = 1;

function entryKey(entry) {
  return `${entry.file}\u0000${entry.category}`;
}

function diagnosticFile(diagnostic) {
  const path = diagnostic?.location?.path;
  const file = typeof path === "string" ? path : path?.file;
  if (typeof file !== "string" || file.length === 0) {
    throw new Error(`Biome diagnostic ${diagnostic?.category ?? "?"} has no file path`);
  }
  return file.split("\\").join("/");
}

export function normalizeBiomeDiagnostics(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.diagnostics)) {
    throw new Error("Biome JSON report is missing its diagnostics array");
  }
  if (report.summary?.diagnosticsNotPrinted !== 0) {
    throw new Error(
      `Biome withheld ${report.summary?.diagnosticsNotPrinted ?? "an unknown number of"}`
      + " diagnostics; run it with --max-diagnostics=none",
    );
  }

  const counts = new Map();
  for (const diagnostic of report.diagnostics) {
    if (typeof diagnostic?.category !== "string" || diagnostic.category.length === 0) {
      throw new Error("Biome JSON report contains a diagnostic without a category");
    }
    const entry = { file: diagnosticFile(diagnostic), category: diagnostic.category, count: 0 };
    const key = entryKey(entry);
    const existing = counts.get(key) ?? entry;
    existing.count += 1;
    counts.set(key, existing);
  }

  return [...counts.values()].sort((left, right) =>
    entryKey(left).localeCompare(entryKey(right), "en"));
}

// `added` holds every entry whose count grew, with the growth as its count;
// `resolved` holds every baseline entry whose count shrank, with the shrink.
export function compareBiomeBaseline(current, baseline) {
  const currentByKey = new Map(current.map((entry) => [entryKey(entry), entry]));
  const baselineByKey = new Map(baseline.map((entry) => [entryKey(entry), entry]));

  const added = [];
  for (const entry of current) {
    const accepted = baselineByKey.get(entryKey(entry))?.count ?? 0;
    if (entry.count > accepted) added.push({ ...entry, count: entry.count - accepted });
  }
  const resolved = [];
  for (const entry of baseline) {
    const remaining = currentByKey.get(entryKey(entry))?.count ?? 0;
    if (entry.count > remaining) resolved.push({ ...entry, count: entry.count - remaining });
  }
  return { added, resolved };
}

export function countBiomeDiagnostics(entries) {
  return entries.reduce((total, entry) => total + entry.count, 0);
}

export function formatBiomeEntry(entry) {
  return `${entry.file} ${entry.category} x${entry.count}`;
}
