// One segment of a re-allowed child: a literal name, or a predicate over one folded name.
type BoundarySegment = string | ((name: string) => boolean);

interface AveHomeReadReallow {
  readonly segments: readonly BoundarySegment[];
  readonly why: string;
}

// A directory a host composer names per extension: never a dot entry (caches, install staging) and never a host JSON record or its rotations.
const extensionDirectory = (name: string): boolean => !name.startsWith(".") && !/\.json(?:\.|$)/iu.test(name);
// The contribution-approval store shares the payload cache directory and is not a payload.
const payloadDirectory = (name: string): boolean => extensionDirectory(name) && name.toLowerCase() !== "plugin-contribution-trust";

/**
 * The sandbox read-deny covers the whole Ave home; these are the only children a confined process may be granted beneath it. A
 * grant is honored only inside one of them, and the protected rows inside them (`config`, `certs`, `sessions`, contribution
 * approvals) still need their own pierce. This is a ceiling, not a grant: each wrap re-opens only what it names.
 */
export const AVE_HOME_READ_REALLOWS: readonly AveHomeReadReallow[] = Object.freeze([
  { segments: ["workspace"], why: "default working directory and in-project write scope of shells and the terminal" },
  { segments: ["sandbox"], why: "per-process sandbox HOME and temp roots on macOS/Linux; each keeps its own deny and re-opens only its own directory" },
  { segments: ["plugins", extensionDirectory], why: "a plugin's install root and its data, storage and worker directories" },
  { segments: ["plugins", ".cache", payloadDirectory], why: "a plugin's payload generations, loaded by its own confined processes" },
  { segments: ["agent-plugin-data", extensionDirectory], why: "an agent plugin's data directory for its hooks and bundled servers" },
  { segments: ["packages", "agent-plugin", extensionDirectory], why: "an agent plugin's installed generations" },
  { segments: ["mcp", extensionDirectory], why: "an MCP stdio server's installed files and its private sandbox root" },
  { segments: ["runtime", "uv"], why: "host-managed uv, granted to programs inside it and to declaring plugins" },
  { segments: ["runtime", "python-envs"], why: "host-managed Python environments, granted the same way" },
  { segments: ["runtime", "venv"], why: "the default host-managed venv, granted to a program inside it" },
  { segments: ["runtime", "python"], why: "the base interpreter that venv was created from, granted with it" },
  { segments: ["certs"], why: "corporate CA bundle; still floor-protected, opened only by a declared hostDirectory pierce" },
  { segments: ["sessions"], why: "saved sessions; still floor-protected, opened only by the builtin shell's session pierce" },
  { segments: ["mxc-staging"], why: "Windows container holder staging directories" },
]);

/** Whether `segments` (relative to the Ave home, case-folded like the path they came from) lie inside a re-allowed child. */
export function isAveHomeReadReallowed(segments: readonly string[]): boolean {
  return AVE_HOME_READ_REALLOWS.some((row) => row.segments.length <= segments.length
    && row.segments.every((segment, index) => typeof segment === "string" ? segment === segments[index] : segment(segments[index]!)));
}
