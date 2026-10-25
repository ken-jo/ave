// Policy and file search share a glob subset: ** spans segments, * stays within a segment, and ? matches one character.

export interface GlobMatcherOptions {
  caseInsensitive?: boolean;
}

export function globToRegExp(
  pattern: string,
  opts: GlobMatcherOptions = {},
): RegExp {
  const normalized = normalizeGlobPath(pattern);
  const flags = opts.caseInsensitive === true ? "i" : "";
  return new RegExp(`^${globToRegExpSource(normalized)}$`, flags);
}

export function globMatch(
  path: string,
  pattern: string,
  opts: GlobMatcherOptions = {},
): boolean {
  return compileGlobMatcher(pattern, opts)(path);
}

// Compile once when checking many paths.
export function compileGlobMatcher(
  pattern: string,
  opts: GlobMatcherOptions = {},
): (path: string) => boolean {
  const caseInsensitive =
    opts.caseInsensitive ??
    (process.platform === "darwin" || process.platform === "win32");
  const regex = globToRegExp(pattern, { caseInsensitive });
  return (path) => regex.test(normalizeGlobPath(path));
}

// Reject literal names containing * or ? before storing glob grants: this grammar cannot escape them, so accepting them widens authority to siblings. Brackets and braces remain literal; backslashes normalize to separators.
export function containsGlobMetacharacter(value: string): boolean {
  return value.includes("*") || value.includes("?");
}

function globToRegExpSource(pattern: string): string {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    const next = pattern[i + 1];
    if (ch === "*" && next === "*") {
      if (pattern[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += escapeRegex(ch);
    i += 1;
  }
  return out;
}

function escapeRegex(ch: string): string {
  return /[\\^$+?.()|[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

function normalizeGlobPath(value: string): string {
  return value.replace(/\\/g, "/");
}
