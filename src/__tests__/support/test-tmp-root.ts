/** The scratch root a caller names with AVE_TEST_TMP_ROOT, shared by global setup and the isolation guard. */
import { createRequire } from "node:module";

// Path functions only, loaded past suite mocks like the isolation guard that imports this.
const nodeRequire = createRequire(import.meta.url);
const hostPath = nodeRequire("node:path") as typeof import("node:path");

type PathApi = Pick<typeof import("node:path"), "isAbsolute" | "join" | "resolve" | "sep">;

/**
 * Undefined when unset, so the default roots apply. A set value replaces every default test root, so it must be absolute
 * (a relative one would resolve against each worker's cwd) and must not contain the account home or its Ave home, which
 * would sanction the real data the guard protects.
 */
export function configuredTestTmpRoot(
  accountHome: string,
  value: string | undefined = process.env.AVE_TEST_TMP_ROOT,
  caseInsensitive: boolean = process.platform !== "linux",
  { isAbsolute, join, resolve, sep }: PathApi = hostPath,
): string | undefined {
  if (value === undefined) return undefined;
  if (!isAbsolute(value)) throw new Error(`AVE_TEST_TMP_ROOT must be absolute, got ${JSON.stringify(value)}`);
  const root = resolve(value);
  const fold = (p: string) => (caseInsensitive ? p.toLowerCase() : p);
  const prefix = fold(root).replace(/[\\/]+$/, "") + sep;
  for (const real of [resolve(accountHome), resolve(join(accountHome, ".ave"))]) {
    if (fold(real) === fold(root) || fold(real).startsWith(prefix)) {
      throw new Error(`AVE_TEST_TMP_ROOT must not contain ${real}, got ${JSON.stringify(value)}`);
    }
  }
  return root;
}
