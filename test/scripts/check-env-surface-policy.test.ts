import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUCKETS,
  evaluate,
  scanEnvReads,
} from "../../scripts/check-env-surface-policy.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-env-surface-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, body: string): void {
  writeFileSync(join(dir, name), body, "utf-8");
}

describe("env-surface scan", () => {
  it("finds the read shapes the resolvers actually use", () => {
    write("a.ts", `
      const a = process.env.AVE_DOTTED;
      const b = process.env["AVE_INDEXED"];
      export function f(env: NodeJS.ProcessEnv) {
        return env.AVE_PARAM === "1" || env['AVE_PARAM_INDEXED'] === "1";
      }
    `);
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "b.tsx"), 'const c = process.env.AVE_NESTED;\n', "utf-8");

    expect([...scanEnvReads(dir).keys()].sort()).toEqual([
      "AVE_DOTTED",
      "AVE_INDEXED",
      "AVE_NESTED",
      "AVE_PARAM",
      "AVE_PARAM_INDEXED",
    ]);
  });

  it("ignores a name that is a constant rather than an environment read", () => {
    // The reason the scan is not a bare `AVE_[A-Z_]+` grep: these are ordinary
    // exported constants, and demanding they be classified as configuration
    // would be asking the author for nonsense.
    write("c.ts", `
      export const AVE_TOKEN_NAMES = ["a"];
      import { AVE_LOGO_PATH } from "./logo.js";
      const label = "AVE_NOT_AN_ENV_READ";
    `);

    expect(scanEnvReads(dir).size).toBe(0);
  });

  it("finds the names a table-driven resolver looks up through a key map", () => {
    // The shape that made the tailnet group invisible to the first version of
    // this gate: no variable name ever appears at the lookup site.
    write("table.ts", `
      const ENV_KEY = { enabled: "AVE_TABLE_ONE", port: "AVE_TABLE_TWO" };
      export function layer(env: NodeJS.ProcessEnv, key: "enabled" | "port") {
        return env[ENV_KEY[key]];
      }
    `);

    expect([...scanEnvReads(dir).keys()].sort()).toEqual([
      "AVE_TABLE_ONE",
      "AVE_TABLE_TWO",
    ]);
  });

  it("does not mistake a quoted prefix for a variable of that name", () => {
    // `AVE_DEMO_` names a family the packaged-env scrub matches by prefix.
    // Demanding a control for it would be demanding one for nothing.
    write("scrub.ts", `
      const PREFIXES = ["AVE_DEMO_"];
      export function scrub(env: NodeJS.ProcessEnv, name: string) {
        if (PREFIXES.some((p) => name.startsWith(p))) delete env[name];
      }
    `);

    expect(scanEnvReads(dir).size).toBe(0);
  });

  it("does not widen a test file, where a quoted name is a fixture it sets", () => {
    mkdirSync(join(dir, "__tests__"));
    writeFileSync(
      join(dir, "__tests__", "d.test.ts"),
      `
        const NAMES = { fixture: "AVE_FIXTURE" };
        const env: NodeJS.ProcessEnv = {};
        const v = env[NAMES.fixture];
      `,
      "utf-8",
    );

    expect(scanEnvReads(dir).size).toBe(0);
  });
});

describe("env-surface policy", () => {
  const buckets = (over: Record<string, readonly string[]> = {}) =>
    ([
      ["development", over["development"] ?? []],
      ["internal", over["internal"] ?? []],
      ["settings", over["settings"] ?? []],
      ["pending", over["pending"] ?? []],
    ] as ReadonlyArray<readonly [string, readonly string[]]>);

  it("fails on a variable the source reads and nobody classified", () => {
    const failures = evaluate(new Map([["AVE_NEW", "src/main/x.ts"]]), buckets(), [], 0);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("AVE_NEW");
    // The message has to say what to do, or the next author lists it as pending
    // because that is the cheapest square to tick.
    expect(failures[0]).toContain("build the control");
  });

  it("fails when the unfinished list grows past its ceiling", () => {
    const pending = ["AVE_A", "AVE_B"];
    const found = new Map([["AVE_A", "a.ts"], ["AVE_B", "b.ts"]]);

    expect(evaluate(found, buckets({ pending }), pending, 2)).toEqual([]);
    expect(evaluate(found, buckets({ pending }), pending, 1)).toEqual([
      expect.stringContaining("ceiling 1"),
    ]);
  });

  it("fails when one variable is claimed by two buckets", () => {
    const found = new Map([["AVE_X", "x.ts"]]);
    const failures = evaluate(
      found,
      buckets({ development: ["AVE_X"], settings: ["AVE_X"] }),
      [],
      0,
    );

    expect(failures).toEqual([expect.stringContaining('both "development" and "settings"')]);
  });

  it("fails on an entry nothing reads any more, so the lists cannot rot", () => {
    const failures = evaluate(new Map(), buckets({ pending: ["AVE_GONE"] }), ["AVE_GONE"], 5);

    expect(failures).toEqual([expect.stringContaining("nothing reads it any more")]);
  });

  it("passes the repository as it stands", () => {
    expect(evaluate(scanEnvReads(), BUCKETS)).toEqual([]);
  });
});
