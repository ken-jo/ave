/** The scratch root a caller names with AVE_TEST_TMP_ROOT, validated once by global setup. Workers read the validated root
 * through `inject("explicitTestTmpRoot")`, never from the environment. */
import { createRequire } from "node:module";

// Path and filesystem functions only, loaded past suite mocks like the isolation guard that imports this.
const nodeRequire = createRequire(import.meta.url);
const hostPath = nodeRequire("node:path") as typeof import("node:path");
const { lstatSync, readlinkSync, realpathSync } = nodeRequire("node:fs") as typeof import("node:fs");

type PathApi = Pick<typeof import("node:path"), "isAbsolute" | "join" | "resolve" | "sep">;

/**
 * Undefined when unset, so the default roots apply. A set value replaces every default test root, so it must be absolute
 * (a relative one would resolve against each worker's cwd), must not contain the account home or its Ave home, and inside
 * the Ave home may only be its test-tmp: anything else there would sanction the real data the guard protects. Links,
 * short names and trailing dots are resolved first (`canonical`), so another spelling of a protected path is refused too.
 */
export function configuredTestTmpRoot(
  accountHome: string,
  value: string | undefined = process.env.AVE_TEST_TMP_ROOT,
  caseInsensitive: boolean = process.platform !== "linux",
  { isAbsolute, join, resolve, sep }: PathApi = hostPath,
  canonical: (path: string) => string = canonicalPath,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) throw new Error(`AVE_TEST_TMP_ROOT must be absolute, got ${JSON.stringify(value)}`);
  const root = resolve(value);
  const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const trim = (p: string) => fold(p).replace(/[\\/]+$/, "");
  const inside = (candidate: string, dir: string) => trim(candidate) === trim(dir) || trim(candidate).startsWith(trim(dir) + sep);
  const roots = [...new Set([root, canonical(root)])];
  const homes = [...new Set([resolve(accountHome), canonical(resolve(accountHome))])];
  for (const home of homes) {
    const ave = join(home, ".ave");
    for (const candidate of roots) {
      for (const real of [home, ave]) {
        if (inside(real, candidate)) {
          throw new Error(`AVE_TEST_TMP_ROOT must not contain ${real}, got ${JSON.stringify(value)}`);
        }
      }
      if (inside(candidate, ave) && !inside(candidate, join(ave, "test-tmp"))) {
        throw new Error(`AVE_TEST_TMP_ROOT may sit inside ${ave} only under its test-tmp, got ${JSON.stringify(value)}`);
      }
    }
  }
  return root;
}

/** Resolve existing ancestors and dangling links so missing paths cannot hide a real-home target. */
export function canonicalPath(path: string): string {
  const { basename, dirname, join, resolve } = hostPath;
  const missing: string[] = [];
  let current = resolve(path);
  for (let hops = 0; ; ) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        if (/^\\\\(?:\?\\UNC\\|[^?.\\])/i.test(current)) return resolve(path);
        throw error;
      }
    }
    let link: string | undefined;
    try {
      if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") {
        throw error;
      }
    }
    if (link !== undefined) {
      // Linux allows 40 links in one resolution; past that the path is a loop.
      if (++hops > 40) throw new Error(`too many links resolving ${path}`);
      current = resolve(dirname(current), link);
      continue;
    }
    const parent = dirname(current);
    if (parent === current) return join(current, ...missing);
    missing.unshift(basename(current));
    current = parent;
  }
}
