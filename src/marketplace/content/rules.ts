/**
 * File rules for content packages (design §5.2, §5.4): what a package
 * directory of each content kind may hold, and how much of it.
 *
 * The descriptor (`ave-package.json`) sits in every package directory; it is
 * read at the version commit, never installed, and does not count toward the
 * limits. SVG is refused for every kind: rendered inline it is an active
 * document. Links, devices, submodules and paths that leave the directory are
 * refused by the export itself (`BareRepo.exportPath`).
 */
import type { PackageKind } from "../catalog/types.js";
import { MarketplaceError } from "../errors.js";

export const CONTENT_KINDS = ["agent-plugin", "skill", "agent", "theme", "font", "language", "provider", "messaging-connection"] as const satisfies readonly PackageKind[];
export type ContentKind = (typeof CONTENT_KINDS)[number];

export function isContentKind(kind: PackageKind): kind is ContentKind {
  return (CONTENT_KINDS as readonly string[]).includes(kind);
}

interface ContentRule {
  maxBytes: number;
  maxFiles: number;
  extensions: readonly string[];
  /** The extensions a path allows when they depend on where it sits; `extensions` otherwise. */
  extensionsAt?(path: string): readonly string[] | null;
  /** Whether `path` (package-relative, `/`-separated) belongs in this kind's layout. */
  layout(path: string): boolean;
  /** The layout, for a refusal message. */
  describe: string;
}

const KB = 1024;
const MB = 1024 * KB;
const IMAGE = [".png", ".jpg", ".webp"] as const;
const FONT_FILE = /^files\/[^/]+\.(?:woff2|woff|ttf|otf)$/u;
/** Files named without an extension: a package's license and attribution. */
const EXTENSIONLESS = new Set(["LICENSE", "NOTICE"]);
const SKILL_TEXT = [".md", ".txt", ".json", ".yaml", ".yml"] as const;
/**
 * The Agent Skills layout (agentskills.io): executable code in `scripts/`,
 * documentation in `references/`, templates and resources in `assets/`. A
 * script runs only through the shell tool, under its approval.
 */
const SKILL_SCRIPTS = [".py", ".js", ".mjs", ".cjs", ".sh", ".pin", ...SKILL_TEXT] as const;
const SKILL_ASSETS = [...SKILL_TEXT, ...IMAGE, ".csv", ".tsv", ".pdf", ".hwp", ".hwpx", ".docx", ".xlsx", ".pptx"] as const;

export const CONTENT_RULES: Readonly<Record<ContentKind, ContentRule>> = Object.freeze({
  "agent-plugin": {
    maxBytes: 8 * MB,
    maxFiles: 256,
    extensions: [".json", ".md"],
    extensionsAt: (path) => path.startsWith("server/") || path.startsWith("skills/") ? null : [".json", ".md"],
    layout: (path) => {
      if (["plugin.json", "mcp.json", "README.md", "CHANGELOG.md", "LICENSE", "NOTICE"].includes(path)) return true;
      if (path.startsWith("server/")) return path.length > "server/".length;
      if (path.startsWith("ai.agent-connector.ave/")) return /\.(?:json|md)$/iu.test(path);
      const match = /^skills\/([a-z][a-z0-9-]{0,62})\/(.+)$/u.exec(path);
      return match !== null && contentFileProblem("skill", match[2]!) === null;
    },
    describe: "plugin.json, mcp.json, skills/, server/, ai.agent-connector.ave/, and package notes",
  },
  skill: {
    maxBytes: 2 * MB,
    maxFiles: 64,
    extensions: [...SKILL_TEXT, ...IMAGE],
    extensionsAt: (path) => (path.startsWith("scripts/") ? SKILL_SCRIPTS : path.startsWith("assets/") ? SKILL_ASSETS : [...SKILL_TEXT, ...IMAGE]),
    layout: (path) =>
      path === "SKILL.md" || EXTENSIONLESS.has(path) || path.startsWith("scripts/") || path.startsWith("references/") || path.startsWith("assets/"),
    describe: "SKILL.md, LICENSE, NOTICE, scripts/, references/ and assets/",
  },
  agent: {
    maxBytes: 256 * KB,
    maxFiles: 1,
    extensions: [".md"],
    layout: (path) => path === "AGENTS.md",
    describe: "AGENTS.md",
  },
  theme: {
    maxBytes: 256 * KB,
    maxFiles: 4,
    extensions: [".json", ...IMAGE],
    layout: (path) => path === "theme.json" || (!path.includes("/") && IMAGE.some((ext) => path.toLowerCase().endsWith(ext))),
    describe: "theme.json and a preview image",
  },
  font: {
    maxBytes: 20 * MB,
    maxFiles: 32,
    extensions: [".json", ".woff2", ".woff", ".ttf", ".otf"],
    layout: (path) => path === "font.json" || path === "LICENSE" || FONT_FILE.test(path),
    describe: "font.json, LICENSE and files/*.woff2|woff|ttf|otf",
  },
  language: {
    maxBytes: 4 * MB,
    maxFiles: 2,
    extensions: [".json"],
    layout: (path) => path === "language.json" || path === "messages.json",
    describe: "language.json and messages.json",
  },
  provider: {
    maxBytes: 64 * KB,
    maxFiles: 1,
    extensions: [".json"],
    layout: (path) => path === "provider.json",
    describe: "provider.json",
  },
  "messaging-connection": {
    maxBytes: 64 * KB,
    maxFiles: 1,
    extensions: [".json"],
    layout: (path) => path === "connection.json",
    describe: "connection.json",
  },
});

/** Bytes the descriptor may add to an export on top of the kind's limit (design §5.4). */
export const DESCRIPTOR_ALLOWANCE_BYTES = 256 * KB;

/** Why `path` may not be installed as part of a `kind` package, or null. The descriptor is never asked about. */
export function contentFileProblem(kind: ContentKind, path: string): string | null {
  const rule = CONTENT_RULES[kind];
  const lower = path.toLowerCase();
  if (lower.endsWith(".svg") || lower.endsWith(".svgz")) return `SVG is not allowed: ${path}`;
  if (!rule.layout(path)) return `a ${kind} package holds ${rule.describe} only: ${path}`;
  const extensions = rule.extensionsAt?.(path) ?? (rule.extensionsAt ? null : rule.extensions);
  if (extensions === null) return null;
  if (!EXTENSIONLESS.has(path) && !extensions.some((ext) => lower.endsWith(ext))) {
    return `${path}: a ${kind} package allows ${extensions.join(" ")} files there`;
  }
  return null;
}

/**
 * Hold a package's `files` to the rules of `kind` (design §5.4): count, total
 * size and every path. The descriptor must already be out of the list.
 * CONTENT_RULE_VIOLATION names the first rule broken.
 */
export function checkContentFiles(kind: ContentKind, files: ReadonlyArray<{ path: string; data: Buffer }>): void {
  const rule = CONTENT_RULES[kind];
  if (files.length > rule.maxFiles) throw new MarketplaceError("CONTENT_RULE_VIOLATION", `a ${kind} package holds at most ${rule.maxFiles} files`);
  const bytes = files.reduce((sum, file) => sum + file.data.length, 0);
  if (bytes > rule.maxBytes) throw new MarketplaceError("CONTENT_RULE_VIOLATION", `a ${kind} package holds at most ${rule.maxBytes} bytes`);
  for (const file of files) {
    const problem = contentFileProblem(kind, file.path);
    if (problem) throw new MarketplaceError("CONTENT_RULE_VIOLATION", problem);
  }
}
