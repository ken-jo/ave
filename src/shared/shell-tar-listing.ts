export interface TarListing {
  archivePaths: string[];
  archiveArgIndices: number[];
}

const LISTING_SWITCHES = new Set(["--verbose", "--gzip", "--bzip2", "--xz", "--numeric-owner"]);

/** Only explicit-file listings are provable reads; unknown options, file-supplied options, and remote archives remain unresolved. Check expansion provenance separately. */
export function parseTarListing(argv: readonly string[]): TarListing | null {
  const archivePaths: string[] = [];
  const archiveArgIndices: number[] = [];
  let lists = false;
  let optionsEnded = false;
  const takeArchive = (value: string | undefined, index: number): boolean => {
    // A colon may select remote transport; an omitted file may select a device or environment archive, so neither is a literal read.
    if (!value || value.includes(":")) return false;
    archivePaths.push(value);
    archiveArgIndices.push(index);
    return true;
  };

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (optionsEnded) continue; // Remaining names select entries, not host files.
    if (token === "--") { optionsEnded = true; continue; }
    if (token === "--list") { lists = true; continue; }
    if (LISTING_SWITCHES.has(token)) continue;
    if (token === "--file" || token.startsWith("--file=")) {
      if (!takeArchive(token === "--file" ? argv[++i] : token.slice(7), i)) return null;
      continue;
    }
    if (token.startsWith("--")) return null;
    // Only the first argument permits a traditional undashed option cluster.
    const traditional = i === 1 && !token.startsWith("-");
    if (!traditional && !token.startsWith("-")) continue;
    const flags = traditional ? token : token.slice(1);
    if (!flags) return null;
    for (let j = 0; j < flags.length; j += 1) {
      const flag = flags[j]!;
      if (flag === "t") lists = true;
      else if (flag === "f") {
        // Dashed clusters may embed a file value; traditional clusters take it from following arguments.
        const glued = traditional ? "" : flags.slice(j + 1);
        if (!takeArchive(glued || argv[++i], i)) return null;
        if (!traditional) break;
      } else if (!"vzjJ".includes(flag)) return null;
    }
  }
  return lists && archivePaths.length > 0 ? { archivePaths, archiveArgIndices } : null;
}
