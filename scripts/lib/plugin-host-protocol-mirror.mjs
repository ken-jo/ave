import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { withoutGitContext } from "./git-process-environment.mjs";

const MIRROR = "web/public/schemas/plugin-host-protocol";
const VERSION = /^\d+\.\d+\.\d+$/u;
const PROTOCOL = /^\d+$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

/**
 * Where Ave publishes its JSON Schemas: every schema `$id` the host owns is
 * this origin plus its path under `web/public/schemas/`, and the Ave site
 * serves the file at that URL.
 */
const AVE_SCHEMA_ORIGIN = "https://ave.agent-connector.ai";
const PUBLIC_SCHEMAS = "web/public/schemas";

/** The `$id` of a schema Ave publishes, given its path under `/schemas/`. */
function aveSchemaId(relative) {
  return `${AVE_SCHEMA_ORIGIN}/schemas/${relative}`;
}

/** The `$id` of one recorded copy, given its path under the mirror root. */
export function hostProtocolSchemaId(relative) {
  return aveSchemaId(`plugin-host-protocol/${relative}`);
}

/**
 * The hand-authored contract schemas and the path each is served at. The
 * version segment is the format version the schema itself pins and the host
 * dispatches on — `schemaVersion` for the marketplace files, the host
 * protocol a plugin manifest declares (`requires.hostProtocol`), the skill
 * package format — not the app version: these `$id`s are written verbatim
 * into third-party files (`$schema`, cross-schema `$ref`s), so they change
 * only when the format does. A format change is a new path beside the old one.
 */
export const PUBLISHED_SCHEMAS = Object.freeze([
  ["schemas/plugin-manifest.schema.json", "plugin/3/plugin.schema.json"],
  ["schemas/skill-package.schema.json", "skill/1/skill.schema.json"],
  ["schemas/marketplace/index.schema.json", "marketplace/2/index.schema.json"],
  ["schemas/marketplace/package.schema.json", "marketplace/2/package.schema.json"],
  ["schemas/marketplace/revocations.schema.json", "marketplace/2/revocations.schema.json"],
  ["schemas/marketplace/revocations-by-app.schema.json", "marketplace/2/revocations-by-app.schema.json"],
].map(([source, path]) => Object.freeze({ source, path, id: aveSchemaId(path) })));

function walkFiles(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walkFiles(join(dir, entry.name), relative);
    return [relative];
  });
}

/**
 * Each published contract schema names its served URL as `$id`, and the
 * public tree serves the canonical bytes there. Outside the protocol mirror,
 * the public schema tree holds nothing else.
 */
export function checkPublishedSchemas(root) {
  const expected = new Set();
  for (const { source, path, id } of PUBLISHED_SCHEMAS) {
    const bytes = readFileSync(join(root, source));
    if (JSON.parse(bytes.toString("utf8")).$id !== id) fail(`${source} must have $id ${id}`);
    const served = join(root, PUBLIC_SCHEMAS, path);
    if (!existsSync(served) || !bytes.equals(readFileSync(served))) {
      fail(`${PUBLIC_SCHEMAS}/${path} differs from ${source}; run node scripts/sync-plugin-host-protocol-mirror.mjs`);
    }
    expected.add(path);
  }
  for (const path of walkFiles(join(root, PUBLIC_SCHEMAS))) {
    if (path.startsWith("plugin-host-protocol/") || expected.has(path)) continue;
    fail(`unrecorded published schema ${path}`);
  }
  return `${PUBLISHED_SCHEMAS.length} contract schemas`;
}

/** Copy each contract schema to the path it is served at. */
export function syncPublishedSchemas(root) {
  for (const { source, path } of PUBLISHED_SCHEMAS) {
    const target = join(root, PUBLIC_SCHEMAS, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(root, source), target);
  }
}

/**
 * Refuse a checkout that cannot answer "is this version tagged?": a shallow
 * clone, a tree with no release tags, or no git repository at all. Without
 * the tags every copy would look untagged and the freeze below would pass by
 * not running.
 */
function requireReleaseTags(root, git) {
  const remedy = "fetch the release tags (a full clone, or actions/checkout with fetch-depth: 0; "
    + "locally, git fetch --unshallow --tags, or git fetch --tags when the clone is not shallow)";
  const notCheckout = () =>
    fail(`${root} is not a git checkout, so tagged mirror copies cannot be verified; ${remedy}`);
  let toplevel;
  let shallow;
  try {
    toplevel = git(["rev-parse", "--show-toplevel"]).toString("utf8").trim();
    shallow = git(["rev-parse", "--is-shallow-repository"]).toString("utf8").trim();
  } catch {
    notCheckout();
  }
  // A tree nested inside some other repository answers git with that
  // repository's tags, which say nothing about this tree's copies.
  if (realpathSync(toplevel) !== realpathSync(root)) notCheckout();
  if (shallow === "true") fail(`this checkout is shallow, so tagged mirror copies cannot be verified; ${remedy}`);
  if (git(["tag", "--list", "v*"]).toString("utf8").trim() === "") {
    fail(`this checkout has no v* release tags, so tagged mirror copies cannot be verified; ${remedy}`);
  }
}

/**
 * The canonical protocol schema bytes the release tag `v<appVersion>` carries,
 * or `null` when that version is not tagged (yet) — the normal case for the
 * open candidate, including the release script's pre-tag sync. A tag that
 * exists but does not carry the protocol is answered with empty bytes, which
 * match no recorded copy. A checkout that has no release tags to consult is
 * refused ({@link requireReleaseTags}).
 */
function gitTaggedSchema(root, appVersion, protocol) {
  const tag = `v${appVersion}`;
  const git = (args) => execFileSync("git", ["-C", root, ...args], {
    env: withoutGitContext(), stdio: ["ignore", "pipe", "ignore"],
  });
  requireReleaseTags(root, git);
  try {
    git(["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]);
  } catch {
    return null;
  }
  try {
    return git(["show", `${tag}:schemas/plugin-host-protocol/${protocol}/protocol.schema.json`]);
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Once `v<appVersion>` is tagged, that version's copy is the tag's contract,
 * published or not: the copy must be the bytes the tag carries. A candidate
 * left at a tagged version would otherwise keep absorbing protocol changes the
 * tagged app does not accept, under that app's schema URL.
 */
function checkTaggedCopy(root, relative, protocol, appVersion, bytes, taggedSchema) {
  const tagged = taggedSchema(root, appVersion, protocol);
  if (tagged === null || tagged.equals(bytes)) return;
  fail(`${relative} differs from the schema tag v${appVersion} carries; a tagged version's copy is frozen — bump package.json to the next version, regenerate the schema, and run node scripts/sync-plugin-host-protocol-mirror.mjs`);
}

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
export function checkProtocolMirror(root, { taggedSchema = gitTaggedSchema } = {}) {
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
    checkTaggedCopy(root, relative, entry.protocol, entry.appVersion, bytes, taggedSchema);
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
    if (!expected.has(path)) fail(`unrecorded copy ${path}`);
  }
  for (const path of expected) if (!found.has(path)) fail(`missing copy ${path}`);
  return `${manifest.copies.length} copies, ${Object.keys(manifest.aliases).length} aliases, ${candidates} candidate`;
}

/** Refresh only the current candidate after a version bump and schema generation. */
export function syncProtocolMirror(root, generatedFrom, { taggedSchema = gitTaggedSchema } = {}) {
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
    checkTaggedCopy(root, relative, dir.name, version, bytes, taggedSchema);
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
export function publishProtocolMirror(root, target, { taggedSchema = gitTaggedSchema } = {}) {
  const match = /^(\d+)\/(\d+\.\d+\.\d+)$/u.exec(target);
  if (!match) fail(`--publish takes <protocol>/<version>, such as 2/0.13.0, not ${target}`);
  const [, protocol, appVersion] = match;
  checkProtocolMirror(root, { taggedSchema });
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
