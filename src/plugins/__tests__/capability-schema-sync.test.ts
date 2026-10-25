/** Capability declarations are free-form format-validated strings; only KNOWN_CAPABILITIES grant runtime behavior. */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KNOWN_CAPABILITIES } from "../capabilities.js";
import { aveSchemaProperties } from "./test-helpers.js";

async function loadCapabilitiesItemsSchema(): Promise<{
  enum?: string[];
  pattern?: string;
  type?: string;
}> {
  const schemaPath = fileURLToPath(
    new URL("../../../schemas/plugin-manifest.schema.json", import.meta.url),
  );
  const schema: unknown = JSON.parse(await readFile(schemaPath, "utf-8"));
  const capabilities = aveSchemaProperties(schema).capabilities as {
    items: { enum?: string[]; pattern?: string; type?: string };
  };
  return capabilities.items;
}

describe("capability schema contract (free-form, not a closed enum)", () => {
  it("capabilities items is a format-validated free-form string, not an enum", async () => {
    const items = await loadCapabilitiesItemsSchema();
    // A closed enum would reject installed manifests that declare retired capabilities.
    expect(items.enum).toBeUndefined();
    expect(items.type).toBe("string");
    expect(typeof items.pattern).toBe("string");
  });

  it("every host-ENFORCED capability matches the schema pattern", async () => {
    const items = await loadCapabilitiesItemsSchema();
    const re = new RegExp(items.pattern!);
    // The format must allow the colon in host:overlay.
    for (const cap of KNOWN_CAPABILITIES) {
      expect(re.test(cap), `enforced cap '${cap}' must match schema pattern`).toBe(
        true,
      );
    }
    expect(KNOWN_CAPABILITIES.has("host:overlay")).toBe(true);
    expect(KNOWN_CAPABILITIES.has("external-auth-consumer")).toBe(true);
  });

  it("legacy / removed capability strings still validate (no install-brick)", async () => {
    const items = await loadCapabilitiesItemsSchema();
    const re = new RegExp(items.pattern!);
    // Retired capability strings remain valid declarations without granting host behavior.
    for (const legacy of [
      "worker-client",
      "mail-source",
      "calendar-source",
      "meeting-recorder",
      "knowledge-index",
      "samplemail-consumer",
      "background-watcher",
      "document-indexer",
      "lifecycle-observer",
      "routine-provider",
    ]) {
      expect(re.test(legacy), `legacy cap '${legacy}' must still validate`).toBe(
        true,
      );
    }
  });
});
