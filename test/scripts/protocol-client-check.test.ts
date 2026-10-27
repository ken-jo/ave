// Standalone compilation forbids imports; host-equality compilation checks shared unions.
// Keep standalone copies isolated and host-equality copies inside the repository rootDir.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL_CLIENT_LABEL,
  HOST_PROTOCOL_CLIENT_PROGRAMS,
  compileHostProtocolClientProgram,
} from "../../scripts/lib/plugin-host-protocol-client.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLIENT = join(REPO_ROOT, "schemas/plugin-host-protocol/4/protocol-client.ts");
const ASSERTIONS = join(REPO_ROOT, "scripts/lib/plugin-host-protocol-client-assertions.ts");
const HOST_ERROR_SIDE = "(typeof HOST_API_WIRE_ERROR_CODES)[number]";
// Use a plain interpreter so runtime startup diagnostics cannot contaminate compiler output.
const NODE = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
let committedStandalone: ReturnType<typeof compileHostProtocolClientProgram>;

beforeAll(() => {
  committedStandalone = compileHostProtocolClientProgram(HOST_PROTOCOL_CLIENT_PROGRAMS.standalone, { alone: true, node: NODE });
});

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function projectOptions(project: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPO_ROOT, project), "utf-8")) as Record<string, unknown>;
}

function specifier(fromDir: string, to: string): string {
  const path = relative(fromDir, to).replaceAll("\\", "/");
  return path.startsWith(".") ? path : `./${path}`;
}

function standaloneCopy(edit: (client: string) => string, beside: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "protocol-client-standalone-"));
  created.push(dir);
  writeFileSync(join(dir, "protocol-client.ts"), edit(readFileSync(CLIENT, "utf-8")));
  for (const [name, text] of Object.entries(beside)) writeFileSync(join(dir, name), text);
  const options = projectOptions(HOST_PROTOCOL_CLIENT_PROGRAMS.standalone);
  expect(options.files).toEqual(["../schemas/plugin-host-protocol/4/protocol-client.ts"]);
  const project = join(dir, "tsconfig.json");
  writeFileSync(project, JSON.stringify({ ...options, files: ["protocol-client.ts"] }));
  return project;
}

function hostEqualityCopy(edit: (assertions: string) => string): string {
  const cache = join(REPO_ROOT, ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "protocol-client-assertions-"));
  created.push(dir);
  // Preserve every copied import target.
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
      const { ok, output } = project === HOST_PROTOCOL_CLIENT_PROGRAMS.standalone
        ? committedStandalone
        : compileHostProtocolClientProgram(project, { alone, node: NODE });
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
    // Built-in imports must fail without ambient runtime types.
    const { ok, output } = compileHostProtocolClientProgram(
      standaloneCopy((client) => `import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n${client}`),
      { alone: true, node: NODE },
    );
    expect(ok).toBe(false);
    expect(output).toMatch(/protocol-client\.ts\(1,\d+\): error TS\d+: Cannot find (?:module|name) 'node:fs'/u);
  }, 60_000);

  it("fails a client that imports a module that compiles, because the file must stand alone", () => {
    // A resolving import still violates the standalone program file list.
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

    const standalone = committedStandalone;
    expect(standalone).toEqual({ ok: true, output: "" });
  }, 120_000);
});

const CLI_FILES = [
  "scripts/generate-plugin-host-protocol-client.ts",
  "scripts/lib/plugin-host-protocol-client.ts",
  "scripts/lib/plugin-host-protocol-client-assertions.ts",
  HOST_PROTOCOL_CLIENT_PROGRAMS.standalone,
  HOST_PROTOCOL_CLIENT_PROGRAMS.hostEquality,
  "schemas/plugin-host-protocol/4/protocol.schema.json",
  "schemas/plugin-host-protocol/4/protocol-client.ts",
];

// Copy command inputs under .cache, preserving real host imports and compiler options.
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
    `${HOST_PROTOCOL_CLIENT_LABEL} schemas/plugin-host-protocol/4/protocol-client.ts matches its schema `
    + "and compiles standalone and against the host\n";

  it("checks the committed client, compiles both programs, and says so in one line", () => {
    const result = runCli(REPO_ROOT, ["--check"]);
    expect(result.stdout).toBe(passed);
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);

  it("passes the same check in an unedited copy of what it reads", () => {
    const result = runCli(cliCheckout(), ["--check"]);
    expect(result.stdout).toBe(passed);
    expect(result.status, result.stderr).toBe(0);
  }, 120_000);

  it("fails, in one line, a client that matches its schema but does not compile standalone", () => {
    const root = cliCheckout();
    // Schema-identical output with an unresolved type must fail standalone compilation.
    const schemaPath = join(root, "schemas/plugin-host-protocol/4/protocol.schema.json");
    const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as { $defs: { types: Record<string, unknown> } };
    schema.$defs.types.InjectedTypeError = { tsType: "NoSuchTypeAnywhere" };
    writeFileSync(schemaPath, JSON.stringify(schema));
    const written = runCli(root, []);
    expect(written.status, written.stderr).toBe(0);
    expect(readFileSync(join(root, "schemas/plugin-host-protocol/4/protocol-client.ts"), "utf-8"))
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
