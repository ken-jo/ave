/** Descriptors are excluded from installed payloads and size limits; SVG is active content and forbidden.
 * Export rejects links, special files, submodules and escaping paths. */
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
  extensionsAt?(path: string): readonly string[] | null;
  layout(path: string): boolean;
  describe: string;
}

const KB = 1024;
const MB = 1024 * KB;
const IMAGE = [".png", ".jpg", ".webp"] as const;
const FONT_FILE = /^files\/[^/]+\.(?:woff2|woff|ttf|otf)$/u;
const EXTENSIONLESS = new Set(["LICENSE", "NOTICE"]);
const SKILL_TEXT = [".md", ".txt", ".json", ".yaml", ".yml"] as const;
/** Skill scripts execute only through the shell tool and its approval gate. */
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

export const DESCRIPTOR_ALLOWANCE_BYTES = 256 * KB;

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

/** Enforce file count, size and layout after removing the descriptor from the payload. */
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
