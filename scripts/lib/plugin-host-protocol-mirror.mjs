import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const MIRROR = "web/public/schemas/plugin-host-protocol";
const VERSION = /^\d+\.\d+\.\d+$/u;
const PROTOCOL = /^\d+$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

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

function currentVersion(root) {
  return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
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
    const expectedId = `https://former-site.invalid/schemas/plugin-host-protocol/${relative}`;
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

  // Without a candidate, the canonical file remains the latest published
  // schema. Changing it would rewrite that release's contract.
  const publishedProtocols = new Set(manifest.copies
    .filter((entry) => entry.publishedTag !== null)
    .map((entry) => entry.protocol));
  for (const protocol of publishedProtocols) {
    if (candidateProtocols.has(protocol)) continue;
    const latest = manifest.copies
      .filter((entry) => entry.protocol === protocol && entry.publishedTag !== null)
      .sort((a, b) => compareVersions(b.appVersion, a.appVersion))[0];
    if (manifest.aliases[protocol] !== latest.publishedTag) {
      fail(`${protocol} alias must name the latest published copy`);
    }
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
  for (const path of found) if (!expected.has(path)) fail(`unrecorded copy ${path}`);
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
    if (JSON.parse(bytes.toString("utf8")).$id !==
      `https://former-site.invalid/schemas/plugin-host-protocol/${copyPath(dir.name, version)}`) continue;
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
  writeFileSync(join(mirrorRoot, "mirror.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
