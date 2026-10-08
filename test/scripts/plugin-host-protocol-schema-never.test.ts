/**
 * The generator rule that keeps an exclusive union exclusive on the wire
 * (docs/design/plugin-hostapi-protocol.md §9.7 P3, decision 33).
 *
 * `ts-json-schema-generator` drops a property declared `never`, so the two
 * branches of `{ a: string; b?: never } | { b: string; a?: never }` would each
 * just omit the other key and, with `additionalProperties: true`, accept an
 * object carrying both. The rule writes `false` for every such property, read
 * off the source; a `never` property on an interface that is not emitted is an
 * error rather than a silent skip.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as AjvModule from "ajv";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  SchemaGenerator,
  createFormatter,
  createParser,
  createProgram,
  ts,
  type CompletedConfig,
} from "ts-json-schema-generator";
import { TABLE_DECLARATIONS, excludeNeverProperties } from "../../scripts/lib/plugin-host-protocol-schema.js";

const Ajv = (AjvModule as unknown as { default?: unknown }).default ?? AjvModule;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Project `type` from `source` the way the generator does, and the declarations it reads the rule from. */
function project(source: string, type: string): {
  root: Record<string, unknown>;
  definitions: Record<string, unknown>;
  named: Map<string, ts.Node>;
} {
  const root = mkdtempSync(join(tmpdir(), "ave-schema-never-"));
  roots.push(root);
  const path = join(root, "types.ts").replaceAll("\\", "/");
  writeFileSync(path, source, "utf-8");
  const config: CompletedConfig = {
    ...DEFAULT_CONFIG,
    path,
    type,
    skipTypeCheck: true,
    expose: "export",
    topRef: false,
    additionalProperties: true,
  };
  const program = createProgram(config);
  const { $schema: _draft, definitions = {}, ...rootSchema } = new SchemaGenerator(
    program,
    createParser(program, config),
    createFormatter(config),
    config,
  ).createSchema(type) as { $schema?: string; definitions?: Record<string, unknown> };
  const named = new Map<string, ts.Node>();
  for (const statement of program.getSourceFile(path)!.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      named.set(statement.name.text, statement);
    }
  }
  return { root: rootSchema, definitions, named };
}

const EXCLUSIVE = `
export interface Fields { id: string }
export interface WithEntry extends Fields { entry: string; process?: never }
export interface WithProcess extends Fields { process: { command: string }; entry?: never }
export type Manifest = WithEntry | WithProcess;
`;

describe("the never-to-false rule", () => {
  it("writes false for each never member, so the union rejects both keys and neither", () => {
    const { root, definitions, named } = project(EXCLUSIVE, "Manifest");
    // What the generator emits on its own: the excluded key is simply absent.
    expect((definitions.WithEntry as { properties: Record<string, unknown> }).properties).not.toHaveProperty("process");

    excludeNeverProperties(named, definitions);

    expect((definitions.WithEntry as { properties: Record<string, unknown> }).properties.process).toBe(false);
    expect((definitions.WithProcess as { properties: Record<string, unknown> }).properties.entry).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const validate = new (Ajv as any)({ strict: false }).compile({ ...root, definitions }) as (value: unknown) => boolean;
    expect(validate({ id: "x", entry: "dist/index.js" })).toBe(true);
    expect(validate({ id: "x", process: { command: "./bin/plugin" } })).toBe(true);
    expect(validate({ id: "x", entry: "dist/index.js", process: { command: "./bin/plugin" } })).toBe(false);
    expect(validate({ id: "x" })).toBe(false);
  });

  it("refuses a never member on an interface that is not exported, so not emitted", () => {
    const { definitions, named } = project(
      `${EXCLUSIVE}\ninterface Hidden { visible: string; secret?: never }\nexport interface Holder { hidden: Hidden }\n`,
      "Manifest",
    );
    expect(() => excludeNeverProperties(named, definitions)).toThrow(
      /'Hidden' declares 'secret' as never but is not emitted \(it is not exported\)/,
    );
  });

  it("refuses a never member on an exported interface outside the table list that nothing reaches", () => {
    const { definitions, named } = project(
      `${EXCLUSIVE}\nexport interface Stray { kept: string; dropped?: never }\n`,
      "Manifest",
    );
    expect(definitions).not.toHaveProperty("Stray");
    expect(() => excludeNeverProperties(named, definitions)).toThrow(
      /'Stray' declares 'dropped' as never but is not emitted \(nothing on the wire reaches it\)/,
    );
  });

  it("exempts exactly the declarations the generator reads as data tables", () => {
    expect(TABLE_DECLARATIONS).toEqual(["HostApiEventPayloads"]);
    // A table, where never is a value ("pushes nothing"), is read and not emitted.
    const { definitions, named } = project(
      `${EXCLUSIVE}\nexport interface HostApiEventPayloads { resolveApiKey: never; "config.onChange": string }\n`,
      "Manifest",
    );
    expect(definitions).not.toHaveProperty("HostApiEventPayloads");
    expect(() => excludeNeverProperties(named, definitions)).not.toThrow();
  });
});
