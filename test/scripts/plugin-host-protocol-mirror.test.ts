import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkProtocolMirror, syncProtocolMirror } from "../../scripts/lib/plugin-host-protocol-mirror.mjs";

const roots: string[] = [];
const commit = "a".repeat(40);

function put(root: string, relative: string, bytes: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

function schema(version: string, value: string): string {
  return `${JSON.stringify({
    $id: `https://former-site.invalid/schemas/plugin-host-protocol/2/v${version}/protocol.schema.json`,
    value,
  })}\n`;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "protocol-mirror-"));
  roots.push(root);
  const base = "web/public/schemas/plugin-host-protocol";
  const copies = [
    ["0.12.0", "published", "v0.12.0"],
    ["0.12.1", "orphan", null],
    ["0.12.2", "candidate", null],
  ] as const;
  const entries = copies.map(([appVersion, value, publishedTag]) => {
    const bytes = schema(appVersion, value);
    put(root, `${base}/2/v${appVersion}/protocol.schema.json`, bytes);
    return { protocol: "2", appVersion,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      generatedFrom: commit, publishedTag };
  });
  put(root, "package.json", JSON.stringify({ version: "0.12.2" }));
  put(root, "schemas/plugin-host-protocol/2/protocol.schema.json", schema("0.12.2", "candidate"));
  put(root, `${base}/2/protocol.schema.json`, schema("0.12.0", "published"));
  put(root, `${base}/mirror.json`, JSON.stringify({ copies: entries, aliases: { "2": "v0.12.0" } }));
  return { root, base };
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
      $id: "https://former-site.invalid/schemas/plugin-host-protocol/1/v0.11.0/protocol.schema.json",
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
      $id: "https://former-site.invalid/schemas/plugin-host-protocol/1/v0.11.0/protocol.schema.json",
      prompts: [],
    })}\n`);
    expect(() => checkProtocolMirror(root)).toThrow(
      "frozen protocol 1/v0.11.0 canonical schema differs from published sha256",
    );
  });
});
