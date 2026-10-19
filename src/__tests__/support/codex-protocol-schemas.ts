import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generated app-server schema documents, trimmed from what `codex app-server
 * generate-json-schema --experimental` wrote for 0.153.4: the client requests
 * Ave sends with every definition they reference, and the method names of
 * every server notification and request. Descriptions are dropped; the shapes
 * ($ref chains, nullable unions, tagged variants) are the generator's own.
 */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-protocol-schema");

const FILES = ["ClientRequest.json", "ServerNotification.json", "ServerRequest.json"] as const;

/** A fresh, mutable copy of the complete fixture set, keyed by file name. */
export function completeCodexSchemas(): Record<string, unknown> {
  return Object.fromEntries(FILES.map((name) => [
    name,
    JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as unknown,
  ]));
}
