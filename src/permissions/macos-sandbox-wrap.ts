import { lstatSync, readlinkSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { SANDBOX_NAMED_ENTRIES } from "./sandbox-write-policy.js";
import { parseSandboxWrappedWords, quoteSandboxWrappedWord } from "./sandbox-wrapped-command.js";
import { t } from "../i18n/index.js";

const MAX_SANDBOX_WRAPPER_BYTES = 196_608;

export function assertMacSandboxWrapperSize(argv: readonly string[]): void {
  if (argv.reduce((bytes, word) => bytes + Buffer.byteLength(word) + 1, 0) > MAX_SANDBOX_WRAPPER_BYTES) {
    throw new Error(t("sandboxPolicy.tooLarge"));
  }
}

const GIT_MARKER_FILTER = '(regex #"/\\.[gG][iI][tT]$")';
// The sandbox runtime's `srt-sock-*` directory holds the backend sockets of every egress proxy of a host process, under the host temp
// directory (ensurePrivateSocketDir in its sandbox manager), which is a shell write root. Linux masks the directory in every wrap;
// Seatbelt has no mask, so the name is write-denied wherever it appears. Create and unlink are named beside the wildcard here and
// below because the runtime re-allows those two operations for every write root by name, and a rule that names an operation
// outranks a wildcard rule whatever their order.
const EGRESS_SOCKET_DIRECTORY_FILTER = '(regex #"/srt-sock-[^/]*(/|$)")';
const GIT_METADATA_RULES = [
  // Match the entry itself: an existing directory's children remain writable.
  `(deny file-write-create file-write-unlink ${GIT_MARKER_FILTER})`,
  `(deny file-write* (require-all ${GIT_MARKER_FILTER} (vnode-type REGULAR-FILE)))`,
  `(deny file-write* file-write-create file-write-unlink ${EGRESS_SOCKET_DIRECTORY_FILTER})`,
].join("\n");

// Measured: a profile is read with strings of up to 1022 bytes and refused ("Error reading string") from 1023. The limit is in
// bytes, so a name outside ASCII counts for each byte it takes.
const MAX_SEATBELT_STRING_BYTES = 1000;
function nameExpression(name: string): string {
  return name.replace(/[.]/gu, "\\.").replace(/[a-z]/giu, letter => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
}

// A write root as the start of a pattern. The write policy reads `*`, `?` and `**` in a root as wildcards, and a folder can also
// carry those characters in its name; the anchor matches both readings, which can only deny more. A regex literal (`#"…"`) keeps
// its backslashes through every quoting layer a wrap passes; it cannot hold a quote or a line break, so one in a root's name is
// matched as any character.
function rootAnchor(root: string): string {
  const body = root.replace(/\*\*|[.*+?^${}()|[\]\\"\r\n]/gu, part => part === "**" ? ".*" : part === "*" ? "[^/]*" : part === "?" ? "[^/]"
    : /["\r\n]/u.test(part) ? "." : `\\${part}`);
  return `^${body}/`;
}

// The named entries (SANDBOX_NAMED_ENTRIES: `.agents`, and the commands and hooks Ave loads from a project's `.ave`) directly beneath each
// write root, with everything beneath them. Rules in the profile instead of rows in the write policy, so that the directory that
// carries the `.ave` entries can be pinned too: the entries are path patterns, and an entry named `.ave` directly beneath a root
// cannot be created, removed or renamed. Moved away, its contents could be edited under another name and moved back, and a prepared
// directory could be renamed into an absent one. An existing `.ave` keeps its other children writable. Roots are given in their
// resolved spelling, which is what Seatbelt matches; an entry that is a link, or lies behind one, resolves elsewhere and is held by
// macLinkedNameTargetRules.
export function macWriteRootNameRules(writeRoots: readonly string[]): string {
  const roots = [...new Set(writeRoots.map(root => root.replace(/\/+$/u, "")))].filter(root => root !== "");
  const carriers = [...new Set(SANDBOX_NAMED_ENTRIES.filter(entry => entry.includes("/")).map(entry => entry.slice(0, entry.indexOf("/"))))];
  const rules: string[] = [];
  for (const root of roots) {
    const anchor = rootAnchor(root);
    const bytes = (names: readonly string[], tail: string): number => Buffer.byteLength(`${anchor}(${names.join("|")})${tail}`);
    const filters = (names: readonly string[], tail: string): string => {
      // Seatbelt refuses a profile that holds a string over its limit, so the names are spread over as many patterns as the
      // root's length needs.
      const groups: string[][] = [[]];
      for (const name of names.map(nameExpression)) {
        const group = groups[groups.length - 1] ?? [];
        if (group.length > 0 && bytes([...group, name], tail) > MAX_SEATBELT_STRING_BYTES) groups.push([name]);
        else group.push(name);
      }
      return groups.map(group => {
        if (bytes(group, tail) > MAX_SEATBELT_STRING_BYTES) throw new Error(t("sandboxPolicy.tooLarge"));
        return `(regex #"${anchor}(${group.join("|")})${tail}")`;
      }).join(" ");
    };
    rules.push(
      `(deny file-write* file-write-create file-write-unlink ${filters(SANDBOX_NAMED_ENTRIES, "(/|$)")})`,
      `(deny file-write-create file-write-unlink ${filters(carriers, "$")})`,
    );
  }
  return rules.join("\n");
}

// Follow `entry` beneath `root` (a resolved path) one component at a time, the way the kernel will. `visited` is every name the
// walk looks up, in order: links, real directories, the directories a `..` steps out of, and the first absent name, where the
// walk ends. `linked` says whether any of them was a link. An absent tail is kept as spelled.
const MAX_NAMED_ENTRY_LINKS = 40;
export function followNamedEntry(root: string, entry: string): { physical: string; visited: string[]; linked: boolean } {
  const visited: string[] = [];
  let links = 0;
  let current = root;
  const pending = entry.split("/");
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === undefined || name === "" || name === ".") continue;
    if (name === "..") { visited.push(current); current = dirname(current); continue; }
    const candidate = join(current, name);
    visited.push(candidate);
    let stat: Stats;
    try { stat = lstatSync(candidate); }
    catch (error) {
      if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return { physical: join(candidate, ...pending), visited, linked: links > 0 };
      }
      throw error;
    }
    if (!stat.isSymbolicLink()) { current = candidate; continue; }
    links += 1;
    if (links > MAX_NAMED_ENTRY_LINKS) throw new Error(t("sandboxPolicy.tooLarge"));
    const target = readlinkSync(candidate);
    if (isAbsolute(target)) current = "/";
    pending.unshift(...target.split("/"));
  }
  return { physical: current, visited, linked: links > 0 };
}

// A path as a pattern that also matches its other spellings on a volume that folds case and normalization: each ASCII letter in
// either case, and each run of other characters as any run within one name. Beneath a write root the root is taken as given (it
// is a resolved spelling) and only the rest is widened, which keeps the pattern short.
function foldedPathPattern(path: string, writeRoots: readonly string[]): string {
  const exact = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/["\r\n]/gu, ".");
  const folded = (text: string): string => text.replace(/\P{ASCII}+|[a-z]|[.*+?^${}()|[\]\\"\r\n]/giu, part =>
    /^[a-z]$/iu.test(part) ? `[${part.toLowerCase()}${part.toUpperCase()}]` : /["\r\n]/u.test(part) ? "." : part.charCodeAt(0) > 0x7f ? "[^/]+" : `\\${part}`);
  const base = writeRoots.map(root => root.replace(/\/+$/u, "")).filter(root => root !== "" && path.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length)[0];
  const pattern = base === undefined ? folded(path) : `${exact(base)}${folded(path.slice(base.length))}`;
  if (Buffer.byteLength(pattern) + 8 > MAX_SEATBELT_STRING_BYTES) throw new Error(t("sandboxPolicy.tooLarge"));
  return pattern;
}

// Where a named entry is a link, or lies behind one (`.agents -> tools/agents`, `.ave/commands -> ../cmds`, `.ave -> conf`), Seatbelt
// sees a write at the resolved path, which the name rules above do not cover. Two kinds of rule hold it, and there is no other
// mechanism:
//   - each resolved target is denied as a directory, present or not;
//   - every name the walk to it looked up (`visited` above) can be neither created, removed nor renamed, in either direction.
// Why the second is enough. Where a name resolves is decided by that walk alone: at each step the kernel looks one name up in the
// directory the previous steps reached, and gets a link's text, a directory, or nothing. A link's text cannot be edited in place;
// what a name gives can change only by removing, creating or renaming an entry under that name, and the rules deny all three for
// every name looked up, including the directory a `..` steps out of and the first absent name. So no step can come out
// differently, and the entry resolves to the denied target for as long as the command runs.
export function macLinkedNameTargetRules(targets: readonly string[], visited: readonly string[], writeRoots: readonly string[]): string {
  return [...new Set([
    ...targets.map(target => `(deny file-write* file-write-create file-write-unlink (regex #"^${foldedPathPattern(target, writeRoots)}(/|$)"))`),
    ...visited.filter(path => path !== "/").map(path => `(deny file-write-create file-write-unlink (regex #"^${foldedPathPattern(path, writeRoots)}$"))`),
  ])].join("\n");
}

// The default macOS volume folds case and normalization, so two spellings that differ only there name one directory. On a volume that
// does not fold, reading them as one can only add a deny.
function isAtOrUnder(parent: string, path: string): boolean {
  const [folded, candidate] = [parent, path].map(spelling => spelling.normalize("NFC").toLowerCase()) as [string, string];
  return candidate === folded || candidate.startsWith(folded.endsWith("/") ? folded : `${folded}/`);
}

// Write denies for app-owned directories (the Ave home, the confined processes' private roots) that lie inside one of the wrap's write
// roots, as they do when the working directory is the user's home folder. The read floor already denies them as whole directories,
// but a Seatbelt read deny leaves an appended or blind write open, and the runtime's write denies always win over its grants, so
// they cannot hold a directory whose children the wrap itself is granted (its HOME, temp and workspace). These rules can: each
// denies the directory except the wrap's own write roots inside it. They only deny, and only when a root contains the directory.
// Every path is given in each spelling it has; Seatbelt matches the resolved one. Moving the directory or an ancestor away is
// already refused by the runtime, which pins every read-denied path and its ancestors inside a write root.
export function macAppOwnedDirectoryWriteRules(directories: readonly string[], writeRoots: readonly string[]): string {
  const rules = new Set<string>();
  for (const directory of directories) {
    if (!writeRoots.some(root => isAtOrUnder(root, directory) && !isAtOrUnder(directory, root))) continue;
    const own = [...new Set(writeRoots.filter(root => isAtOrUnder(directory, root)))];
    const filter = `(subpath ${JSON.stringify(directory)})`;
    // Create and unlink are named for the reason given at the socket rule. Seatbelt compares `subpath` case-sensitively against the
    // resolved path, so an exception spelled otherwise does not match and the wrap's own directory stays denied: callers pass each
    // root in its realpath spelling (and may add others).
    rules.add(`(deny file-write* file-write-create file-write-unlink ${own.length === 0 ? filter
      : `(require-all ${filter} ${own.map(root => `(require-not (subpath ${JSON.stringify(root)}))`).join(" ")})`})`);
  }
  return [...rules].join("\n");
}

// Add typed entry protection that the runtime's subtree-deny API cannot express, and the caller's own deny rules after it.
export function hardenMacSandboxGitMetadata<T extends { readonly argv: string[]; readonly env: NodeJS.ProcessEnv }>(
  wrapped: T,
  appOwnedRules = "",
): T {
  if (wrapped.argv.length !== 3 || wrapped.argv[1] !== "-c") {
    throw new Error("macOS sandbox wrapper has an unexpected command shape");
  }
  const words = parseSandboxWrappedWords(wrapped.argv[2]!, "macOS sandbox wrapper");
  // The pinned wrapper emits an env prefix followed by this exact executable. Search only argument values, never the profile or user command text.
  const executable = words.findIndex(word => word.value === "/usr/bin/sandbox-exec");
  if (executable < 0 || words[0]?.value !== "env" || words[executable + 1]?.value !== "-p") {
    throw new Error("macOS sandbox wrapper does not invoke the expected profile");
  }
  const profileIndex = executable + 2;
  const profile = words[profileIndex]?.value;
  if (!profile?.startsWith("(version 1)") || words[profileIndex + 2]?.value !== "-c" || words.length !== profileIndex + 4) {
    throw new Error("macOS sandbox wrapper has an unexpected profile shape");
  }
  const argv = words.map((word, index) => index === profileIndex ? `${profile}\n${GIT_METADATA_RULES}${appOwnedRules ? `\n${appOwnedRules}` : ""}` : word.value);
  argv[0] = "/usr/bin/env";
  const command = argv.map(quoteSandboxWrappedWord).join(" ");
  const hardened = { ...wrapped, argv: [wrapped.argv[0]!, "-c", command] };
  assertMacSandboxWrapperSize(hardened.argv);
  return hardened;
}
