/**
 * The committed snapshot, held to the committed input that generates it.
 *
 * `check:model-catalog` holds the file to the generator's output; this does
 * the same inside the suite, and checks what the bytes alone cannot: the
 * snapshot verifies under its own name, every mapped provider is present,
 * the input carries no field the normalizer does not read, and the license
 * travels with the data. (`THIRD-PARTY-NOTICES.md` reproduces the same text;
 * it is documentation, which the suite does not read.) The `--fetch` path is
 * exercised offline: an injected fetch answers the downloads, and the files
 * land in a scratch root.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_CATALOG_PATHS,
  fetchAndWriteModelCatalog,
  generateModelCatalog,
  modelCatalogPricingReport,
} from "../../../../scripts/lib/model-catalog.js";
import { verifyModelCatalogDocument } from "../document.js";
import { MODELS_DEV_MODEL_FIELDS } from "../../../shared/model-catalog/normalize.js";
import { catalogProviderIds } from "../../../shared/model-catalog/provider-map.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf-8").replace(/\r\n/g, "\n");

describe("bundled model catalog", () => {
  const generated = generateModelCatalog(ROOT);

  it("is exactly what the committed input generates", () => {
    expect(generated.diagnostics).toEqual([]);
    expect(read(MODEL_CATALOG_PATHS.snapshot)).toBe(generated.text);
  });

  it("verifies under its own name and records its input", () => {
    const document = verifyModelCatalogDocument(JSON.parse(read(MODEL_CATALOG_PATHS.snapshot)));
    expect(document.provenance.source).toBe("models.dev");
    expect(document.provenance.url).toBe("https://models.dev/api.json");
    expect(document.provenance.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(document.provenance.fetchedAt)).not.toBeNaN();
  });

  it("has every provider a vendor maps to, each with models", () => {
    expect(Object.keys(generated.document.providers)).toEqual(catalogProviderIds());
    for (const [provider, { models }] of Object.entries(generated.document.providers)) {
      expect(Object.keys(models).length, provider).toBeGreaterThan(0);
    }
  });

  it("describes the Qwen and Doubao endpoints through the providers at their hosts", () => {
    const { providers } = generated.document;
    expect(Object.keys(providers["alibaba-cn"]?.models ?? {})).toEqual(expect.arrayContaining(["qwen3-max", "qwen3-coder-plus"]));
    const doubao = Object.keys(providers.volcengine?.models ?? {});
    expect(doubao.some((id) => id.startsWith("doubao-"))).toBe(true);
    // Ave's Doubao default is not listed; it stays unknown to the catalog.
    expect(doubao).not.toContain("doubao-1-5-pro-256k-250115");
  });

  it("commits only the fields the normalizer reads", () => {
    const input = JSON.parse(read(MODEL_CATALOG_PATHS.input)) as Record<string, { models: Record<string, Record<string, unknown>> }>;
    const carried = new Set<string>(MODELS_DEV_MODEL_FIELDS);
    for (const { models } of Object.values(input)) {
      for (const model of Object.values(models)) {
        expect(Object.keys(model).filter((field) => !carried.has(field))).toEqual([]);
      }
    }
  });

  it("carries the source's MIT license with the data", () => {
    const license = read(MODEL_CATALOG_PATHS.license);
    expect(generated.document.license).toEqual({
      spdx: "MIT",
      copyright: "Copyright (c) 2025 models.dev",
      repository: "https://github.com/anomalyco/models.dev",
      text: license,
    });
  });

  it("reports the hand-kept rows the catalog cannot replace", () => {
    const report = modelCatalogPricingReport(generated.document);
    expect(report).toContain("## Rows with no catalog entry");
    // Self-hosted endpoints map to no catalog provider, so their windows stay host-owned.
    expect(report).toContain("| openai-compatible | Qwen3.6-35B-A3B-NVFP4 | 262144 | 0 / 0 |");
    expect(report).toContain("| claude | claude-sonnet-4-6 | contextWindow1MBeta | 1000000 |");
  });
});

const HEAD = "a".repeat(40);
const SCHEMA_BLOB = "b".repeat(40);

type Answer = (url: string) => Response | Promise<Response>;

/** A fetch that answers each download by URL; any URL it was not given fails the test. */
function fetchFor(answers: { api: Answer; head: Answer; schema: Answer; license: Answer }) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url === "https://models.dev/api.json") return answers.api(url);
    if (url.endsWith("/commits/dev")) return answers.head(url);
    if (url.includes("/contents/packages/core/src/schema.ts")) return answers.schema(url);
    if (url.startsWith("https://raw.githubusercontent.com/anomalyco/models.dev/") && url.endsWith("/LICENSE")) return answers.license(url);
    throw new Error(`unexpected download ${url}`);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

describe("model catalog --fetch", () => {
  const roots: string[] = [];
  const scratch = () => {
    const root = mkdtempSync(join(tmpdir(), "model-catalog-fetch-"));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("re-prunes a download into the committed input byte for byte, and names the same catalog", async () => {
    const root = scratch();
    // The committed input is already pruned, so pruning it again must change nothing.
    const { fetchImpl } = fetchFor({
      api: () => new Response(read(MODEL_CATALOG_PATHS.input), { status: 200, headers: { etag: 'W/"fixture"' } }),
      head: () => json({ sha: HEAD }),
      schema: () => json({ sha: SCHEMA_BLOB }),
      license: () => new Response(read(MODEL_CATALOG_PATHS.license), { status: 200 }),
    });
    const generated = await fetchAndWriteModelCatalog(root, fetchImpl);
    expect(readFileSync(join(root, MODEL_CATALOG_PATHS.input), "utf-8")).toBe(read(MODEL_CATALOG_PATHS.input));
    expect(readFileSync(join(root, MODEL_CATALOG_PATHS.license), "utf-8")).toBe(read(MODEL_CATALOG_PATHS.license));
    expect(readFileSync(join(root, MODEL_CATALOG_PATHS.packagedLicense), "utf-8")).toBe(read(MODEL_CATALOG_PATHS.license));
    expect(JSON.parse(readFileSync(join(root, MODEL_CATALOG_PATHS.source), "utf-8"))).toMatchObject({
      url: "https://models.dev/api.json",
      etag: 'W/"fixture"',
      upstreamHeadAtFetch: HEAD,
      upstreamSchemaBlob: SCHEMA_BLOB,
    });
    // Same content, new provenance: the same catalog name as the committed snapshot.
    expect(generated.document.sha256).toBe(JSON.parse(read(MODEL_CATALOG_PATHS.snapshot)).sha256);
  });

  it("records no upstream revision when the GitHub API fails, and still writes the download", async () => {
    const root = scratch();
    const { fetchImpl, urls } = fetchFor({
      api: () => new Response(read(MODEL_CATALOG_PATHS.input), { status: 200 }),
      head: () => new Response("rate limited", { status: 403 }),
      schema: () => {
        throw new Error("the schema is not asked for without a head");
      },
      license: () => new Response(read(MODEL_CATALOG_PATHS.license), { status: 200 }),
    });
    await fetchAndWriteModelCatalog(root, fetchImpl);
    const source = JSON.parse(readFileSync(join(root, MODEL_CATALOG_PATHS.source), "utf-8")) as Record<string, unknown>;
    expect(source).not.toHaveProperty("upstreamHeadAtFetch");
    expect(source).not.toHaveProperty("upstreamSchemaBlob");
    // Without a head, the license is read from the branch.
    expect(urls).toContain("https://raw.githubusercontent.com/anomalyco/models.dev/dev/LICENSE");
    expect(readFileSync(join(root, MODEL_CATALOG_PATHS.input), "utf-8")).toBe(read(MODEL_CATALOG_PATHS.input));
  });

  it("fails on a missing license and writes nothing", async () => {
    const root = scratch();
    const { fetchImpl } = fetchFor({
      api: () => new Response(read(MODEL_CATALOG_PATHS.input), { status: 200 }),
      head: () => json({ sha: HEAD }),
      schema: () => json({ sha: SCHEMA_BLOB }),
      license: () => new Response("not found", { status: 404 }),
    });
    await expect(fetchAndWriteModelCatalog(root, fetchImpl)).rejects.toThrow(/LICENSE answered 404/);
    expect(readdirSync(root)).toEqual([]);
  });
});
