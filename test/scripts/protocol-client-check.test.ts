/**
 * The compile half of `check:plugin-host-protocol-client`, demonstrated.
 *
 * The check compiles two separate programs. Each case below runs one of them
 * against a temporary copy whose compiler options are read from the committed
 * project file — only the file list is re-pointed — so a case fails exactly
 * when the committed program stops rejecting what it is there to reject:
 *
 *  - standalone (`scripts/tsconfig.plugin-host-protocol-client.json`): the
 *    generated client with a type error fails, and with an added `import` it
 *    fails too — whether or not the import resolves — because the file must
 *    stand alone;
 *  - host equality (`scripts/tsconfig.plugin-host-protocol-client-assertions.json`):
 *    the assertions module with one error code dropped from the host's side of
 *    the union fails, while the standalone program still passes — the two
 *    programs gate different things.
 *
 * The command line is then held to report what those programs find: in a
 * copy of everything it reads, a client that matches its schema but fails the
 * standalone compile, and an assertions module that disagrees with the host,
 * each make `--check` exit 1 with one failure line naming the program.
 *
 * The standalone copy lives in the OS temp directory, which proves it needs
 * nothing around it. The host-equality copy lives under the repository's
 * ignored `.cache/`, inside the root project's `rootDir`, because it compiles
 * the host's own modules under the repository's options.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL_CLIENT_LABEL,
  HOST_PROTOCOL_CLIENT_PROGRAMS,
  compileHostProtocolClientProgram,
} from "../../scripts/lib/plugin-host-protocol-client.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLIENT = join(REPO_ROOT, "schemas/plugin-host-protocol/2/protocol-client.ts");
const ASSERTIONS = join(REPO_ROOT, "scripts/lib/plugin-host-protocol-client-assertions.ts");
const HOST_ERROR_SIDE = "(typeof HOST_API_WIRE_ERROR_CODES)[number]";
/**
 * The plain Node the harness names: the suite runs under Electron, whose
 * `process.execPath` prints startup diagnostics a compile's output would carry.
 */
const NODE = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectOptions(project: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, project), "utf-8")) as Record<string, unknown>;
}

/** `to` as a relative module specifier from `fromDir`, `/`-separated. */
function specifier(fromDir: string, to: string): string {
  const path = relative(fromDir, to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

/**
 * The standalone program over a copy of the client, with `edit` applied to its
 * text and `beside` written next to it.
 */
function standaloneCopy(edit: (client: string) => string, beside: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "protocol-client-standalone-"));
  created.push(dir);
  writeFileSync(join(dir, "protocol-client.ts"), edit(readFileSync(CLIENT, "utf-8")));
  for (const [name, text] of Object.entries(beside)) writeFileSync(join(dir, name), text);
  const options = projectOptions(HOST_PROTOCOL_CLIENT_PROGRAMS.standalone);
  expect(options.files).toEqual(["../schemas/plugin-host-protocol/2/protocol-client.ts"]);
  const project = join(dir, "tsconfig.json");
  writeFileSync(project, JSON.stringify({ ...options, files: ["protocol-client.ts"] }));
  return project;
}

/** The host-equality program over a copy of the assertions module, with `edit` applied to its text. */
function hostEqualityCopy(edit: (assertions: string) => string): string {
  const cache = join(REPO_ROOT, ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "protocol-client-assertions-"));
  created.push(dir);
  // The copy keeps every import pointing at the file the original imports.
  const source = readFileSync(ASSERTIONS, "utf-8").replace(
    /from "(\.[^"]+)"/gu,
    (_match, target: string) => `from "${specifier(dir, resolve(dirname(ASSERTIONS), target))}"`,
  );
  writeFileSync(join(dir, "assertions.ts"), edit(source));
  const options = projectOptions(HOST_PROTOCOL_CLIENT_PROGRAMS.hostEquality);
  expect(options.extends).toBe("../tsconfig.json");
  expect(options.files).toEqual(["lib/plugin-host-protocol-client-assertions.ts"]);
  const project = join(dir, "tsconfig.json");
  writeFileSync(
    project,
    JSON.stringify({
      ...options,
      extends: specifier(dir, join(REPO_ROOT, "tsconfig.json")),
      files: ["assertions.ts"],
    }),
  );
  return project;
}

describe("the committed pair", () => {
  it("passes both programs, as committed and as an unedited copy", () => {
    for (const [project, alone] of [
      [HOST_PROTOCOL_CLIENT_PROGRAMS.standalone, true],
      [HOST_PROTOCOL_CLIENT_PROGRAMS.hostEquality, false],
      [standaloneCopy((client) => client), true],
      [hostEqualityCopy((assertions) => assertions), false],
    ] as const) {
      const { ok, output } = compileHostProtocolClientProgram(project, { alone, node: NODE });
      expect(output, project).toBe("");
      expect(ok, project).toBe(true);
    }
  }, 120_000);
});

describe("the standalone program", () => {
  it("fails a client with one injected type error", () => {
    const { ok, output } = compileHostProtocolClientProgram(
      standaloneCopy((client) => `${client}\nexport const injected: number = "not a number";\n`),
      { alone: true, node: NODE },
    );
    expect(ok).toBe(false);
    expect(output).toMatch(/protocol-client\.ts\(\d+,\d+\): error TS2322:/u);
  }, 60_000);

  it("fails a client that imports a module the program cannot see", () => {
    // No ambient type and no Node: a built-in does not even resolve.
    const { ok, output } = compileHostProtocolClientProgram(
      standaloneCopy((client) => `import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n${client}`),
      { alone: true, node: NODE },
    );
    expect(ok).toBe(false);
    expect(output).toMatch(/protocol-client\.ts\(1,\d+\): error TS\d+: Cannot find (?:module|name) 'node:fs'/u);
  }, 60_000);

  it("fails a client that imports a module that compiles, because the file must stand alone", () => {
    // The import resolves and type-checks, so only the program's file list
    // shows the client is no longer alone.
    const { ok, output } = compileHostProtocolClientProgram(
      standaloneCopy(
        (client) => `import { helper } from "./helper.js";\nexport const usesHelper = helper;\n${client}`,
        { "helper.ts": "export const helper = 1;\n" },
      ),
      { alone: true, node: NODE },
    );
    expect(ok).toBe(false);
    expect(output).toMatch(/helper\.ts: loaded beside the client, which must import nothing$/u);
    expect(output).not.toMatch(/error TS/u);
  }, 60_000);
});

describe("the host-equality program", () => {
  it("fails when the host's side of the error-code union loses a member, while the standalone program passes", () => {
    const equality = compileHostProtocolClientProgram(
      hostEqualityCopy((assertions) => {
        expect(assertions).toContain(HOST_ERROR_SIDE);
        return assertions.replace(HOST_ERROR_SIDE, `Exclude<${HOST_ERROR_SIDE}, "host-internal">`);
      }),
      { alone: false, node: NODE },
    );
    expect(equality.ok).toBe(false);
    expect(equality.output).toMatch(/assertions\.ts\(\d+,\d+\): error TS2344:/u);

    const standalone = compileHostProtocolClientProgram(HOST_PROTOCOL_CLIENT_PROGRAMS.standalone, { alone: true, node: NODE });
    expect(standalone).toEqual({ ok: true, output: "" });
  }, 120_000);
});

/** What the command line reads, by repository-relative path. */
const CLI_FILES = [
  "scripts/generate-plugin-host-protocol-client.ts",
  "scripts/lib/plugin-host-protocol-client.ts",
  "scripts/lib/plugin-host-protocol-client-assertions.ts",
  HOST_PROTOCOL_CLIENT_PROGRAMS.standalone,
  HOST_PROTOCOL_CLIENT_PROGRAMS.hostEquality,
  "schemas/plugin-host-protocol/2/protocol.schema.json",
  "schemas/plugin-host-protocol/2/protocol-client.ts",
];

/**
 * A checkout holding a copy of everything the command line reads, under the
 * repository's ignored `.cache/`, so a case can break one file and run the
 * real `--check` against it without touching the tree. An import of a copied
 * file stays as written; an import of anything else — the host's own `src/` —
 * is re-pointed at the real file, and `tsconfig.json` extends the
 * repository's, so the host-equality program compiles the real host under the
 * repository's options exactly as it does in place.
 */
function cliCheckout(): string {
  const cache = join(REPO_ROOT, ".cache");
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(join(cache, "protocol-client-cli-"));
  created.push(root);
  const copied = new Set(CLI_FILES.map((file) => join(REPO_ROOT, file)));
  for (const file of CLI_FILES) {
    const from = join(REPO_ROOT, file);
    const to = join(root, file);
    mkdirSync(dirname(to), { recursive: true });
    let text = readFileSync(from, "utf-8");
    if (file.endsWith(".ts")) {
      text = text.replace(/from "(\.[^"]+)"/gu, (match, target: string) => {
        const real = resolve(dirname(from), target);
        return copied.has(real.replace(/\.js$/u, ".ts")) ? match : `from "${specifier(dirname(to), real)}"`;
      });
    }
    writeFileSync(to, text);
  }
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ extends: specifier(root, join(REPO_ROOT, "tsconfig.json")) }),
  );
  return root;
}

describe("the command line", () => {
  const runCli = (root: string, args: readonly string[]) =>
    spawnSync(NODE, ["--import", "tsx", join(root, "scripts/generate-plugin-host-protocol-client.ts"), ...args], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      timeout: 120_000,
    });
  const passed =
    `${HOST_PROTOCOL_CLIENT_LABEL} schemas/plugin-host-protocol/2/protocol-client.ts matches its schema `
    + "and compiles standalone and against the host\n";

  it("checks the committed client, compiles both programs, and says so in one line", () => {
    const result = runCli(REPO_ROOT, ["--check"]);
    expect(result.stdout).toBe(passed);
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);

  it("passes the same check in an unedited copy of what it reads", () => {
    // The control for the two failures below: the copy alone changes nothing.
    const result = runCli(cliCheckout(), ["--check"]);
    expect(result.stdout).toBe(passed);
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);

  it("fails, in one line, a client that matches its schema but does not compile standalone", () => {
    const root = cliCheckout();
    // A named type the schema spells as raw TypeScript naming nothing that
    // exists: the generator projects it faithfully, so the bytes match and
    // only the standalone compile can refuse it.
    const schemaPath = join(root, "schemas/plugin-host-protocol/2/protocol.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as { $defs: { types: Record<string, unknown> } };
    schema.$defs.types.InjectedTypeError = { tsType: "NoSuchTypeAnywhere" };
    writeFileSync(schemaPath, JSON.stringify(schema));
    const written = runCli(root, []);
    expect(written.status, written.stderr).toBe(0);
    expect(readFileSync(join(root, "schemas/plugin-host-protocol/2/protocol-client.ts"), "utf-8"))
      .toContain("export type InjectedTypeError = NoSuchTypeAnywhere;");

    const result = runCli(root, ["--check"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      new RegExp(
        `^\\[plugin-host-protocol-client\\] tsc -p ${HOST_PROTOCOL_CLIENT_PROGRAMS.standalone.replaceAll(".", "\\.")} `
          + "failed: .*protocol-client\\.ts\\(\\d+,\\d+\\): error TS2304: Cannot find name 'NoSuchTypeAnywhere'.*\\n$",
        "u",
      ),
    );
    expect(result.stderr.split("\n")).toHaveLength(2);
    expect(result.status).toBe(1);
  }, 120_000);

  it("fails, in one line, when the client and the host disagree by an error code", () => {
    const root = cliCheckout();
    const assertionsPath = join(root, "scripts/lib/plugin-host-protocol-client-assertions.ts");
    const assertions = readFileSync(assertionsPath, "utf-8");
    expect(assertions).toContain(HOST_ERROR_SIDE);
    writeFileSync(assertionsPath, assertions.replace(HOST_ERROR_SIDE, `Exclude<${HOST_ERROR_SIDE}, "host-internal">`));

    const result = runCli(root, ["--check"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(
      new RegExp(
        `^\\[plugin-host-protocol-client\\] tsc -p ${HOST_PROTOCOL_CLIENT_PROGRAMS.hostEquality.replaceAll(".", "\\.")} `
          + "failed: .*plugin-host-protocol-client-assertions\\.ts\\(\\d+,\\d+\\): error TS2344:.*\\n$",
        "u",
      ),
    );
    expect(result.stderr.split("\n")).toHaveLength(2);
    expect(result.status).toBe(1);
  }, 120_000);

  it("refuses an argument it does not know, in one line and with a failing status", () => {
    const result = runCli(REPO_ROOT, ["--chek"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `${HOST_PROTOCOL_CLIENT_LABEL} unexpected arguments '--chek'; the only option is --check\n`,
    );
    expect(result.status).toBe(1);
  }, 120_000);
});
