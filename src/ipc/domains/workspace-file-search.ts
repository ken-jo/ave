// Search current workspace roots and recheck every result with the read guard.
import { collectFiles } from "../../tools/file-tools.js";
import { assertReadableFilePath } from "../../tools/file-read-core.js";

export const WORKSPACE_FILE_QUERY_MAX_CHARS = 200;
const MAX_MATCHES = 50;
const MAX_FILES_PER_ROOT = 20_000;
const LISTING_TTL_MS = 10_000;

export interface WorkspaceFileMatch {
  path: string;
  relativePath: string;
  root: string;
  bytes: number;
}

interface CachedListing {
  at: number;
  files: Array<{ path: string; relativePath: string; bytes: number }>;
  truncated: boolean;
}

const listingCache = new Map<string, CachedListing>();
// Share one cold-cache walk per root across concurrent keystrokes.
const listingsInFlight = new Map<string, Promise<CachedListing>>();

async function listRoot(root: string, now: number): Promise<CachedListing> {
  const cached = listingCache.get(root);
  if (cached && now - cached.at < LISTING_TTL_MS) return cached;
  const inFlight = listingsInFlight.get(root);
  if (inFlight) return inFlight;
  const walk = walkRoot(root, now).finally(() => listingsInFlight.delete(root));
  listingsInFlight.set(root, walk);
  return walk;
}

async function walkRoot(root: string, now: number): Promise<CachedListing> {
  const listed = await collectFiles(root, MAX_FILES_PER_ROOT);
  const entry: CachedListing = listed.ok
    ? {
        at: now,
        files: listed.value.files.map((f) => ({ path: f.path, relativePath: f.relativePath, bytes: f.size ?? 0 })),
        truncated: listed.value.truncated,
      }
    : { at: now, files: [], truncated: false };
  listingCache.set(root, entry);
  return entry;
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j += 1) {
    if (hay[j] === needle[i]) i += 1;
  }
  return i === needle.length;
}

/** Lower is better; null = no match. */
function rank(query: string, relativePath: string): number | null {
  const rel = relativePath.toLowerCase();
  if (query.length === 0) return rel.split("/").length;
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  if (base.startsWith(query)) return 0;
  if (base.includes(query)) return 1;
  if (rel.includes(query)) return 2;
  if (isSubsequence(query, rel)) return 3;
  return null;
}

export async function searchWorkspaceFiles(args: {
  query: string;
  roots: readonly string[];
  cwd: string;
  extraAllowed: readonly string[];
  now?: number;
}): Promise<{ matches: WorkspaceFileMatch[]; truncated: boolean }> {
  const query = args.query.trim().toLowerCase();
  const now = args.now ?? Date.now();
  const scored: Array<{ score: number; match: WorkspaceFileMatch }> = [];
  let truncated = false;
  for (const root of args.roots) {
    const listing = await listRoot(root, now);
    truncated ||= listing.truncated;
    for (const file of listing.files) {
      const score = rank(query, file.relativePath);
      if (score === null) continue;
      scored.push({ score, match: { path: file.path, relativePath: file.relativePath, root, bytes: file.bytes } });
    }
  }
  scored.sort((a, b) =>
    a.score - b.score
    || a.match.relativePath.length - b.match.relativePath.length
    || a.match.relativePath.localeCompare(b.match.relativePath));
  const matches: WorkspaceFileMatch[] = [];
  const seen = new Set<string>();
  for (const { match } of scored) {
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    if (seen.has(match.path)) continue;
    seen.add(match.path);
    // The read guard decides, not the walk: same answer read_file would give.
    const verdict = assertReadableFilePath(match.path, args.cwd, args.extraAllowed);
    if (!verdict.ok) continue;
    matches.push(match);
  }
  return { matches, truncated };
}

export function clearWorkspaceFileSearchCache(): void {
  listingCache.clear();
  listingsInFlight.clear();
}
