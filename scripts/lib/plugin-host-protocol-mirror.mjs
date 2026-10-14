import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const MIRROR = "web/public/schemas/plugin-host-protocol";
const VERSION = /^\d+\.\d+\.\d+$/u;
const PROTOCOL = /^\d+$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * Where a recorded copy is published: the `$id` of every schema the generator
 * writes and the mirror records. Protocols 1 and 2 were published under the
 * Ave site's origin and keep that `$id` byte for byte (RETIRED_COPIES); the
 * Ave site serves those files at the same paths.
 */
export const HOST_PROTOCOL_SCHEMA_ORIGIN = "https://ave.agent-connector.ai";

/** The `$id` of one recorded copy, given its path under the mirror root. */
export function hostProtocolSchemaId(relative) {
  return `${HOST_PROTOCOL_SCHEMA_ORIGIN}/schemas/plugin-host-protocol/${relative}`;
}

/**
 * Retired protocols' published schemas. Protocols 1 and 2 named the wire the
 * host no longer serves, so they left mirror.json, but their URLs were
 * published and plugins built against them still cite the `$id`. They stay in
 * the public tree as frozen historical documents: never recorded as copies,
 * never changed, each checked against the sha256 it was published with.
 */
const RETIRED_COPIES = new Map([
  ["1/protocol.schema.json", "aca9dfea7b1dc90a5ae49023c90aebb9d06384524254e80d172b0d19e098555e"],
  ["1/v0.11.0/protocol.schema.json", "aca9dfea7b1dc90a5ae49023c90aebb9d06384524254e80d172b0d19e098555e"],
  ["2/v0.12.0/protocol.schema.json", "c83bafc4724042725f27484b296c4ac6e42e9954a0e2400e4caf5acecea99ae0"],
  ["2/v0.13.0/protocol.schema.json", "e334f1d9f7aeab3fb5cfc167e4a455d30289c1bc6e01f96aef7fbcd617bbc277"],
]);

function fail(message) {
  throw new Error(`plugin host protocol mirror: ${message}`);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function copyPath(protocol, appVersion) {
  return `${protocol}/v${appVersion}/protocol.schema.json`;
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function readManifest(root) {
  const path = join(root, MIRROR, "mirror.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (!manifest || !Array.isArray(manifest.copies) || !manifest.aliases ||
      typeof manifest.aliases !== "object" || Array.isArray(manifest.aliases) ||
      Object.keys(manifest).sort().join(",") !== "aliases,copies") {
    fail("mirror.json must contain copies and aliases");
  }
  return manifest;
}

function writeManifest(root, manifest) {
  writeFileSync(join(root, MIRROR, "mirror.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function currentVersion(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
}

function newestPublished(copies, protocol) {
  return copies
    .filter((entry) => entry.protocol === protocol && entry.publishedTag !== null)
    .sort((a, b) => compareVersions(b.appVersion, a.appVersion))[0];
}

/** Check frozen copies, the live candidate, and aliases against the manifest. */
export function checkProtocolMirror(root) {
  const manifest = readManifest(root);
  const version = currentVersion(root);
  if (!VERSION.test(version)) fail("package.json version is invalid");
  const mirrorRoot = join(root, MIRROR);
  const expected = new Set(["mirror.json"]);
  const copies = new Map();
  let candidates = 0;
  const candidateProtocols = new Set();

  for (const entry of manifest.copies) {
    if (!entry || Object.keys(entry).sort().join(",") !==
      "appVersion,generatedFrom,protocol,publishedTag,sha256" ||
      !PROTOCOL.test(entry.protocol) || !VERSION.test(entry.appVersion) ||
      !SHA256.test(entry.sha256) || !COMMIT.test(entry.generatedFrom) ||
      (entry.publishedTag !== null && entry.publishedTag !== `v${entry.appVersion}`)) {
      fail("invalid copy entry");
    }
    const relative = copyPath(entry.protocol, entry.appVersion);
    if (copies.has(relative)) fail(`duplicate copy ${relative}`);
    const bytes = readFileSync(join(mirrorRoot, relative));
    if (digest(bytes) !== entry.sha256) fail(`${relative} differs from recorded sha256`);
    const schema = JSON.parse(bytes.toString("utf8"));
    const expectedId = hostProtocolSchemaId(relative);
    if (schema.$id !== expectedId) fail(`${relative} has a different $id`);
    if (entry.publishedTag === null && entry.appVersion === version) {
      candidates += 1;
      candidateProtocols.add(entry.protocol);
      const canonical = join(root, "schemas/plugin-host-protocol", entry.protocol, "protocol.schema.json");
      if (!existsSync(canonical) || !bytes.equals(readFileSync(canonical))) {
        fail(`${relative} differs from the current canonical schema; after a version bump or a protocol change, run node scripts/sync-plugin-host-protocol-mirror.mjs`);
      }
    }
    copies.set(relative, entry);
    expected.add(relative);
  }
  if (!manifest.copies.some((entry) => entry.appVersion === version)) {
    fail(`no copy for ${version}`);
  }

  for (const [protocol, target] of Object.entries(manifest.aliases)) {
    if (!PROTOCOL.test(protocol) || typeof target !== "string" || !VERSION.test(target.slice(1)) ||
        target !== `v${target.slice(1)}`) fail("invalid alias entry");
    const entry = copies.get(copyPath(protocol, target.slice(1)));
    if (!entry || entry.publishedTag !== target) fail(`${protocol} alias does not name a published copy`);
    const alias = `${protocol}/protocol.schema.json`;
    if (!readFileSync(join(mirrorRoot, alias)).equals(
      readFileSync(join(mirrorRoot, copyPath(protocol, target.slice(1)))))) {
      fail(`${protocol} alias differs from its published copy`);
    }
    expected.add(alias);
  }

  // The alias names the newest published copy whether or not a candidate is
  // open, so promotions of one protocol commute in either order. Without a
  // candidate, the canonical file also remains the latest published schema:
  // changing it would rewrite that release's contract. With one, the canonical
  // file is the candidate, checked above.
  const publishedProtocols = new Set(manifest.copies
    .filter((entry) => entry.publishedTag !== null)
    .map((entry) => entry.protocol));
  for (const protocol of publishedProtocols) {
    const latest = newestPublished(manifest.copies, protocol);
    if (manifest.aliases[protocol] !== latest.publishedTag) {
      fail(`${protocol} alias must name the latest published copy`);
    }
    if (candidateProtocols.has(protocol)) continue;
    const canonical = join(root, "schemas/plugin-host-protocol", protocol, "protocol.schema.json");
    if (!existsSync(canonical) ||
        !readFileSync(canonical).equals(readFileSync(join(mirrorRoot,
          copyPath(protocol, latest.appVersion))))) {
      fail(`frozen protocol ${protocol}/v${latest.appVersion} canonical schema differs from published sha256`);
    }
  }

  const found = new Set();
  for (const protocol of readdirSync(mirrorRoot, { withFileTypes: true })) {
    if (protocol.isFile()) { found.add(protocol.name); continue; }
    if (!protocol.isDirectory() || !PROTOCOL.test(protocol.name)) fail(`unexpected path ${protocol.name}`);
    for (const child of readdirSync(join(mirrorRoot, protocol.name), { withFileTypes: true })) {
      if (child.isFile()) { found.add(`${protocol.name}/${child.name}`); continue; }
      if (!child.isDirectory()) fail(`unexpected path ${protocol.name}/${child.name}`);
      for (const file of readdirSync(join(mirrorRoot, protocol.name, child.name))) {
        found.add(`${protocol.name}/${child.name}/${file}`);
      }
    }
  }
  for (const path of found) {
    if (expected.has(path)) continue;
    const retired = RETIRED_COPIES.get(path);
    if (!retired) fail(`unrecorded copy ${path}`);
    if (digest(readFileSync(join(mirrorRoot, path))) !== retired) fail(`retired ${path} differs from its published sha256`);
  }
  for (const path of expected) if (!found.has(path)) fail(`missing copy ${path}`);
  return `${manifest.copies.length} copies, ${Object.keys(manifest.aliases).length} aliases, ${candidates} candidate`;
}

/** Refresh only the current candidate after a version bump and schema generation. */
export function syncProtocolMirror(root, generatedFrom) {
  if (!COMMIT.test(generatedFrom)) fail("generatedFrom must be a full commit SHA");
  const manifest = readManifest(root);
  const version = currentVersion(root);
  const canonicalRoot = join(root, "schemas/plugin-host-protocol");
  const mirrorRoot = join(root, MIRROR);
  for (const dir of readdirSync(canonicalRoot, { withFileTypes: true })) {
    if (!dir.isDirectory() || !PROTOCOL.test(dir.name)) continue;
    const canonical = join(canonicalRoot, dir.name, "protocol.schema.json");
    if (!existsSync(canonical)) continue;
    const bytes = readFileSync(canonical);
    if (JSON.parse(bytes.toString("utf8")).$id !== hostProtocolSchemaId(copyPath(dir.name, version))) continue;
    const relative = copyPath(dir.name, version);
    const prior = manifest.copies.find((entry) =>
      entry.protocol === dir.name && entry.appVersion === version);
    if (prior?.publishedTag) fail(`${relative} is published and cannot be changed`);
    const target = join(mirrorRoot, relative);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(canonical, target);
    const entry = { protocol: dir.name, appVersion: version, sha256: digest(bytes),
      generatedFrom, publishedTag: null };
    if (prior) Object.assign(prior, entry);
    else manifest.copies.push(entry);
  }
  writeManifest(root, manifest);
}

/**
 * Mark one copy published after its app release is published, and point its
 * protocol's alias at the newest published copy, which is not necessarily the
 * one just promoted.
 */
export function publishProtocolMirror(root, target) {
  const match = /^(\d+)\/(\d+\.\d+\.\d+)$/u.exec(target);
  if (!match) fail(`--publish takes <protocol>/<version>, such as 2/0.13.0, not ${target}`);
  const [, protocol, appVersion] = match;
  checkProtocolMirror(root);
  const manifest = readManifest(root);
  const relative = copyPath(protocol, appVersion);
  const entry = manifest.copies.find((copy) =>
    copy.protocol === protocol && copy.appVersion === appVersion);
  if (!entry) fail(`${relative} is not recorded in mirror.json`);
  if (entry.publishedTag !== null) fail(`${relative} is already published`);
  entry.publishedTag = `v${appVersion}`;
  const latest = newestPublished(manifest.copies, protocol);
  manifest.aliases[protocol] = latest.publishedTag;
  const mirrorRoot = join(root, MIRROR);
  copyFileSync(join(mirrorRoot, copyPath(protocol, latest.appVersion)),
    join(mirrorRoot, protocol, "protocol.schema.json"));
  writeManifest(root, manifest);
  return `${protocol} alias names ${latest.publishedTag}`;
}
