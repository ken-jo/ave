import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import manifestSchema from "../../../schemas/plugin-manifest.schema.json" with { type: "json" };
import {
  BUNDLE_EVERYTHING_REGEX,
  HOST_BROWSER_EXTERNAL_MODULES,
  HOST_EXTERNAL_MODULES,
  isValidPluginId,
  PLUGIN_ID_MAX_LENGTH,
  PLUGIN_ID_MIN_LENGTH,
  PLUGIN_ID_PATTERN,
} from "../public-contract.js";

const PUBLIC_CONTRACT_URL = new URL("../public-contract.ts", import.meta.url);
const TYPES_BARREL_URL = new URL("../types.ts", import.meta.url);

describe("Host-owned public plugin contract boundary", () => {
  it("keeps the vendored public contract self-contained and excludes Host-private DTOs", async () => {
    const source = await readFile(PUBLIC_CONTRACT_URL, "utf8");

    expect(source).not.toMatch(/^import\s/m);
    for (const declaration of [
      "PluginRegistryEntryInstallSource",
      "PluginRegistryEntry",
      "PluginRegistry",
    ]) {
      expect(source).not.toMatch(
        new RegExp(`^export (?:interface|type|class|const|enum) ${declaration}\\b`,
          "m",
        ),
      );
    }
  });

  it("keeps public JSDoc in the Host source and re-exports it through types.ts", async () => {
    const [contract, barrel] = await Promise.all([
      readFile(PUBLIC_CONTRACT_URL, "utf8"),
      readFile(TYPES_BARREL_URL, "utf8"),
    ]);

    expect(contract).toContain("`tools` is the only callable surface.");
    expect(contract).toContain("Pure MCP `Tool` objects");
    expect(contract).not.toMatch(/\bkeywords\??:/);
    expect(contract).not.toContain("registerKeywords");
    expect(barrel).toContain('export * from "./public-contract.js";');
  });

  it("owns the plugin build-policy ABI carried by the public contract", () => {
    expect(HOST_EXTERNAL_MODULES).toEqual(["electron"]);
    expect(HOST_BROWSER_EXTERNAL_MODULES).toEqual(["react", "react-dom"]);
    expect(BUNDLE_EVERYTHING_REGEX.source).toBe(".*");
  });

  it("mirrors the manifest schema's plugin id rule exactly", () => {
    const name = manifestSchema.properties.name;
    expect(PLUGIN_ID_PATTERN.source).toBe(name.pattern);
    expect(PLUGIN_ID_MIN_LENGTH).toBe(name.minLength);
    expect(PLUGIN_ID_MAX_LENGTH).toBe(name.maxLength);
    expect(isValidPluginId("sample-plugin")).toBe(true);
    for (const rejected of ["ab", "a--b", "a-", "A-b", "a_b", "a.b", "1ab", "a".repeat(65), 7]) {
      expect(isValidPluginId(rejected)).toBe(false);
    }
  });
});
