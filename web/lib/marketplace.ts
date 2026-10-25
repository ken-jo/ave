import data from "./marketplace.json";
import type { Locale } from "./i18n";

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

/**
 * The home page's extension kinds (`HomeCopy.plugins.kinds`, same order) and
 * one real catalog package for each kind the official catalog carries. Fonts,
 * messaging connections and local folders have no package in the official
 * catalog, so they have no card.
 */
export const KIND_SAMPLES: (string | null)[] = [
  "local-indexer",
  "fetch-mcp",
  "api-designer",
  "engineering-code-reviewer",
  "deepseek",
  "nord",
  null,
  "korean",
  null,
  null,
];

/** The labels of a package card, named like the app's install review. */
export interface PkgLabels {
  source: string;
  commit: string;
  contents: string;
  compat: string;
  version: string;
  network: string;
  needs: (v: string) => string;
  protocol: (p: string) => string;
  published: (date: string) => string;
  hosts: (n: number) => string;
  versionsCount: (n: number) => string;
}

export function pkgLabels(locale: Locale): PkgLabels {
  return locale === "en"
    ? {
        source: "Source",
        commit: "Commit",
        contents: "Contents",
        compat: "Compatibility",
        version: "Version",
        network: "Network",
        needs: (v) => `Needs Ave ${v} or newer`,
        protocol: (p) => `host protocol ${p}`,
        published: (d) => `published ${d}`,
        hosts: (n) => `${n} allowed hosts`,
        versionsCount: (n) => (n === 1 ? "1 version" : `${n} versions`),
      }
    : {
        source: "출처",
        commit: "커밋",
        contents: "내용",
        compat: "호환",
        version: "버전",
        network: "네트워크",
        needs: (v) => `Ave ${v} 이상 필요`,
        protocol: (p) => `호스트 프로토콜 ${p}`,
        published: (d) => `${d} 게시`,
        hosts: (n) => `허용된 주소 ${n}곳`,
        versionsCount: (n) => `버전 ${n}개`,
      };
}
