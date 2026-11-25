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
// A project's `.ave` holds the commands and hooks Ave loads, and their write denies below are path patterns. The
// directory that carries those paths must stay where it is: moved away, its contents could be edited under another name and moved
// back, and a prepared directory could be renamed into an absent `.ave`.
const AVE_PROJECT_MARKER_FILTER = '(regex #"/\\.[aA][vV][eE]$")';
// Names a confined command must not write wherever they appear, each with everything beneath it: the config another agent or cloud
// tool loads from a project and the commands and hooks Ave loads from a project's `.ave` (SANDBOX_NAMED_ENTRIES), and the sandbox
// runtime's `srt-sock-*` directory, which holds the backend sockets of every egress proxy of a host process under the host temp
// directory (ensurePrivateSocketDir in its sandbox manager). Linux masks that directory in every wrap; Seatbelt has no mask. One
// rule here instead of rows in the write policy: a row per write root costs the root's length for every name, and these names cost
// the policy budget nothing this way. Create and unlink are named beside the wildcard because the runtime re-allows those two
// operations for every write root by name, and a rule that names an operation outranks a wildcard rule whatever their order.
function nameExpression(name: string): string {
  return name.replace(/[.]/gu, "\\.").replace(/[a-z]/gu, letter => `[${letter}${letter.toUpperCase()}]`);
}
const NAMED_ENTRY_FILTER = `(regex #"/(${[...SANDBOX_NAMED_ENTRIES.map(nameExpression), "srt-sock-[^/]*"].join("|")})(/|$)")`;
const GIT_METADATA_RULES = [
  // Match the entry itself: an existing directory's children remain writable.
  `(deny file-write-create file-write-unlink ${GIT_MARKER_FILTER})`,
  `(deny file-write* (require-all ${GIT_MARKER_FILTER} (vnode-type REGULAR-FILE)))`,
  `(deny file-write-create file-write-unlink ${AVE_PROJECT_MARKER_FILTER})`,
  `(deny file-write* file-write-create file-write-unlink ${NAMED_ENTRY_FILTER})`,
].join("\n");

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
    // Create and unlink are named for the reason given at the name rule. Seatbelt compares `subpath` case-sensitively against the
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
