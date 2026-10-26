import data from "./marketplace.json";

/**
 * The official marketplace's catalog at one recorded commit
 * (`scripts/marketplace-snapshot.mjs` writes `marketplace.json`). Pages name
 * packages only through `pkg()`, which fails the build for a name the catalog
 * does not have, so the site cannot show a package that does not exist.
 */

export interface Pkg {
  kind: string;
  name: string;
  displayName: string;
  description: string;
  path: string;
  version: string;
  versions: number;
  commit: string;
  minAppVersion: string;
  publishedAt: string;
  hostProtocol?: string;
  artifact?: { tag: string; asset: string; sha256: string };
  allowedDomains?: string[];
}

export const CATALOG = data.source;
const PACKAGES = data.packages as Pkg[];

export function pkg(name: string): Pkg {
  const found = PACKAGES.find((p) => p.name === name);
  if (!found) throw new Error(`the marketplace catalog at ${CATALOG.commit} has no package "${name}"`);
  return found;
}

export function packagesOf(kind: string): Pkg[] {
  return PACKAGES.filter((p) => p.kind === kind);
}

export function countOf(kind: string): number {
  return (data.counts as Record<string, number>)[kind] ?? 0;
}

export const TOTAL = PACKAGES.length;

/** Every package kind the catalog has. */
export const KINDS = Object.keys(data.counts);
