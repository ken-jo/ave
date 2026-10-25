import { parseSandboxWrappedWords, quoteSandboxWrappedWord } from "./sandbox-wrapped-command.js";

const GIT_MARKER_FILTER = '(regex #"/\\.[gG][iI][tT]$")';
const GIT_METADATA_RULES = [
  // Match the entry itself: an existing directory's children remain writable.
  `(deny file-write-create file-write-unlink ${GIT_MARKER_FILTER})`,
  `(deny file-write* (require-all ${GIT_MARKER_FILTER} (vnode-type REGULAR-FILE)))`,
].join("\n");

// Add typed entry protection that the runtime's subtree-deny API cannot express.
export function hardenMacSandboxGitMetadata<T extends { readonly argv: string[]; readonly env: NodeJS.ProcessEnv }>(
  wrapped: T,
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
  const argv = words.map((word, index) => index === profileIndex ? `${profile}\n${GIT_METADATA_RULES}` : word.value);
  return { ...wrapped, argv: [wrapped.argv[0]!, "-c", argv.map(quoteSandboxWrappedWord).join(" ")] };
}
