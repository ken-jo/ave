import { promises as dns } from "node:dns";
import { appendFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

dns.lookup = (async () => [{ address: "93.184.215.14", family: 4 }]) as unknown as typeof dns.lookup;
syncBuiltinESMExports();
const { buildModelCatalogDocument } = await import("../../document-builder.js");
const { refreshModelCatalogCache, MODEL_CATALOG_REFRESH_URL } = await import("../../refresh.js");
const home = process.argv[2]!;
const input = { openai: { id: "openai", models: { fixture: { id: "fixture", limit: { context: 400_000 } } } } };
const reference = buildModelCatalogDocument({
  input, providerIds: ["openai"],
  source: { url: MODEL_CATALOG_REFRESH_URL, fetchedAt: "2020-01-01T00:00:00Z", rawSha256: "0".repeat(64) },
  license: { spdx: "MIT", copyright: "Synthetic fixture", repository: "https://example.com/catalog", text: "MIT License" },
}).document;
const fetchImpl = (async () => {
  await appendFile(join(home, "requests.log"), "request\n");
  await new Promise((resolve) => setTimeout(resolve, 100));
  return new Response(JSON.stringify(input));
}) as typeof fetch;
const result = await refreshModelCatalogCache({
  fetchImpl, dir: join(home, "cache", "model-catalog"), reference,
  now: () => new Date("2026-10-12T12:00:00Z"),
});
if (result.status === "failed") throw new Error(result.reason);
process.stdout.write(`${result.status}\n`);
