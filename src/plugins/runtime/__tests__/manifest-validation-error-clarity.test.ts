/** Validation errors must identify the offending field and give reinstall guidance only for stale-schema failures. */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginJson } from "../manifest-validation.js";
import {
  agentPluginsDocument,
  permissiveManifestValidatorFactory,
} from "../../__tests__/test-helpers.js";

describe("manifest-validation enriched error messages (#737)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manifest-error-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const makeValidator = permissiveManifestValidatorFactory({
    strict: true,
    namespaceProperties: {
      entry: { type: "string" },
      tools: { type: "array", items: { type: "string" } },
    },
    namespaceRequired: ["entry", "tools"],
  });

  it("names the unknown top-level property and includes a reinstall hint", async () => {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify(agentPluginsDocument({
        id: "samplemail",
        name: "Sample Mail",
        description: "x",
        version: "0.3.2",
        entry: "dist/p.js",
        tools: ["a"],
        startupTools: ["a"],
      })));

    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /unknown property: 'startupTools'/,
    );
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /try reinstalling from the marketplace/,
    );
  });

  it("names multiple unknown properties when several appear", async () => {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify(agentPluginsDocument({
        id: "x-x",
        name: "X",
        description: "y",
        version: "0.0.1",
        entry: "e",
        tools: [],
        deprecatedField1: 1,
        deprecatedField2: 2,
      })));

    const validator = makeValidator();
    const err = await parsePluginJson(path, validator).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("deprecatedField1");
    expect(err!.message).toContain("deprecatedField2");
    expect(err!.message).toContain("fields");
  });

  it("plural detection — single-property case uses 'a field' wording", async () => {
    const path = join(workDir, "plugin.json");
    await writeFile(
      path,
      JSON.stringify(agentPluginsDocument({
        id: "x-x",
        name: "X",
        description: "y",
        version: "0.0.1",
        entry: "e",
        tools: [],
        oneStrayField: 1,
      })));

    const validator = makeValidator();
    await expect(parsePluginJson(path, validator)).rejects.toThrow(
      /contains a field/,
    );
  });

  it("non-additionalProperties errors still surface the original message + path", async () => {
    const path = join(workDir, "plugin.json");
    // Format errors should include field and expected shape, without reinstall guidance.
    await writeFile(
      path,
      JSON.stringify(agentPluginsDocument({
        id: "x-x",
        name: "X",
        description: "y",
        version: "not-semver",
        entry: "e",
        tools: [],
      })));

    const validator = makeValidator();
    const err = await parsePluginJson(path, validator).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("/version");
    expect(err!.message).not.toContain("try reinstalling from the marketplace");
  });

  it("preserves AJV `params` for non-additionalProperties errors (Round 2 — was lossy pre-fix)", async () => {
    const path = join(workDir, "plugin.json");
    // Preserve validator params so pattern errors include the expected expression.
    await writeFile(
      path,
      JSON.stringify(agentPluginsDocument({
        id: "x-x",
        name: "X",
        description: "y",
        version: "abc",
        entry: "e",
        tools: [],
      })));

    const validator = makeValidator();
    const err = await parsePluginJson(path, validator).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("\\\\d+\\\\.\\\\d+\\\\.\\\\d+");
  });

  it("rejects a pre-v6 legacy string-tools manifest with an actionable upgrade message (#885 Phase R)", async () => {
    const path = join(workDir, "plugin.json");
    // Even permissive schemas must fail string tool declarations with a clear pure-tool contract error.
    await writeFile(
      path,
      JSON.stringify(agentPluginsDocument({
        id: "legacy-plugin",
        name: "Legacy",
        description: "y",
        version: "0.1.0",
        entry: "dist/p.js",
        tools: ["legacy_tool_a", "legacy_tool_b"],
      })));

    const validator = makeValidator();
    const err = await parsePluginJson(path, validator).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("tools[0]");
    expect(err!.message).toContain("pre-v6 contract");
    expect(err!.message).toContain("app release contract");
    expect(err!.message).not.toContain("Invalid tool name 'undefined'");
  });
});

/** Use a permissive entry/process validator to isolate the host exactly-one and shape checks. */
describe("manifest-validation names the process-entry field to fix", () => {
  let workDir: string;
  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "manifest-process-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const makeValidator = permissiveManifestValidatorFactory();
  const PROCESS = {
    command: "./bin/plugin",
    args: ["${PLUGIN_ROOT}/vendor", "--x=1"],
    env: { SMOKE_VENDOR_DIR: "${PLUGIN_ROOT}/vendor" },
  };

  async function parse(fields: Record<string, unknown>): Promise<unknown> {
    const path = join(workDir, "plugin.json");
    await writeFile(path, JSON.stringify(agentPluginsDocument({
      id: "process-kit",
      name: "Process Kit",
      description: "x",
      version: "1.0.0",
      tools: [{ name: "process_kit_ping", inputSchema: { type: "object", properties: {} } }],
      requires: { minAppVersion: "0.13.0", hostProtocol: "4" },
      ...fields,
    })));
    return parsePluginJson(path, makeValidator());
  }

  it("admits a well-formed process entry", async () => {
    await expect(parse({ process: PROCESS })).resolves.toMatchObject({ process: PROCESS });
  });

  it("refuses a manifest with both entry and process", async () => {
    await expect(parse({ process: PROCESS, entry: "dist/p.js" })).rejects.toThrow(
      /at 'extensions\["ai\.agent-connector\.ave"\]\.process'.*exactly one of 'entry' and 'process'/u,
    );
  });

  it("refuses a manifest with neither entry nor process", async () => {
    await expect(parse({})).rejects.toThrow(/at 'extensions\["ai\.agent-connector\.ave"\]\.entry'.*or declare 'process' instead/u);
  });

  it("refuses an argument that looks like a path, naming its index", async () => {
    await expect(parse({ process: { ...PROCESS, args: ["--x=1", "../vendor"] } })).rejects.toThrow(
      /at 'extensions\["ai\.agent-connector\.ave"\]\.process\.args\[1\]'.*looks like a path/u,
    );
  });

  it("refuses a reserved environment name in any letter case", async () => {
    await expect(parse({ process: { ...PROCESS, env: { Plugin_Data: "x" } } })).rejects.toThrow(
      /at 'extensions\["ai\.agent-connector\.ave"\]\.process\.env\.Plugin_Data'.*reserves/u,
    );
  });

  it("refuses a process entry below the version floor", async () => {
    await expect(parse({ process: PROCESS, requires: { minAppVersion: "0.12.9", hostProtocol: "4" } })).rejects.toThrow(
      /at 'extensions\["ai\.agent-connector\.ave"\]\.requires\.minAppVersion'.*0\.13\.0 or newer/u,
    );
  });
});
