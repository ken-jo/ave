/**
 * The one package of a direct source (design §8.1, §8.2).
 *
 * At the source's path the first file found decides, in this order:
 * `ave-package.json` (used as is), `plugin.json` (an Agent Plugins
 * manifest), `SKILL.md`, `AGENTS.md`, `server.json`. Anything but the
 * descriptor yields a synthesized descriptor held to the same schema. The
 * snapshot and every install read the package through here, at the same
 * commit, so both see the same descriptor.
 *
 * A file that declares no version gets `0.0.0+g<commit12>`: the commit names
 * it, and any new commit is an update (`isSynthesizedVersion`).
 */
import { parse as parseYaml } from "yaml";
import { parseFrontmatterBlock } from "../../main/skill-store.js";
import { AVE_EXTENSION_NAMESPACE } from "../../plugins/public-contract.js";
import { parseStrictJson } from "../catalog/strict-json.js";
import type { PackageDescriptor } from "../catalog/types.js";
import { validateDescriptorText, validateSynthesizedDescriptor } from "../catalog/validate.js";
import type { MarketplaceErrorCode } from "../errors.js";
import { assertRepoPath, type BareRepo } from "../git/repo.js";
import type { GitRemote } from "../git/run-git.js";
import { manifestAuthority } from "../resolve/manifest-rules.js";

export const DIRECT_FILES = ["ave-package.json", "plugin.json", "SKILL.md", "AGENTS.md", "server.json"] as const;

export type DirectDetectedFile = (typeof DIRECT_FILES)[number];

/** Per-file read limits: the descriptor's, the plugin manifest's, and the entry files'. */
const LIMITS: Readonly<Record<DirectDetectedFile, number>> = {
  "ave-package.json": 256 * 1024,
  "plugin.json": 1024 * 1024,
  "SKILL.md": 1024 * 1024,
  "AGENTS.md": 1024 * 1024,
  "server.json": 256 * 1024,
};

const SYNTHESIZED = /^0\.0\.0\+g[0-9a-f]{12}$/u;
const PACKAGE_NAME = /^(?!.*--)[a-z][a-z0-9-]*[a-z0-9]$/u;
const DESCRIPTION_MAX = 1000;
const LABEL_MAX = 100;

export interface DirectPackage {
  descriptor: PackageDescriptor;
  detectedFrom: DirectDetectedFile;
  versionSynthesized: boolean;
}

export type DirectRead =
  | { ok: true; found: DirectPackage }
  | { ok: false; code: MarketplaceErrorCode; error: string };

export interface DirectReadInput {
  repo: BareRepo;
  remote: GitRemote;
  commit: string;
  /** The package path in the repository; "" is the root. */
  path: string;
  signal?: AbortSignal;
}

/** A version the commit names because the package declares none (design §8.2). */
export function isSynthesizedVersion(version: string): boolean {
  return SYNTHESIZED.test(version);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filePath(dir: string, file: string): string {
  return dir ? `${dir}/${file}` : file;
}

/** A package name from a directory or repository name: lowercase, `-` for anything else. */
function nameFrom(raw: string): string | null {
  const name = raw.toLowerCase().replace(/\.git$/u, "").replace(/[^a-z0-9-]+/gu, "-").replace(/-{2,}/gu, "-").replace(/^[^a-z]+|-+$/gu, "");
  return name.length >= 3 && name.length <= 64 && PACKAGE_NAME.test(name) ? name : null;
}

/** The package directory's own name, or the repository's at the root. */
function placeName(path: string, remote: GitRemote): string | null {
  const segments = (path || remote.url.path).split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  return last ? nameFrom(last) : null;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/[\u0000-\u001f\u007f]+/gu, " ");
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

function presentation(displayName: unknown, description: unknown): Pick<PackageDescriptor, "displayName" | "description"> {
  const label = text(displayName, LABEL_MAX);
  const about = text(description, DESCRIPTION_MAX);
  return { ...(label ? { displayName: label } : {}), ...(about ? { description: about } : {}) };
}

type Synthesis = { ok: true; descriptor: PackageDescriptor; versionSynthesized: boolean } | { ok: false; code: MarketplaceErrorCode; error: string };

function fromPluginManifest(source: string, path: string): Synthesis {
  let manifest: unknown;
  try {
    manifest = parseStrictJson(source);
  } catch (error) {
    return { ok: false, code: "SOURCE_INDEX_INVALID", error: `plugin.json does not parse: ${(error as Error).message}` };
  }
  if (!isRecord(manifest) || typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    return { ok: false, code: "SOURCE_INDEX_INVALID", error: "plugin.json needs a name and a version" };
  }
  const ave = isRecord(manifest.extensions) ? manifest.extensions[AVE_EXTENSION_NAMESPACE] : undefined;
  if (!isRecord(ave)) return { ok: false, code: "SOURCE_INDEX_INVALID", error: `plugin.json has no extensions["${AVE_EXTENSION_NAMESPACE}"]` };
  const minAppVersion = isRecord(ave.requires) ? ave.requires.minAppVersion : undefined;
  if (typeof minAppVersion !== "string") {
    return { ok: false, code: "PACKAGE_COMPAT_UNDECLARED", error: "plugin.json does not declare requires.minAppVersion" };
  }
  // Exactly the manifest's own fields: the staged plugin.json is compared with them field by field.
  const authority = manifestAuthority(manifest)!;
  return {
    ok: true,
    versionSynthesized: false,
    descriptor: {
      schemaVersion: 1,
      kind: "plugin",
      name: manifest.name,
      version: manifest.version,
      minAppVersion,
      ...presentation(manifest.displayName, manifest.description),
      payload: { authority, artifact: path ? { tree: path } : {} },
    },
  };
}

function fromMarkdown(kind: "skill" | "agent", entry: "SKILL.md" | "AGENTS.md", source: string, fallbackName: string | null, commit: string): Synthesis {
  let header: Record<string, unknown> = {};
  const { block } = parseFrontmatterBlock(source);
  if (block.length > 0) {
    try {
      const parsed: unknown = parseYaml(block);
      if (isRecord(parsed)) header = parsed;
    } catch (error) {
      return { ok: false, code: "SOURCE_INDEX_INVALID", error: `${entry} front matter does not parse: ${(error as Error).message}` };
    }
  }
  const name = typeof header.name === "string" ? header.name.trim() : fallbackName;
  if (!name) return { ok: false, code: "SOURCE_INDEX_INVALID", error: `${entry} names no package, and the folder name is not a package name` };
  const declared = typeof header.version === "string" ? header.version.trim() : undefined;
  return {
    ok: true,
    versionSynthesized: declared === undefined,
    descriptor: {
      schemaVersion: 1,
      kind,
      name,
      version: declared ?? `0.0.0+g${commit.slice(0, 12)}`,
      // These kinds run no code; any Ave reads them (design §8.2).
      minAppVersion: "0.0.0",
      ...presentation(undefined, header.description),
      payload: { entry },
    },
  };
}

function fromServerJson(source: string): Synthesis {
  let document: unknown;
  try {
    document = parseStrictJson(source);
  } catch (error) {
    return { ok: false, code: "SOURCE_INDEX_INVALID", error: `server.json does not parse: ${(error as Error).message}` };
  }
  if (!isRecord(document) || typeof document.name !== "string" || typeof document.version !== "string") {
    return { ok: false, code: "SOURCE_INDEX_INVALID", error: "server.json needs a name and a version" };
  }
  const registryName = document.name;
  const name = nameFrom(registryName.slice(registryName.lastIndexOf("/") + 1));
  if (!name) return { ok: false, code: "SOURCE_INDEX_INVALID", error: `server.json name ${registryName} does not end in a package name` };
  return {
    ok: true,
    versionSynthesized: false,
    descriptor: {
      schemaVersion: 1,
      kind: "mcp",
      name,
      version: document.version,
      minAppVersion: "0.0.0",
      ...presentation(document.title, document.description),
      payload: { serverJson: "server.json" },
    },
  };
}

/**
 * Read the direct package at `path` and `commit`. `null` when none of the
 * files is there (SOURCE_NOT_A_MARKETPLACE for the caller); a failure names
 * the file that decided and why it cannot be used.
 */
export async function readDirectPackage(input: DirectReadInput): Promise<DirectRead | null> {
  if (input.path) assertRepoPath(input.path);
  const paths = DIRECT_FILES.map((file) => filePath(input.path, file));
  await input.repo.ensureBlobs(input.remote, input.commit, paths, input.signal);
  for (const file of DIRECT_FILES) {
    const bytes = await input.repo.readFile(input.commit, filePath(input.path, file), LIMITS[file]);
    if (bytes === null) continue;
    const source = bytes.toString("utf8");
    if (file === "ave-package.json") {
      const checked = validateDescriptorText(source, { direct: true });
      return checked.ok
        ? { ok: true, found: { descriptor: checked.value, detectedFrom: file, versionSynthesized: false } }
        : { ok: false, code: "SOURCE_INDEX_INVALID", error: checked.error };
    }
    const synthesized: Synthesis = file === "plugin.json"
      ? fromPluginManifest(source, input.path)
      : file === "SKILL.md"
        ? fromMarkdown("skill", file, source, placeName(input.path, input.remote), input.commit)
        : file === "AGENTS.md"
          ? fromMarkdown("agent", file, source, placeName(input.path, input.remote), input.commit)
          : fromServerJson(source);
    if (!synthesized.ok) return synthesized;
    const checked = validateSynthesizedDescriptor(synthesized.descriptor, file);
    return checked.ok
      ? { ok: true, found: { descriptor: checked.value, detectedFrom: file, versionSynthesized: synthesized.versionSynthesized } }
      : { ok: false, code: "SOURCE_INDEX_INVALID", error: checked.error };
  }
  return null;
}
