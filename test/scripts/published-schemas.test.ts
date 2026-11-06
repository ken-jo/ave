import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../src/__tests__/support/tmp-dir-teardown.js";
import { PUBLISHED_SCHEMAS, checkPublishedSchemas, syncPublishedSchemas } from "../../scripts/lib/published-schemas.mjs";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await cleanupTmpDir(root); });
function put(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

describe("published contract schemas", () => {
  const repoRoot = resolve(import.meta.dirname, "../..");

  function contractFixture() {
    const root = mkdtempSync(join(tmpdir(), "contract-schemas-"));
    roots.push(root);
    for (const { source, id } of PUBLISHED_SCHEMAS) put(root, source, `${JSON.stringify({ $id: id })}\n`);
    mkdirSync(join(root, "web/public/schemas"), { recursive: true });
    syncPublishedSchemas(root);
    return root;
  }

  it("serves every contract schema in this repository at its $id", () => {
    expect(checkPublishedSchemas(repoRoot)).toBe(`${PUBLISHED_SCHEMAS.length} contract schemas`);
    for (const { id } of PUBLISHED_SCHEMAS) {
      expect(id).toMatch(/^https:\/\/ave\.agent-connector\.ai\/schemas\/[a-z-]+\/\d+\/[a-z-]+\.schema\.json$/u);
    }
  });

  it("rejects a served copy that drifted from its canonical schema", () => {
    const root = contractFixture();
    const [{ path, id }] = PUBLISHED_SCHEMAS;
    put(root, `web/public/schemas/${path}`, `${JSON.stringify({ $id: id, edited: true })}\n`);
    expect(() => checkPublishedSchemas(root)).toThrow(`web/public/schemas/${path} differs`);
  });

  it("rejects a canonical schema whose $id is not its served URL", () => {
    const root = contractFixture();
    const [{ source }] = PUBLISHED_SCHEMAS;
    put(root, source, `${JSON.stringify({ $id: "https://example.invalid/plugin.schema.json" })}\n`);
    expect(() => checkPublishedSchemas(root)).toThrow(`${source} must have $id`);
  });

  it("rejects a public schema no contract schema publishes", () => {
    const root = contractFixture();
    put(root, "web/public/schemas/plugin.schema.json", "{}\n");
    expect(() => checkPublishedSchemas(root)).toThrow("unrecorded published schema plugin.schema.json");
  });
});
