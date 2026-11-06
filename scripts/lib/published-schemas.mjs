import { copyFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const AVE_SCHEMA_ORIGIN = "https://ave.agent-connector.ai";
const PUBLIC_SCHEMAS = "web/public/schemas";

/** The `$id` of a schema Ave publishes, given its path under `/schemas/`. */
function aveSchemaId(relative) {
  return `${AVE_SCHEMA_ORIGIN}/schemas/${relative}`;
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
  ["schemas/worker-stdio-control/1/worker-control.schema.json", "worker-stdio-control/1/worker-control.schema.json"],
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
 * public tree serves the canonical bytes there. The public schema tree holds nothing else.
 */
export function checkPublishedSchemas(root) {
  const expected = new Set();
  for (const { source, path, id } of PUBLISHED_SCHEMAS) {
    const bytes = readFileSync(join(root, source));
    if (JSON.parse(bytes.toString("utf8")).$id !== id) fail(`${source} must have $id ${id}`);
    const served = join(root, PUBLIC_SCHEMAS, path);
    if (!existsSync(served) || !bytes.equals(readFileSync(served))) {
      fail(`${PUBLIC_SCHEMAS}/${path} differs from ${source}; run copy the canonical schema to its public path`);
    }
    expected.add(path);
  }
  for (const path of walkFiles(join(root, PUBLIC_SCHEMAS))) {
    if (expected.has(path)) continue;
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

function fail(message) { throw new Error(`published schemas: ${message}`); }
