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
import { CATALOG_PROVIDERS_BY_VENDOR, catalogProviderIds } from "../../../shared/model-catalog/provider-map.js";
import { LLM_VENDORS, OPENAI_COMPATIBLE_VENDOR_PRESETS, type LLMVendor } from "../../../shared/llm-vendor-defaults.js";

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

/**
 * A vendor maps only to catalog providers that serve its own endpoint: the
 * catalog's limits are that endpoint's limits, and a provider of the same
 * models elsewhere (an international host, a different product) has others.
 * Held against the provider `api` the pruned input keeps.
 */
describe("the provider map's host rule", () => {
  /**
   * Mapped providers the catalog lists without an `api`: the source reaches
   * them through a provider-specific SDK package rather than an
   * OpenAI-compatible URL, so there is no host to compare. Each is the
   * vendor's own first-party API.
   */
  const NO_API_PROVIDERS: Readonly<Record<string, string>> = {
    anthropic: "Anthropic's API, reached through @ai-sdk/anthropic",
    openai: "OpenAI's API, reached through @ai-sdk/openai",
    google: "the Gemini API, reached through @ai-sdk/google",
    azure: "Azure OpenAI, whose host is the user's own resource",
    "google-vertex": "Vertex AI, whose host is the user's project and region",
    "google-vertex-anthropic": "Claude on Vertex AI, whose host is the user's project and region",
    xai: "xAI's API, reached through @ai-sdk/xai",
    togetherai: "Together AI's API, reached through @ai-sdk/togetherai",
    groq: "Groq's API, reached through @ai-sdk/groq",
    cerebras: "Cerebras' API, reached through @ai-sdk/cerebras",
    mistral: "Mistral's API, reached through @ai-sdk/mistral",
    vercel: "the Vercel AI Gateway, reached through @ai-sdk/gateway",
    aihubmix: "AIHubMix's API, reached through its own SDK package",
  };

  type Input = Record<string, { api?: string }>;
  const input = JSON.parse(read(MODEL_CATALOG_PATHS.input)) as Input;

  /** The endpoint Ave calls for a vendor by default, when it has one. */
  function vendorBaseUrl(vendor: LLMVendor, presets: Partial<Record<string, { baseUrl: string }>>): string | undefined {
    return Object.hasOwn(presets, vendor) ? presets[vendor]?.baseUrl : undefined;
  }

  /** Each mapping that breaks the rule, as `<vendor> → <provider>: <why>`. */
  function hostFaults(
    map: Readonly<Record<string, readonly string[]>>,
    providers: Input,
    presets: Partial<Record<string, { baseUrl: string }>> = OPENAI_COMPATIBLE_VENDOR_PRESETS,
  ): string[] {
    const faults: string[] = [];
    for (const vendor of LLM_VENDORS) {
      for (const provider of map[vendor] ?? []) {
        const api = providers[provider]?.api;
        if (api === undefined) {
          if (!Object.hasOwn(NO_API_PROVIDERS, provider)) faults.push(`${vendor} → ${provider}: the catalog states no api and no exemption says why`);
          continue;
        }
        const base = vendorBaseUrl(vendor, presets);
        if (base === undefined) {
          faults.push(`${vendor} → ${provider}: Ave has no default endpoint to hold ${api} to`);
          continue;
        }
        const catalogUrl = new URL(api);
        const vendorUrl = new URL(base);
        const path = (url: URL) => url.pathname.replace(/\/+$/, "");
        if (catalogUrl.host !== vendorUrl.host) {
          faults.push(`${vendor} → ${provider}: ${catalogUrl.host} is not ${vendorUrl.host}`);
        } else if (!["", "/v1"].includes(path(catalogUrl)) && path(catalogUrl) !== path(vendorUrl)) {
          // A path beyond the version names a product on a shared host (z.ai's coding plan).
          faults.push(`${vendor} → ${provider}: ${path(catalogUrl)} is not ${path(vendorUrl)}`);
        }
      }
    }
    return faults;
  }

  it("holds: every mapping is to a provider at the vendor's own endpoint", () => {
    expect(hostFaults(CATALOG_PROVIDERS_BY_VENDOR, input)).toEqual([]);
  });

  it("keeps no exemption for a provider that is unmapped or states an api", () => {
    const mapped = new Set(catalogProviderIds());
    for (const provider of Object.keys(NO_API_PROVIDERS)) {
      expect(mapped.has(provider), provider).toBe(true);
      expect(input[provider]?.api, provider).toBeUndefined();
    }
  });

  it("refuses a provider at another host, another product on the same host, and a dead default", () => {
    const withOthers: Input = {
      ...input,
      // A catalog provider whose endpoint is hosted in another region.
      alibaba: { api: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
    };
    expect(hostFaults({ ...CATALOG_PROVIDERS_BY_VENDOR, qwen: ["alibaba", "alibaba-cn"] }, withOthers)).toEqual([
      "qwen → alibaba: dashscope-intl.aliyuncs.com is not dashscope.aliyuncs.com",
    ]);
    expect(hostFaults({ ...CATALOG_PROVIDERS_BY_VENDOR, zai: ["zai-coding-plan"] }, withOthers)).toEqual([
      "zai → zai-coding-plan: /api/coding/paas/v4 is not /api/paas/v4",
    ]);
    // Baseten's default before it was corrected: the host does not resolve.
    const oldBaseten = { ...OPENAI_COMPATIBLE_VENDOR_PRESETS, baseten: { ...OPENAI_COMPATIBLE_VENDOR_PRESETS.baseten, baseUrl: "https://model-api.baseten.co/v1" } };
    expect(hostFaults(CATALOG_PROVIDERS_BY_VENDOR, input, oldBaseten)).toEqual([
      "baseten → baseten: inference.baseten.co is not model-api.baseten.co",
    ]);
  });
});
