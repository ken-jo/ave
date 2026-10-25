import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fixtures from `codex app-server generate-json-schema --experimental` for 0.153.4 retain request dependencies and server methods, without descriptions. */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "codex-protocol-schema");

const FILES = ["ClientRequest.json", "ServerNotification.json", "ServerRequest.json"] as const;

export function completeCodexSchemas(): Record<string, unknown> {
  return Object.fromEntries(FILES.map((name) => [
    name,
    JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as unknown,
  ]));
}
