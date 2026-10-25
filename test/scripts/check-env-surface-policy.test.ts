import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUCKETS,
  DEVELOPMENT,
  evaluate,
  scanEnvReads,
  scanRendererSettingsPaths,
} from "../../scripts/check-env-surface-policy.js";
import {
  ACTIVE_DEVELOPMENT_ENV_VARS,
  DEVELOPMENT_ENV_POLICY,
  DEVELOPMENT_ENV_TOMBSTONES,
  PACKAGED_DEVELOPMENT_ENV_VARS,
} from "../../src/shared/development-env-policy.js";
import { ENV_BACKED_SETTINGS } from "../../src/shared/env-backed-settings.js";

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

  it("finds literal reads through the packaged-gated development helper", () => {
    write("gated.ts", `
      const admission = readDevelopmentEnvVar("AVE_ADMISSION_OFFLINE");
      const revocation = readDevelopmentEnvVar('AVE_REVOCATION_OFFLINE');
    `);

    expect([...scanEnvReads(dir).keys()].sort()).toEqual([
      "AVE_ADMISSION_OFFLINE",
      "AVE_REVOCATION_OFFLINE",
    ]);
  });

  it("ignores a name that is a constant rather than an environment read", () => {
    // Bare constants are not environment accesses.
    write("c.ts", `
      export const AVE_TOKEN_NAMES = ["a"];
      import { AVE_LOGO_PATH } from "./logo.js";
      const label = "AVE_NOT_AN_ENV_READ";
    `);

    expect(scanEnvReads(dir).size).toBe(0);
  });

  it("does not self-satisfy from a policy string or comment", () => {
    write("policy.ts", `
      const POLICY = [{ name: "AVE_POLICY_ONLY", packaged: "scrub" }];
      // AVE_COMMENT_ONLY is documentation, not a read.
      const EXAMPLE = 'readDevelopmentEnvVar("AVE_HELPER_STRING_ONLY")';
      // readDevelopmentEnvVar("AVE_HELPER_COMMENT_ONLY") is documentation.
    `);

    expect(scanEnvReads(dir).size).toBe(0);
  });

  it("finds the names a table-driven resolver looks up through a key map", () => {
    // Resolve dynamic table lookups to their declared names.
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
    // A trailing underscore denotes a variable family, not one setting.
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

  it("finds both halves of a host-to-child protocol variable", () => {
    // Include host writes consumed by embedded child scripts.
    write("child.ts", `
      const TARGET_ENV = "AVE_INTERPOLATED_TARGET";
      const SCRIPT = [
        "$request = ConvertFrom-Json $env:AVE_PS_READ",
        "$braced = \${env:AVE_PS_BRACED}",
        "$x = [Environment]::GetEnvironmentVariable('AVE_DOTNET_READ', 'Process')",
        \`$t = [Environment]::GetEnvironmentVariable('\${TARGET_ENV}', 'Process')\`,
      ].join("; ");
      const SHELL = 'printf "%s" "$AVE_POSIX_READ"';
      execFileSync("child", [SCRIPT, SHELL], { env: { ...process.env, AVE_ENV_WRITE_ONLY: "1", "AVE_QUOTED_WRITE": "2" } });
    `);
    write("computed.ts", `
      spawn("child", [], { env: { ["AVE_COMPUTED_WRITE"]: "1", [ 'AVE_COMPUTED_SPACED' ] : "2" } });
    `);

    expect([...scanEnvReads(dir).keys()].sort()).toEqual([
      "AVE_COMPUTED_SPACED",
      "AVE_COMPUTED_WRITE",
      "AVE_DOTNET_READ",
      "AVE_ENV_WRITE_ONLY",
      "AVE_INTERPOLATED_TARGET",
      "AVE_POSIX_READ",
      "AVE_PS_BRACED",
      "AVE_PS_READ",
      "AVE_QUOTED_WRITE",
    ]);
  });

  it("does not take a constant's annotation, ternary or interpolation for a protocol variable", () => {
    write("constants.ts", `
      export const AVE_ANNOTATED: string = "x";
      let AVE_LET_ANNOTATED: number;
      const label = flag ? AVE_TERNARY_BRANCH : other;
      const svg = \`<path d="\${AVE_LOGO_PATH}" />\`;
      const extension = extensions[AVE_EXTENSION_NAMESPACE];
    `);

    expect(scanEnvReads(dir).size).toBe(0);
  });

  it("does not count a child-protocol fixture a test sets for its own child", () => {
    mkdirSync(join(dir, "__tests__"));
    writeFileSync(
      join(dir, "__tests__", "child.test.ts"),
      `
        const script = "$x = $env:AVE_TEST_CHILD_READ";
        spawn("pwsh", [script], { env: { AVE_TEST_CHILD_WRITE: "1" } });
      `,
      "utf-8",
    );

    expect(scanEnvReads(dir).size).toBe(0);
  });
});

describe("renderer settings-path scan", () => {
  it("finds both spellings a surface uses to name a path", () => {
    // Actionable settings notices need both a control and a table path.
    write("Tab.tsx", `
      const ROWS = [{ path: "system.localApiServer", label: "x" }];
      export function Tab() {
        return <EnvForcedNotice settingsPath="system.corpCaEnabled" testId="t" />;
      }
    `);

    const paths = scanRendererSettingsPaths(dir);
    expect(paths.has("system.localApiServer")).toBe(true);
    expect(paths.has("system.corpCaEnabled")).toBe(true);
  });

  it("does not count a path quoted in a test", () => {
    // A test mentioning a nonexistent control does not prove UI coverage.
    mkdirSync(join(dir, "__tests__"));
    writeFileSync(
      join(dir, "__tests__", "Tab.test.tsx"),
      'const forced = ["features.osToolSandbox"];\n',
      "utf-8",
    );

    expect(scanRendererSettingsPaths(dir).size).toBe(0);
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

  it("keeps no bucket entry for the access-rule query, whose inputs travel in request lines", () => {
    for (const name of ["AVE_EXECUTABLE_ACL_PATHS", "AVE_ACL_DESKTOP_PACKAGE", "AVE_ACL_CAP_SIDS"]) {
      expect(BUCKETS.some(([, names]) => names.includes(name))).toBe(false);
    }
  });

  it("derives the development bucket from the packaged scrub inventory", () => {
    expect(DEVELOPMENT).toEqual(
      ACTIVE_DEVELOPMENT_ENV_VARS.filter((name) => name.startsWith("AVE_")),
    );
    expect(DEVELOPMENT).not.toContain("AVE_ADMISSION_OFFLINE");
    expect(DEVELOPMENT).not.toContain("AVE_WHITELIST_OFFLINE");
    expect(DEVELOPMENT).not.toContain("AVE_REVOCATION_OFFLINE");
    expect(ACTIVE_DEVELOPMENT_ENV_VARS).toContain("VITE_DEBUG_STREAM");
    expect(DEVELOPMENT_ENV_TOMBSTONES).toContain("AVE_PLUGINS_DIR");
    expect(DEVELOPMENT).not.toContain("AVE_PLUGINS_DIR");
    expect(DEVELOPMENT_ENV_TOMBSTONES).toEqual(expect.arrayContaining([
      "AVE_ADMISSION_OFFLINE",
      "AVE_ALLOW_LINKED_PLUGIN_ENTRY",
      "AVE_ALLOW_TEST_MARKETPLACE_KEYS",
      "AVE_DEV_NO_SANDBOX",
      "AVE_PLUGINS_DIR",
      "AVE_REVOCATION_OFFLINE",
      "AVE_WHITELIST_OFFLINE",
      "AVE_E2E_WHITELIST_PUBLIC_KEY",
    ]));
    expect(
      DEVELOPMENT_ENV_POLICY
        .filter((entry) => entry.lifecycle === "active")
        .every((entry) => entry.packaged === "scrub"),
    ).toBe(true);
    const tombstoneSet = new Set<string>(DEVELOPMENT_ENV_TOMBSTONES);
    expect(ACTIVE_DEVELOPMENT_ENV_VARS.filter((name) => tombstoneSet.has(name))).toEqual([]);
    expect(PACKAGED_DEVELOPMENT_ENV_VARS).toHaveLength(
      ACTIVE_DEVELOPMENT_ENV_VARS.length + DEVELOPMENT_ENV_TOMBSTONES.length,
    );
    for (const preLaunch of ["AVE_HOME", "AVE_USER_DATA_DIR", "AVE_RESOURCES_DIR"]) {
      expect(PACKAGED_DEVELOPMENT_ENV_VARS).not.toContain(preLaunch);
    }
  });

  it("fails on a variable the source reads and nobody classified", () => {
    const failures = evaluate(new Map([["AVE_NEW", "src/main/x.ts"]]), buckets(), [], 0);

    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("AVE_NEW");
    // A new pending setting needs an actionable notice.
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

  it("fails on a registry entry no renderer surface names", () => {
    // A registry entry alone does not prove that a control exists.
    const entry = ENV_BACKED_SETTINGS[0]!;
    const failures = evaluate(new Map(), buckets(), [], 0, new Set());

    expect(failures.length).toBe(ENV_BACKED_SETTINGS.length);
    expect(failures[0]).toContain(entry.settingsPath);
    expect(failures[0]).toContain(entry.envVar);
    expect(failures[0]).toContain("Build the control");
  });

  it("passes the repository as it stands", () => {
    expect(evaluate(scanEnvReads(), BUCKETS)).toEqual([]);
  });
});
