import lockfile from "proper-lockfile";
import { promises as dns } from "node:dns";
import * as fs from "node:fs";
import { appendFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { deferred } from "../../../../__tests__/support/deferred.js";

const [, , home, writer] = process.argv;
const send = process.send?.bind(process);
if (!home || (writer !== "first" && writer !== "second") || !send) throw new Error("Expected a refresh writer with an IPC channel");

const releaseResponse = deferred<void>();
if (writer === "first") {
  process.once("message", (message) => {
    if (message === "release-response") releaseResponse.resolve();
  });
} else {
  const lock = lockfile.lock;
  let notified = false;
  lockfile.lock = (path, options) => lock(path, {
    ...options,
    fs: {
      ...fs,
      mkdir(lockPath: string, callback: (error: NodeJS.ErrnoException | null) => void) {
        fs.mkdir(lockPath, (error) => {
          if (error?.code === "EEXIST" && !notified) {
            notified = true;
            send("lock-contended");
          }
          callback(error);
        });
      },
    },
  });
}

dns.lookup = (async () => [{ address: "93.184.215.14", family: 4 }]) as unknown as typeof dns.lookup;
syncBuiltinESMExports();
const { buildModelCatalogDocument } = await import("../../document-builder.js");
const { refreshModelCatalogCache, MODEL_CATALOG_REFRESH_URL } = await import("../../refresh.js");
const input = { openai: { id: "openai", models: { fixture: { id: "fixture", limit: { context: 400_000 } } } } };
const reference = buildModelCatalogDocument({
  input, providerIds: ["openai"],
  source: { url: MODEL_CATALOG_REFRESH_URL, fetchedAt: "2020-01-01T00:00:00Z", rawSha256: "0".repeat(64) },
  license: { spdx: "MIT", copyright: "Synthetic fixture", repository: "https://example.com/catalog", text: "MIT License" },
}).document;
const fetchImpl = (async () => {
  await appendFile(join(home, "requests.log"), "request\n");
  if (writer === "first") {
    send("response-held");
    await releaseResponse.promise;
  }
  return new Response(JSON.stringify(input));
}) as typeof fetch;
const result = await refreshModelCatalogCache({
  fetchImpl, dir: join(home, "cache", "model-catalog"), reference,
  now: () => new Date("2026-10-12T12:00:00Z"),
});
if (result.status === "failed") throw new Error(result.reason);
process.stdout.write(`${result.status}\n`);
