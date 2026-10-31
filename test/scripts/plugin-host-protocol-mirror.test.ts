import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../src/__tests__/support/tmp-dir-teardown.js";
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

// This non-repository fixture has no tags; tagged immutability is covered separately.
const untagged = { taggedSchema: () => null };

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

function pointAlias(root: string, appVersion: string): void {
  const manifest = readManifest(root);
  manifest.aliases["2"] = `v${appVersion}`;
  put(root, `${mirrorBase}/mirror.json`, JSON.stringify(manifest));
  put(root, `${mirrorBase}/2/protocol.schema.json`,
    readMirror(root, `2/v${appVersion}/protocol.schema.json`).toString("utf8"));
}

afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

describe("host protocol web mirror", () => {
  it("keeps superseded protocol-4 bytes and provenance immutable", () => {
    const root = resolve(import.meta.dirname, "../..");
    const base = "web/public/schemas/plugin-host-protocol";
    const frozen = readFileSync(join(root, base, "4/v0.14.1/protocol.schema.json"));
    const sha256 = "9b9a3bfdf0aa6522e9de844fe933e1fbb9dc270debfe42cf37f9232f30981139";
    expect(createHash("sha256").update(frozen).digest("hex")).toBe(sha256);
    const manifest = JSON.parse(readFileSync(join(root, base, "mirror.json"), "utf8"));
    expect(manifest.copies.find((copy: { protocol: string; appVersion: string }) =>
      copy.protocol === "4" && copy.appVersion === "0.14.1")).toEqual({
      protocol: "4",
      appVersion: "0.14.1",
      sha256,
      generatedFrom: "6892aff0dfd646f37e860df7a2a3fe7462310c4c",
      publishedTag: null,
    });
    const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    expect(current).not.toBe("0.14.1");
    expect(readFileSync(join(root, base, `4/v${current}/protocol.schema.json`)))
      .toEqual(readFileSync(join(root, "schemas/plugin-host-protocol/4/protocol.schema.json")));
  });

  it("keeps published and orphan copies frozen when regenerating the candidate", () => {
    const { root, base } = fixture();
    const frozen = ["0.12.0", "0.12.1"].map((version) =>
      readFileSync(join(root, base, `2/v${version}/protocol.schema.json`)));
    put(root, "schemas/plugin-host-protocol/2/protocol.schema.json", schema("0.12.2", "revised"));
    expect(() => checkProtocolMirror(root, untagged)).toThrow("differs from the current canonical schema");
    syncProtocolMirror(root, commit, untagged);
    expect(checkProtocolMirror(root, untagged)).toContain("3 copies, 1 aliases, 1 candidate");
    ["0.12.0", "0.12.1"].forEach((version, index) =>
      expect(readFileSync(join(root, base, `2/v${version}/protocol.schema.json`)))
        .toEqual(frozen[index]));
  });

  it.each(["0.12.0", "0.12.1"])("rejects a changed frozen %s copy", (version) => {
    const { root, base } = fixture();
    put(root, `${base}/2/v${version}/protocol.schema.json`, schema(version, "edited"));
    expect(() => checkProtocolMirror(root, untagged)).toThrow("differs from recorded sha256");
  });

  it.each(["0.12.1", "0.12.2"])("rejects an alias to unpublished %s", (version) => {
    const { root, base } = fixture();
    const manifestPath = join(root, base, "mirror.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.aliases["2"] = `v${version}`;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => checkProtocolMirror(root, untagged)).toThrow("does not name a published copy");
  });

  it("promotes an alias only with the copy marked published", () => {
    const { root, base } = fixture();
    const manifestPath = join(root, base, "mirror.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.copies[2].publishedTag = "v0.12.2";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => checkProtocolMirror(root, untagged)).toThrow("alias must name the latest published copy");
    manifest.aliases["2"] = "v0.12.2";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    put(root, `${base}/2/protocol.schema.json`, schema("0.12.2", "candidate"));
    expect(checkProtocolMirror(root, untagged)).toContain("3 copies, 1 aliases, 0 candidate");
  });

  it("rejects a copy absent from the manifest", () => {
    const { root, base } = fixture();
    put(root, `${base}/2/v0.12.3/protocol.schema.json`, schema("0.12.3", "unknown"));
    expect(() => checkProtocolMirror(root, untagged)).toThrow("unrecorded copy");
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
    expect(checkProtocolMirror(root, untagged)).toContain("4 copies, 2 aliases, 1 candidate");
    put(root, "schemas/plugin-host-protocol/1/protocol.schema.json", `${JSON.stringify({
      $id: hostProtocolSchemaId("1/v0.11.0/protocol.schema.json"),
      prompts: [],
    })}\n`);
    expect(() => checkProtocolMirror(root, untagged)).toThrow(
      "frozen protocol 1/v0.11.0 canonical schema differs from published sha256",
    );
  });

  it("rejects a schema of a protocol the manifest does not record, published or not", () => {
    const { root, base } = fixture();
    expect(checkProtocolMirror(root, untagged)).toContain("3 copies");
    put(root, `${base}/1/v0.11.0/protocol.schema.json`, `${JSON.stringify({
      $id: hostProtocolSchemaId("1/v0.11.0/protocol.schema.json"),
    })}\n`);
    expect(() => checkProtocolMirror(root, untagged)).toThrow("unrecorded copy 1/v0.11.0/protocol.schema.json");
  });
});

describe("host protocol mirror: a tagged version's copy is frozen", () => {
  // A tagged candidate copy must remain immutable even after regeneration.
  const atTag = (tagged: Record<string, string>) =>
    ({ taggedSchema: (_root: string, appVersion: string) =>
      appVersion in tagged ? Buffer.from(tagged[appVersion]) : null });

  it("refuses a candidate regenerated after its version was tagged", () => {
    const { root } = fixture();
    const shipped = schema("0.12.2", "candidate");
    expect(checkProtocolMirror(root, atTag({ "0.12.2": shipped }))).toContain("1 candidate");

    put(root, "schemas/plugin-host-protocol/2/protocol.schema.json", schema("0.12.2", "revised"));
    expect(() => syncProtocolMirror(root, commit, atTag({ "0.12.2": shipped })))
      .toThrow("differs from the schema tag v0.12.2 carries");
    syncProtocolMirror(root, commit, atTag({}));
    expect(() => checkProtocolMirror(root, atTag({ "0.12.2": shipped })))
      .toThrow("2/v0.12.2/protocol.schema.json differs from the schema tag v0.12.2 carries");
  });

  it("refuses an unpublished orphan copy that differs from its tag", () => {
    const { root } = fixture();
    expect(() => checkProtocolMirror(root, atTag({ "0.12.1": schema("0.12.1", "what shipped") })))
      .toThrow("2/v0.12.1/protocol.schema.json differs from the schema tag v0.12.1 carries");
  });

  it("refuses a copy whose tag does not carry the protocol at all", () => {
    const { root } = fixture();
    expect(() => checkProtocolMirror(root, atTag({ "0.12.0": "" })))
      .toThrow("differs from the schema tag v0.12.0 carries");
  });

  it("accepts every copy that matches its tag, and untagged versions", () => {
    const { root } = fixture();
    expect(checkProtocolMirror(root, atTag({
      "0.12.0": schema("0.12.0", "published"),
      "0.12.1": schema("0.12.1", "orphan"),
    }))).toContain("3 copies, 1 aliases, 1 candidate");
  });

  it("reads the tags of this repository by default", () => {
    const repoRoot = resolve(import.meta.dirname, "../..");
    expect(checkProtocolMirror(repoRoot)).toMatch(/copies/);
  });
});

describe("host protocol mirror: tags read from a real git checkout", () => {
  // Scrub inherited Git variables so the fixture owns repository resolution.
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", [
    "-c", "user.name=Mirror Test", "-c", "user.email=mirror@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.defaultBranch=main",
    // Keep fixture blobs LF regardless of host autocrlf settings.
    "-c", "core.autocrlf=false",
    ...args,
  ], { cwd, env: gitEnv, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");

  function taggedRepo(tag: string | null = "v0.12.2") {
    const { root, base } = fixture();
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "release");
    if (tag) git(root, "tag", tag);
    return { root, base };
  }

  it("accepts the copy the tag carries, and refuses it once tampered", () => {
    const { root, base } = taggedRepo();
    expect(checkProtocolMirror(root)).toContain("3 copies, 1 aliases, 1 candidate");

    // A consistent regenerated hash cannot authorize modifying a tagged copy.
    const tampered = schema("0.12.2", "tampered");
    put(root, `${base}/2/v0.12.2/protocol.schema.json`, tampered);
    put(root, "schemas/plugin-host-protocol/2/protocol.schema.json", tampered);
    const manifest = readManifest(root);
    manifest.copies[2].sha256 = createHash("sha256").update(tampered).digest("hex");
    put(root, `${mirrorBase}/mirror.json`, JSON.stringify(manifest));
    expect(() => checkProtocolMirror(root))
      .toThrow("2/v0.12.2/protocol.schema.json differs from the schema tag v0.12.2 carries");
    expect(() => syncProtocolMirror(root, commit))
      .toThrow("differs from the schema tag v0.12.2 carries");
  });

  it("passes a version that is not tagged yet, as the release script's pre-tag sync needs", () => {
    // An unpublished version bump may regenerate the next contract.
    const { root } = taggedRepo();
    put(root, "package.json", JSON.stringify({ version: "0.12.3" }));
    put(root, "schemas/plugin-host-protocol/2/protocol.schema.json", schema("0.12.3", "next"));
    syncProtocolMirror(root, commit);
    expect(checkProtocolMirror(root)).toContain("4 copies, 1 aliases, 1 candidate");
  });

  it("refuses a checkout with no release tags", () => {
    const { root } = taggedRepo(null);
    expect(() => checkProtocolMirror(root)).toThrow("has no v* release tags");
  });

  it("refuses a shallow checkout", () => {
    const { root } = taggedRepo();
    const shallow = mkdtempSync(join(tmpdir(), "protocol-mirror-shallow-"));
    roots.push(shallow);
    git(shallow, "clone", "-q", "--depth", "1", `file://${root}`, ".");
    expect(() => checkProtocolMirror(shallow)).toThrow("this checkout is shallow");
  });

  it("refuses a tree that is not a git checkout, even inside another repository", () => {
    const { root } = fixture();
    expect(() => checkProtocolMirror(root)).toThrow("is not a git checkout");

    // A subdirectory must not inherit the parent repository tags.
    const { root: parent } = taggedRepo();
    const nested = join(parent, "vendor", "ave");
    mkdirSync(nested, { recursive: true });
    for (const relative of ["package.json", "schemas/plugin-host-protocol/2/protocol.schema.json"]) {
      put(nested, relative, readFileSync(join(root, relative), "utf8"));
    }
    for (const version of ["0.12.0", "0.12.1", "0.12.2"]) {
      const relative = `${mirrorBase}/2/v${version}/protocol.schema.json`;
      put(nested, relative, readFileSync(join(root, relative), "utf8"));
    }
    put(nested, `${mirrorBase}/2/protocol.schema.json`, readMirror(root, "2/protocol.schema.json").toString("utf8"));
    put(nested, `${mirrorBase}/mirror.json`, readMirror(root, "mirror.json").toString("utf8"));
    expect(checkProtocolMirror(nested, untagged)).toContain("3 copies");
    expect(() => checkProtocolMirror(nested)).toThrow(`${nested} is not a git checkout`);
  });

  it("names the local remedy in the refusal", () => {
    const { root } = taggedRepo(null);
    expect(() => checkProtocolMirror(root)).toThrow("git fetch --unshallow --tags");
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
    expect(() => checkProtocolMirror(root, untagged)).toThrow("2 alias must name the latest published copy");
    pointAlias(root, "0.13.0");
    expect(checkProtocolMirror(root, untagged)).toContain("3 copies, 1 aliases, 1 candidate");
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
    expect(checkProtocolMirror(root, untagged)).toContain("3 copies, 1 aliases, 1 candidate");
    pointAlias(root, target);
    expect(() => checkProtocolMirror(root, untagged)).toThrow("2 alias does not name a published copy");
  });

  it("keeps the newer alias when an older copy is promoted second", () => {
    const { root } = fixture(unpublished, "0.14.0", null);
    const thirteen = readMirror(root, "2/v0.13.0/protocol.schema.json");
    expect(publishProtocolMirror(root, "2/0.13.0", untagged)).toBe("2 alias names v0.13.0");
    expect(checkProtocolMirror(root, untagged)).toContain("3 copies, 1 aliases, 1 candidate");
    expect(publishProtocolMirror(root, "2/0.12.0", untagged)).toBe("2 alias names v0.13.0");
    const manifest = readManifest(root);
    expect(manifest.aliases).toEqual({ "2": "v0.13.0" });
    expect(manifest.copies.map((entry: { publishedTag: string | null }) => entry.publishedTag))
      .toEqual(["v0.12.0", "v0.13.0", null]);
    expect(readMirror(root, "2/protocol.schema.json")).toEqual(thirteen);
    expect(checkProtocolMirror(root, untagged)).toContain("3 copies, 1 aliases, 1 candidate");
  });

  it("moves the alias when a newer copy is promoted second", () => {
    const { root } = fixture([
      ["0.12.0", "twelve", null],
      ["0.13.0", "candidate", null],
    ], "0.13.0", null);
    expect(publishProtocolMirror(root, "2/0.12.0", untagged)).toBe("2 alias names v0.12.0");
    expect(checkProtocolMirror(root, untagged)).toContain("2 copies, 1 aliases, 1 candidate");
    expect(publishProtocolMirror(root, "2/0.13.0", untagged)).toBe("2 alias names v0.13.0");
    expect(readManifest(root).aliases).toEqual({ "2": "v0.13.0" });
    expect(readMirror(root, "2/protocol.schema.json"))
      .toEqual(readMirror(root, "2/v0.13.0/protocol.schema.json"));
    expect(checkProtocolMirror(root, untagged)).toContain("2 copies, 1 aliases, 0 candidate");
    pointAlias(root, "0.12.0");
    expect(() => checkProtocolMirror(root, untagged)).toThrow("2 alias must name the latest published copy");
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
    expect(() => publishProtocolMirror(root, target, untagged)).toThrow(message);
    expect(readMirror(root, "mirror.json")).toEqual(manifest);
  });

  it("refuses to publish from a mirror that fails its check", () => {
    const { root, base } = fixture(unpublished, "0.14.0", null);
    put(root, `${base}/2/v0.13.0/protocol.schema.json`, schema("0.13.0", "edited"));
    expect(() => publishProtocolMirror(root, "2/0.13.0", untagged)).toThrow("differs from recorded sha256");
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
