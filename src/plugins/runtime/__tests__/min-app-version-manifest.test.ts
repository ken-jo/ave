/** Revalidate minAppVersion format in the host so stale schema copies cannot turn malformed versions into silent compatibility refusals. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePluginJson } from "../manifest-validation.js";
import { HOST_PROTOCOL_CURRENT_VERSION, HOST_PROTOCOL_VERSIONS_SERVED } from "../../isolation/host-api-wire.js";
import {
  permissiveManifestValidatorFactory,
  pluginManifestWriter,
} from "../../__tests__/test-helpers.js";

describe("manifest requires.minAppVersion validator", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "min-app-version-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  const makeValidator = permissiveManifestValidatorFactory({
    namespaceProperties: {
      entry: { type: "string" },
      tools: { type: "array" },
      requires: { type: "object" },
    },
    namespaceRequired: ["entry", "tools"],
  });

  const writeManifest = pluginManifestWriter(
    { id: "min-app-version-test", name: "Min App Version Test" },
    () => workDir,
  );

  it("accepts a manifest with no requires (backward-compat)", async () => {
    const path = await writeManifest({});
    const parsed = await parsePluginJson(path, makeValidator());
    expect(parsed.requires).toBeUndefined();
  });

  it("accepts requires without minAppVersion", async () => {
    const path = await writeManifest({ requires: { capabilities: ["meeting-recorder"] } });
    const parsed = await parsePluginJson(path, makeValidator());
    expect(parsed.requires?.minAppVersion).toBeUndefined();
  });

  it("accepts a well-formed plain SemVer minAppVersion", async () => {
    const path = await writeManifest({ requires: { capabilities: [], minAppVersion: "1.4.0" } });
    const parsed = await parsePluginJson(path, makeValidator());
    expect(parsed.requires?.minAppVersion).toBe("1.4.0");
  });

  it("rejects a range/caret minAppVersion (not a plain SemVer)", async () => {
    const path = await writeManifest({ requires: { capabilities: [], minAppVersion: "^1.4.0" } });
    await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
      /requires\.minAppVersion.*manifest_schema/,
    );
  });

  it("rejects a pre-release / leading-zero minAppVersion", async () => {
    const pre = await writeManifest({ requires: { capabilities: [], minAppVersion: "1.4.0-rc1" } });
    await expect(parsePluginJson(pre, makeValidator())).rejects.toThrow(
      /requires\.minAppVersion/,
    );
  });

  it("rejects a non-string minAppVersion", async () => {
    const path = await writeManifest({ requires: { capabilities: [], minAppVersion: 140 } });
    await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
      /requires\.minAppVersion/,
    );
  });
});

describe("manifest requires.hostProtocol validator", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "host-protocol-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  // Use a permissive schema to isolate host revalidation.
  const makeValidator = permissiveManifestValidatorFactory({
    namespaceProperties: {
      entry: { type: "string" },
      tools: { type: "array" },
      requires: { type: "object" },
    },
    namespaceRequired: ["entry", "tools"],
  });

  const writeManifest = pluginManifestWriter(
    { id: "host-protocol-test", name: "Host Protocol Test" },
    () => workDir,
  );

  it("accepts a positive integer written as a string", async () => {
    const version = HOST_PROTOCOL_CURRENT_VERSION;
    const path = await writeManifest({ requires: { capabilities: [], hostProtocol: version } });
    const parsed = await parsePluginJson(path, makeValidator());
    expect(parsed.requires?.hostProtocol).toBe(version);
  });

  it("accepts a version this app does not serve, which the load gate refuses instead", async () => {
    // Well-formed future versions parse; runtime decides whether this app supports them.
    const futureVersion = String(Math.max(...HOST_PROTOCOL_VERSIONS_SERVED.map(Number)) + 1);
    const path = await writeManifest({ requires: { capabilities: [], hostProtocol: futureVersion } });
    const parsed = await parsePluginJson(path, makeValidator());
    expect(parsed.requires?.hostProtocol).toBe(futureVersion);
  });

  it("suggests a served protocol version when the value is malformed", async () => {
    const path = await writeManifest({ requires: { capabilities: [], hostProtocol: "02" } });
    await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
      `Example: "requires": { "hostProtocol": "${HOST_PROTOCOL_CURRENT_VERSION}" }`,
    );
  });

  for (const bad of ["0", "01", "1.0", "v1", "", "1\n"]) {
    it(`rejects ${JSON.stringify(bad)}`, async () => {
      const path = await writeManifest({ requires: { capabilities: [], hostProtocol: bad } });
      await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
        /requires\.hostProtocol.*manifest_schema/,
      );
    });
  }

  it("rejects a number", async () => {
    const path = await writeManifest({ requires: { capabilities: [], hostProtocol: 1 } });
    await expect(parsePluginJson(path, makeValidator())).rejects.toThrow(
      /requires\.hostProtocol/,
    );
  });
});
