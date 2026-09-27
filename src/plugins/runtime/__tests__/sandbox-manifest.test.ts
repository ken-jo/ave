import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValidateFunction } from "ajv";
import { pluginManifestWriter } from "../../__tests__/test-helpers.js";
import { HOST_DIRECTORY_CATALOG } from "../../sandbox-authority.js";
import { buildManifestValidator, parsePluginJson } from "../manifest-validation.js";

describe("sandbox declaration validation", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "sandbox-manifest-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const write = pluginManifestWriter({ id: "sandbox-fixture", name: "Sandbox Fixture" }, () => root);
  const chosen = { kind: "userChosenDirectory", configKey: "workspace", why: "Read project sources" };

  it("accepts the closed catalog and a declared string config key", async () => {
    expect(Object.keys(HOST_DIRECTORY_CATALOG).sort()).toEqual(["certs", "runtime"]);
    const path = await write({
      configSchema: { properties: { workspace: { type: "string", default: "" } } },
      sandbox: { read: [{ kind: "hostDirectory", segments: ["certs"], why: "Read a certificate bundle" }], write: [chosen] },
    });
    expect((await parsePluginJson(path, await buildManifestValidator())).sandbox?.write).toEqual([chosen]);
  });

  it.each([
    ["unknown grant kind", { read: [{ ...chosen, kind: "unknown" }] }],
    ["unknown host subtree", { read: [{ kind: "hostDirectory", segments: ["secrets"], why: "Read data" }] }],
    ["host directory write", { write: [{ kind: "hostDirectory", segments: ["runtime"], why: "Write data" }] }],
    ["unknown field", { read: [{ ...chosen, extra: true }] }],
    ["too many grants", { read: Array.from({ length: 9 }, () => chosen) }],
    ["blank reason", { read: [{ ...chosen, why: " " }] }],
  ])("refuses %s", async (_label, sandbox) => {
    const path = await write({ configSchema: { properties: { workspace: { type: "string" } } }, sandbox });
    await expect(parsePluginJson(path, await buildManifestValidator())).rejects.toThrow();
  });

  it.each([
    ["missing key", { properties: {} }],
    ["numeric key", { properties: { workspace: { type: "number" } } }],
  ])("refuses a %s even with a permissive shape validator", async (_label, configSchema) => {
    const path = await write({ configSchema, sandbox: { write: [chosen] } });
    await expect(parsePluginJson(path, (() => true) as unknown as ValidateFunction)).rejects.toThrow(/string config key|declared config key/);
  });

  it.each(["__proto__", "constructor", "toString"])("refuses inherited catalog name %s with a permissive validator", async (name) => {
    const path = await write({ sandbox: { read: [{ kind: "hostDirectory", segments: [name], why: "Read host data" }] } });
    await expect(parsePluginJson(path, (() => true) as unknown as ValidateFunction)).rejects.toThrow(/does not name a host directory/);
  });
});
