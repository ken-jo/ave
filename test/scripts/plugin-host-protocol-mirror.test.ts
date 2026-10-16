import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PUBLISHED_SCHEMAS,
  checkProtocolMirror,
  checkPublishedSchemas,
  hostProtocolSchemaId,
  publishProtocolMirror,
  syncProtocolMirror,
  syncPublishedSchemas,
} from "../../scripts/lib/plugin-host-protocol-mirror.mjs";

const roots: string[] = [];
const commit = "a".repeat(40);

function put(root: string, relative: string, bytes: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function schema(version: string, value: string): string {
  return `${JSON.stringify({
    $id: hostProtocolSchemaId(`2/v${version}/protocol.schema.json`),
    value,
  })}\n`;
}

type Copy = readonly [appVersion: string, value: string, publishedTag: string | null];

// The copy at `version` is the candidate; its value must be "candidate".
function fixture(
  copies: readonly Copy[] = [
    ["0.12.0", "published", "v0.12.0"],
    ["0.12.1", "orphan", null],
    ["0.12.2", "candidate", null],
  ],
  version = "0.12.2",
  alias: string | null = "0.12.0",
) {
  const root = mkdtempSync(join(tmpdir(), "protocol-mirror-"));
  roots.push(root);
  const base = "web/public/schemas/plugin-host-protocol";
  const entries = copies.map(([appVersion, value, publishedTag]) => {
    const bytes = schema(appVersion, value);
    put(root, `${base}/2/v${appVersion}/protocol.schema.json`, bytes);
    return { protocol: "2", appVersion,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      generatedFrom: commit, publishedTag };
  });
  put(root, "package.json", JSON.stringify({ version }));
  put(root, "schemas/plugin-host-protocol/2/protocol.schema.json", schema(version, "candidate"));
  put(root, `${base}/mirror.json`, JSON.stringify({ copies: entries, aliases: {} }));
  if (alias) pointAlias(root, alias);
  return { root, base };
}

const mirrorBase = "web/public/schemas/plugin-host-protocol";

function readMirror(root: string, relative: string): Buffer {
  return readFileSync(join(root, mirrorBase, relative));
}

function readManifest(root: string) {
  return JSON.parse(readMirror(root, "mirror.json").toString("utf8"));
}

// Write the alias by hand, the way a promotion PR could without the script.
function pointAlias(root: string, appVersion: string): void {
  const manifest = readManifest(root);
  manifest.aliases["2"] = `v${appVersion}`;
  put(root, `${mirrorBase}/mirror.json`, JSON.stringify(manifest));
  put(root, `${mirrorBase}/2/protocol.schema.json`,
    readMirror(root, `2/v${appVersion}/protocol.schema.json`).toString("utf8"));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host protocol web mirror", () => {
  it("keeps published and orphan copies frozen when regenerating the candidate", () => {
    const { root, base } = fixture();
    const frozen = ["0.12.0", "0.12.1"].map((version) =>
      readFileSync(join(root, base, `2/v${version}/protocol.schema.json`)));
    put(root, "schemas/plugin-host-protocol/2/protocol.schema.json", schema("0.12.2", "revised"));
    expect(() => checkProtocolMirror(root)).toThrow("differs from the current canonical schema");
    syncProtocolMirror(root, commit);
    expect(checkProtocolMirror(root)).toContain("3 copies, 1 aliases, 1 candidate");
    ["0.12.0", "0.12.1"].forEach((version, index) =>
      expect(readFileSync(join(root, base, `2/v${version}/protocol.schema.json`)))
        .toEqual(frozen[index]));
  });

  it.each(["0.12.0", "0.12.1"])("rejects a changed frozen %s copy", (version) => {
    const { root, base } = fixture();
    put(root, `${base}/2/v${version}/protocol.schema.json`, schema(version, "edited"));
    expect(() => checkProtocolMirror(root)).toThrow("differs from recorded sha256");
  });

  it.each(["0.12.1", "0.12.2"])("rejects an alias to unpublished %s", (version) => {
    const { root, base } = fixture();
    const manifestPath = join(root, base, "mirror.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.aliases["2"] = `v${version}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => checkProtocolMirror(root)).toThrow("does not name a published copy");
  });

  it("promotes an alias only with the copy marked published", () => {
    const { root, base } = fixture();
    const manifestPath = join(root, base, "mirror.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.copies[2].publishedTag = "v0.12.2";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => checkProtocolMirror(root)).toThrow("alias must name the latest published copy");
    manifest.aliases["2"] = "v0.12.2";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    put(root, `${base}/2/protocol.schema.json`, schema("0.12.2", "candidate"));
    expect(checkProtocolMirror(root)).toContain("3 copies, 1 aliases, 0 candidate");
  });

  it("rejects a copy absent from the manifest", () => {
    const { root, base } = fixture();
    put(root, `${base}/2/v0.12.3/protocol.schema.json`, schema("0.12.3", "unknown"));
    expect(() => checkProtocolMirror(root)).toThrow("unrecorded copy");
  });

  it("rejects a contribution added to a retired canonical protocol", () => {
    const { root, base } = fixture();
    const frozen = `${JSON.stringify({
      $id: hostProtocolSchemaId("1/v0.11.0/protocol.schema.json"),
    })}\n`;
    put(root, "schemas/plugin-host-protocol/1/protocol.schema.json", frozen);
    put(root, `${base}/1/v0.11.0/protocol.schema.json`, frozen);
    put(root, `${base}/1/protocol.schema.json`, frozen);
    const manifestPath = join(root, base, "mirror.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.copies.push({ protocol: "1", appVersion: "0.11.0",
      sha256: createHash("sha256").update(frozen).digest("hex"),
      generatedFrom: commit, publishedTag: "v0.11.0" });
    manifest.aliases["1"] = "v0.11.0";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(checkProtocolMirror(root)).toContain("4 copies, 2 aliases, 1 candidate");
    put(root, "schemas/plugin-host-protocol/1/protocol.schema.json", `${JSON.stringify({
      $id: hostProtocolSchemaId("1/v0.11.0/protocol.schema.json"),
      prompts: [],
    })}\n`);
    expect(() => checkProtocolMirror(root)).toThrow(
      "frozen protocol 1/v0.11.0 canonical schema differs from published sha256",
    );
  });

  it("rejects a schema of a protocol the manifest does not record, published or not", () => {
    const { root, base } = fixture();
    expect(checkProtocolMirror(root)).toContain("3 copies");
    put(root, `${base}/1/v0.11.0/protocol.schema.json`, `${JSON.stringify({
      $id: hostProtocolSchemaId("1/v0.11.0/protocol.schema.json"),
    })}\n`);
    expect(() => checkProtocolMirror(root)).toThrow("unrecorded copy 1/v0.11.0/protocol.schema.json");
  });
});

describe("host protocol mirror alias", () => {
  const twoPublished: readonly Copy[] = [
    ["0.12.0", "twelve", "v0.12.0"],
    ["0.13.0", "thirteen", "v0.13.0"],
    ["0.14.0", "candidate", null],
  ];
  const unpublished: readonly Copy[] = [
    ["0.12.0", "twelve", null],
    ["0.13.0", "thirteen", null],
    ["0.14.0", "candidate", null],
  ];

  it("names the newest published copy while a candidate is open", () => {
    const { root } = fixture(twoPublished, "0.14.0", "0.12.0");
    expect(() => checkProtocolMirror(root)).toThrow("2 alias must name the latest published copy");
    pointAlias(root, "0.13.0");
    expect(checkProtocolMirror(root)).toContain("3 copies, 1 aliases, 1 candidate");
  });

  it.each([
    ["an orphan", "0.13.0"],
    ["the candidate", "0.14.0"],
  ])("rejects an alias to %s while a candidate is open", (_, target) => {
    const { root } = fixture([
      ["0.12.0", "twelve", "v0.12.0"],
      ["0.13.0", "orphan", null],
      ["0.14.0", "candidate", null],
    ], "0.14.0", "0.12.0");
    expect(checkProtocolMirror(root)).toContain("3 copies, 1 aliases, 1 candidate");
    pointAlias(root, target);
    expect(() => checkProtocolMirror(root)).toThrow("2 alias does not name a published copy");
  });

  it("keeps the newer alias when an older copy is promoted second", () => {
    const { root } = fixture(unpublished, "0.14.0", null);
    const thirteen = readMirror(root, "2/v0.13.0/protocol.schema.json");
    expect(publishProtocolMirror(root, "2/0.13.0")).toBe("2 alias names v0.13.0");
    expect(checkProtocolMirror(root)).toContain("3 copies, 1 aliases, 1 candidate");
    expect(publishProtocolMirror(root, "2/0.12.0")).toBe("2 alias names v0.13.0");
    const manifest = readManifest(root);
    expect(manifest.aliases).toEqual({ "2": "v0.13.0" });
    expect(manifest.copies.map((entry: { publishedTag: string | null }) => entry.publishedTag))
      .toEqual(["v0.12.0", "v0.13.0", null]);
    expect(readMirror(root, "2/protocol.schema.json")).toEqual(thirteen);
    expect(checkProtocolMirror(root)).toContain("3 copies, 1 aliases, 1 candidate");
  });

  it("moves the alias when a newer copy is promoted second", () => {
    const { root } = fixture([
      ["0.12.0", "twelve", null],
      ["0.13.0", "candidate", null],
    ], "0.13.0", null);
    expect(publishProtocolMirror(root, "2/0.12.0")).toBe("2 alias names v0.12.0");
    expect(checkProtocolMirror(root)).toContain("2 copies, 1 aliases, 1 candidate");
    expect(publishProtocolMirror(root, "2/0.13.0")).toBe("2 alias names v0.13.0");
    expect(readManifest(root).aliases).toEqual({ "2": "v0.13.0" });
    expect(readMirror(root, "2/protocol.schema.json"))
      .toEqual(readMirror(root, "2/v0.13.0/protocol.schema.json"));
    expect(checkProtocolMirror(root)).toContain("2 copies, 1 aliases, 0 candidate");
    pointAlias(root, "0.12.0");
    expect(() => checkProtocolMirror(root)).toThrow("2 alias must name the latest published copy");
  });

  it.each([
    ["2/v0.13.0", "--publish takes <protocol>/<version>, such as 2/0.13.0, not 2/v0.13.0"],
    ["2", "--publish takes <protocol>/<version>, such as 2/0.13.0, not 2"],
    ["2/0.15.0", "2/v0.15.0/protocol.schema.json is not recorded in mirror.json"],
    ["3/0.13.0", "3/v0.13.0/protocol.schema.json is not recorded in mirror.json"],
    ["2/0.12.0", "2/v0.12.0/protocol.schema.json is already published"],
  ])("refuses to publish %s", (target, message) => {
    const { root } = fixture([
      ["0.12.0", "twelve", "v0.12.0"],
      ["0.13.0", "thirteen", null],
      ["0.14.0", "candidate", null],
    ], "0.14.0", "0.12.0");
    const manifest = readMirror(root, "mirror.json");
    expect(() => publishProtocolMirror(root, target)).toThrow(message);
    expect(readMirror(root, "mirror.json")).toEqual(manifest);
  });

  it("refuses to publish from a mirror that fails its check", () => {
    const { root, base } = fixture(unpublished, "0.14.0", null);
    put(root, `${base}/2/v0.13.0/protocol.schema.json`, schema("0.13.0", "edited"));
    expect(() => publishProtocolMirror(root, "2/0.13.0")).toThrow("differs from recorded sha256");
    expect(readManifest(root).copies[1].publishedTag).toBeNull();
  });
});

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
