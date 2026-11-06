import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../src/__tests__/support/tmp-dir-teardown.js";
import { PUBLISHED_SCHEMAS, checkPublishedSchemas } from "../../scripts/lib/published-schemas.mjs";

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
    for (const { source, path, id } of PUBLISHED_SCHEMAS) {
      const text = `${JSON.stringify({ $id: id })}\n`;
      put(root, source, text);
      put(root, `web/public/schemas/${path}`, text);
    }
    return root;
  }

  it("serves every contract schema in this repository at its $id", () => {
    expect(checkPublishedSchemas(repoRoot)).toBe(`${PUBLISHED_SCHEMAS.length} contract schemas`);
    for (const { path, id } of PUBLISHED_SCHEMAS) {
      expect(id).toBe(`https://ave.agent-connector.ai/schemas/${path}`);
    }
  });

  it("keeps the released protocol schema at its original identity URL", () => {
    const path = "plugin-host-protocol/3/v0.14.0/protocol.schema.json";
    const file = join(repoRoot, "web/public/schemas", path);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).$id)
      .toBe(`https://ave.agent-connector.ai/schemas/${path}`);
    expect(createHash("sha256").update(readFileSync(file)).digest("hex"))
      .toBe("3e92239b7d7a6ac517040c3cfe6909b1c959edb176af4c3a34f5a2aabea18d7a");
  });

  it("rejects a served copy that drifted from its canonical schema", () => {
    const root = contractFixture();
    const { source, path, id } = PUBLISHED_SCHEMAS.find(({ source }) => source.startsWith("schemas/"))!;
    put(root, `web/public/schemas/${path}`, `${JSON.stringify({ $id: id, edited: true })}\n`);
    expect(() => checkPublishedSchemas(root)).toThrow(
      `web/public/schemas/${path} differs from ${source}; run cp ${source} web/public/schemas/${path}`,
    );
  });

  it("rejects a canonical schema whose $id is not its served URL", () => {
    const root = contractFixture();
    const { source } = PUBLISHED_SCHEMAS.find(({ source }) => source.startsWith("schemas/"))!;
    put(root, source, `${JSON.stringify({ $id: "https://example.invalid/plugin.schema.json" })}\n`);
    expect(() => checkPublishedSchemas(root)).toThrow(`${source} must have $id`);
  });

  it("rejects a public schema no contract schema publishes", () => {
    const root = contractFixture();
    put(root, "web/public/schemas/plugin.schema.json", "{}\n");
    expect(() => checkPublishedSchemas(root)).toThrow("unrecorded published schema plugin.schema.json");
  });
});
