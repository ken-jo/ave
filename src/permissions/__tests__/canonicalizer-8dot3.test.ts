import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { verifyLocalFilesystemChain, resolvePhysicalFilesystemPath } from "../../shared/shell-filesystem-path.js";
import { canonicalizePathForMatch, createPathCanonicalizer, createSensitivePathMatcher } from "../sensitive-paths.js";

// Dot-leading names are not 8.3-compliant, so a volume with short-name generation on gives them SSH~1 / AVE~1 aliases.
function shortNameOf(parent: string, longName: string): string | undefined {
  try {
    const listing = execFileSync("cmd.exe", ["/d", "/c", "dir", "/x", "/a:d", parent], { encoding: "utf8", windowsHide: true });
    const line = listing.split(/\r?\n/).find((l) => l.trimEnd().endsWith(` ${longName}`) && l.includes("~"));
    return line === undefined ? undefined : /(\S+~\d+)\s+\S+\s*$/.exec(line)?.[1];
  } catch { return undefined; }
}

const root = process.platform === "win32" ? realpathSync.native(mkdtempSync(join(tmpdir(), "ave-8dot3-"))) : "";
let sshShort: string | undefined;
let aveShort: string | undefined;
if (process.platform === "win32") {
  mkdirSync(join(root, ".ssh"));
  mkdirSync(join(root, ".ave"));
  writeFileSync(join(root, ".ssh", "id_ed25519"), "secret");
  sshShort = shortNameOf(root, ".ssh");
  aveShort = shortNameOf(root, ".ave");
}
const has8dot3 = process.platform === "win32" && sshShort !== undefined && aveShort !== undefined;

afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!has8dot3)("createPathCanonicalizer expands 8.3 short names (win32)", () => {
  const lower = (p: string) => p.toLowerCase();

  it("maps the 8.3 spelling of an existing leaf to the long spelling and the .ssh floor", () => {
    const shortForm = join(root, sshShort!, "id_ed25519");
    const longForm = join(root, ".ssh", "id_ed25519");
    const canonicalize = createPathCanonicalizer();
    expect(lower(canonicalize(shortForm))).toBe(lower(canonicalize(longForm)));
    expect(canonicalize(shortForm)).not.toContain("~");
    const matcher = createSensitivePathMatcher("read", undefined, createPathCanonicalizer());
    expect(matcher(longForm)).not.toBeNull();
    expect(matcher(shortForm)).not.toBeNull();
  });

  it("matches the free canonicalizer for existing components, missing leaves and relocated AVE_HOME spellings", () => {
    const inputs = [
      join(root, sshShort!, "id_ed25519"),
      join(root, sshShort!, "missing-key"),
      join(root, sshShort!, "missing-dir", "missing-key"),
      join(root, aveShort!),
      join(root, aveShort!, "missing-store", "token"),
      join(root, ".ave", "missing-store", "token"),
    ];
    for (const input of inputs) {
      expect(createPathCanonicalizer()(input)).toBe(canonicalizePathForMatch(input));
      // A shared canonicalizer sees the same answer regardless of which spelling seeded its cache first.
      const shared = createPathCanonicalizer();
      shared(input);
      expect(shared(input)).toBe(canonicalizePathForMatch(input));
    }
  });

  it("reports expanded physical spellings to chain facts only when facts are supplied", () => {
    const seen: string[] = [];
    verifyLocalFilesystemChain(join(root, sshShort!, "id_ed25519"), "win32", 64, {
      knownPath: () => undefined,
      onLocalPath: (_lexical, canonical) => { seen.push(canonical); },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((p) => p.includes("~"))).toBe(false);
    expect(seen.map(lower)).toContain(lower(join(root, ".ssh", "id_ed25519")));
    // Without facts the walk has no observable output and the physical resolver is unchanged by it.
    expect(() => verifyLocalFilesystemChain(join(root, sshShort!, "id_ed25519"))).not.toThrow();
    const resolved = resolvePhysicalFilesystemPath(join(root, sshShort!, "id_ed25519"), root, Number.POSITIVE_INFINITY);
    expect(lower(resolved)).toBe(lower(join(root, ".ssh", "id_ed25519")));
  });
});
