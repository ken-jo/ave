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

export const CONTENT_KINDS = ["skill", "agent", "theme", "font", "language", "provider", "messaging-connection"] as const satisfies readonly PackageKind[];
export type ContentKind = (typeof CONTENT_KINDS)[number];

export function isContentKind(kind: PackageKind): kind is ContentKind {
  return (CONTENT_KINDS as readonly string[]).includes(kind);
}

interface ContentRule {
  maxBytes: number;
  maxFiles: number;
  extensions: readonly string[];
  /** Whether `path` (package-relative, `/`-separated) belongs in this kind's layout. */
  layout(path: string): boolean;
  /** The layout, for a refusal message. */
  describe: string;
}

const KB = 1024;
const MB = 1024 * KB;
const IMAGE = [".png", ".jpg", ".webp"] as const;
const FONT_FILE = /^files\/[^/]+\.(?:woff2|woff|ttf|otf)$/u;

export const CONTENT_RULES: Readonly<Record<ContentKind, ContentRule>> = Object.freeze({
  skill: {
    maxBytes: 2 * MB,
    maxFiles: 64,
    extensions: [".md", ".txt", ".json", ".yaml", ".yml", ...IMAGE],
    layout: (path) => path === "SKILL.md" || path.startsWith("references/") || path.startsWith("assets/"),
    describe: "SKILL.md, references/ and assets/",
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
  // LICENSE is the one file named without an extension (font packages).
  if (path !== "LICENSE" && !rule.extensions.some((ext) => lower.endsWith(ext))) {
    return `${path}: a ${kind} package allows ${rule.extensions.join(" ")} files`;
  }
  return null;
}
