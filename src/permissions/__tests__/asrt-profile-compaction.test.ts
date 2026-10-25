import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
/**
 * The macOS profile folds the `subpath` and `literal` filters of one rule that
 * share a parent directory into one regex per parent, because sandbox-exec
 * compiles every wrap's profile again and its compile time grows faster than
 * the number of path filters. The folding must not change a single decision:
 * these cases hold the folded regexes to what Seatbelt itself decides for the
 * separate filters, and the production worker profile to the same rules.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compactPathFilters,
  setPathFilterCompactionForTesting,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/macos-sandbox-utils.js";

import {
  ensureSandboxTempPrincipalDir,
  getDefaultSensitiveWriteDenyPaths,
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  resetAsrtSandbox,
  wrapWorkerCommand,
} from "../asrt-sandbox.js";
import { asrtCanInitialize, expandFoldedPathFilter, pathFilter, profileOfWrappedArgv, profileRules } from "./test-helpers.js";

const darwin = process.platform === "darwin";
/** Names that are regex syntax, case, spacing, non-ASCII and a newline. */
const NAMES = [
  "plain", "plainx", "a.b", "a+b", "a[1]", "a*", "a(b)|c", "sp ace", "ünï", "new\nline",
  "q?", "$x", "^y", "{z}", "back\\slash", "Mixed",
];
const deny = (operations: string, filters: Iterable<string>): string =>
  `(version 1)(allow default)(deny ${operations}\n${[...filters].map((filter) => `  ${filter}`).join("\n")})`;

/** One `sandbox-exec` per profile: one line per probe, `1` where the command succeeded. */
function decisions(profile: string, script: string, probes: readonly string[]): string[] {
  const run = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", script, "sh", ...probes], {
    encoding: "utf-8",
  });
  expect(run.status, run.stderr).toBe(0);
  return run.stdout.split("\n").slice(0, probes.length);
}

const pathFilterCount = (profile: string): number => (profile.match(/^ {2}\((subpath|literal) /gmu) ?? []).length;

function compileMs(profile: string): number {
  const started = process.hrtime.bigint();
  execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/true"]);
  return Number(process.hrtime.bigint() - started) / 1e6;
}

let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ave-fold-")));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("folded path filters", () => {
  it("fold siblings into one regex and leave lone and unfoldable filters as they were", () => {
    const folded = compactPathFilters(new Set([
      pathFilter("subpath", "/a/b/one"),
      pathFilter("subpath", "/a/b/two"),
      pathFilter("literal", "/a/b/one"),
      pathFilter("subpath", "/a/c/lone"),
      pathFilter("subpath", "/a/b/../x"),
      pathFilter("subpath", "/"),
      '(regex #"^/z(/.*)?$")',
      "(require-all (subpath \"/a\") (vnode-type DIRECTORY))",
    ]));
    expect([...folded].sort()).toEqual([
      pathFilter("literal", "/a/b/one"),
      pathFilter("subpath", "/a/c/lone"),
      pathFilter("subpath", "/a/b/../x"),
      pathFilter("subpath", "/"),
      '(regex #"^/z(/.*)?$")',
      "(require-all (subpath \"/a\") (vnode-type DIRECTORY))",
      `(regex ${JSON.stringify("^/a/b/(one|two)(/.*)?$")})`,
    ].sort());
  });

  it("split a parent's names across regexes that each fit an SBPL string", () => {
    const names = Array.from({ length: 120 }, (_, index) => `name-${String(index).padStart(3, "0")}-${"x".repeat(12)}`);
    const folded = compactPathFilters(new Set(names.map((name) => pathFilter("subpath", `/parent/${name}`))));
    expect(folded.length).toBeGreaterThan(1);
    for (const filter of folded) expect(Buffer.byteLength(filter)).toBeLessThanOrEqual(900 + "(regex )".length + 2);
    expect(folded.flatMap((filter) => expandFoldedPathFilter(filter)!).sort())
      .toEqual(names.map((name) => pathFilter("subpath", `/parent/${name}`)).sort());
  });

  it.runIf(darwin)("deny exactly the reads the separate subpath and literal filters deny", () => {
    const dirs = join(root, "dirs");
    const files = join(root, "files");
    const probes: string[] = [];
    const subpaths = new Set<string>();
    const literals = new Set<string>();
    NAMES.forEach((name, index) => {
      for (const dir of [join(dirs, name), join(dirs, `${name}x`), join(dirs, name, "deep")]) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "f"), "bytes");
        probes.push(join(dir, "f"));
      }
      probes.push(join(dirs, name.toUpperCase(), "f"));
      mkdirSync(files, { recursive: true });
      for (const file of [join(files, name), join(files, `${name}x`)]) {
        writeFileSync(file, "bytes");
        probes.push(file);
      }
      if (index % 4 !== 3) {
        subpaths.add(pathFilter("subpath", join(dirs, name)));
        literals.add(pathFilter("literal", join(files, name)));
      }
    });
    const separate = new Set([...subpaths, ...literals]);
    const folded = compactPathFilters(separate);
    expect(folded.filter((filter) => filter.startsWith("(regex ")).length).toBe(2);
    expect(folded.length).toBe(2);
    const read = 'for p do if /bin/cat -- "$p" >/dev/null 2>&1; then echo 1; else echo 0; fi; done';
    const unconfined = decisions("(version 1)(allow default)", read, probes);
    expect(unconfined.every((decision) => decision === "1"), "every probe reads unconfined").toBe(true);
    const expected = decisions(deny("file-read*", separate), read, probes);
    expect(expected.filter((decision) => decision === "0").length, "the separate filters deny some probes")
      .toBeGreaterThan(probes.length / 3);
    expect(decisions(deny("file-read*", folded), read, probes)).toEqual(expected);
  });

  it.runIf(darwin)("deny exactly the creates the separate literal filters deny", () => {
    const outcomes: string[][] = [];
    const separate = new Set<string>();
    for (const variant of ["separate", "folded"]) {
      const dir = join(root, `create-${variant}`);
      mkdirSync(dir);
      const probes = NAMES.flatMap((name) => [join(dir, name), join(dir, `${name}x`), join(dir, name.toUpperCase())]);
      const filters = new Set(NAMES.filter((_, index) => index % 4 !== 3).map((name) => pathFilter("literal", join(dir, name))));
      if (variant === "separate") for (const filter of filters) separate.add(filter);
      const profile = deny("file-write-create", variant === "separate" ? filters : compactPathFilters(filters));
      const create = 'for p do if /usr/bin/touch -- "$p" 2>/dev/null; then echo 1; /bin/rm -f -- "$p"; else echo 0; fi; done';
      outcomes.push(decisions(profile, create, probes));
    }
    expect(outcomes[0]!.filter((decision) => decision === "0").length).toBeGreaterThan(NAMES.length / 2);
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(separate.size).toBe(NAMES.filter((_, index) => index % 4 !== 3).length);
  });
});

describe("the production worker profile, folded", () => {
  let previousAveHome: string | undefined;
  beforeAll(() => {
    previousAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = join(root, ".ave");
  });
  afterAll(async () => {
    setPathFilterCompactionForTesting(true);
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (previousAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previousAveHome;
  });

  it.runIf(darwin)("keeps every rule and every path, with fewer path filters to compile", async () => {
    if (!(await asrtCanInitialize())) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
      return;
    }
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    const dataDir = join(root, "data");
    mkdirSync(dataDir);
    const { dir: tempDir } = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "folded" });
    const wrap = async (): Promise<string> => profileOfWrappedArgv((await wrapWorkerCommand("true", {
      commandId: TEST_COMMAND_ID,
      filesystem: {
        allowWrite: [tempDir, dataDir],
        allowRead: [dataDir],
        denyRead: [join(root, ".ave", "plugins")],
        denyWrite: getDefaultSensitiveWriteDenyPaths(),
        pinWriteRoots: true,
      },
    })).argv);
    setPathFilterCompactionForTesting(false);
    const separate = await wrap();
    setPathFilterCompactionForTesting(true);
    const folded = await wrap();
    const tag = /"CMD64_[^"]*"/gu;
    const separateRules = profileRules(separate.replace(tag, "TAG"));
    expect(separateRules.filter((rule) => rule.filters.length > 50).length, "the parse found the large rules")
      .toBeGreaterThan(2);
    expect(profileRules(folded.replace(tag, "TAG"))).toEqual(separateRules);
    expect(pathFilterCount(folded)).toBeLessThan(pathFilterCount(separate) / 2);
    // Both compile; the timing is reported, not asserted.
    const ms = { separate: compileMs(separate), folded: compileMs(folded) };
    console.log(`[profile-fold] path filters ${pathFilterCount(separate)} -> ${pathFilterCount(folded)}, `
      + `${separate.length} -> ${folded.length} bytes, compile ${ms.separate.toFixed(0)} -> ${ms.folded.toFixed(0)} ms`);
  });
});
