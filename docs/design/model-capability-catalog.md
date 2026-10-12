# Model capability catalog

Status: decided (issue #2501, owner decisions of 2026-10-12); being implemented in the
seven slices of §9. Slice 1 — the contract, the generator, the bundled snapshot and its
provenance — is implemented. Nothing reads the catalog yet; until slice 2 lands, every
behavior described after §4 is the plan, and the code paths named in §8 are still the
ones in force.

Anchors: `src/shared/model-catalog/` (types, provider map, normalizer),
`src/core/model-catalog/` (document hashing and verification, the bundled snapshot),
`scripts/lib/model-catalog.ts` and `scripts/generate-model-catalog.ts` (the generator),
`scripts/model-catalog/` (the committed input). Today's hand-kept tables are
`src/shared/pricing-data.ts`, `src/engine/llm/vendor-capabilities.ts` and the name
predicates in `src/engine/llm/vercel/adapter.ts`.

## 1. Problem

What Ave knows about a model — its context window, how many tokens it may produce, what
it accepts as input, how its reasoning is controlled and what it costs — lives in four
hand-kept places that disagree with each other and with the providers:

- `DEFAULT_PRICING` holds windows and prices for about 85 rows. Unknown models fall to
  `FALLBACK_PRICING` (128K window, zero price), and a zero price is read as free.
- Vision support is a pair of regex lists over model names.
- Reasoning controls are name predicates (`isOpenAIReasoningModel`,
  `supportsAdaptiveThinking`, …) in the request adapter.
- The output ceiling is a host constant (32,000) for every model; the ceiling a model
  endpoint reports (`maxOutputTokens` from `/models`) is carried and never applied, and
  the renderer's cost estimate assumes 4,096.

Every new model is a code change in several files, and a model the tables do not know
gets wrong limits silently.

## 2. Source

[models.dev](https://models.dev) (`github.com/anomalyco/models.dev`, MIT, "Copyright (c)
2025 models.dev") publishes one JSON document, `https://models.dev/api.json`, built from
per-model TOML files and validated against a zod schema
(`packages/core/src/schema.ts`). It covers every catalog provider an Ave vendor maps to.
The document carries no schema version and no revision stamp, so the generator records
the repository head and the schema file's blob at download time as the nearest revision
(§3.2), and the normalizer checks every field it reads (§3.3).

## 3. Contract (slice 1)

### 3.1 Normalized types

`src/shared/model-catalog/types.ts` — `ModelCatalogDocument`, schema version
`MODEL_CATALOG_SCHEMA_VERSION = 1`:

- `providers[providerId].models[modelId]`: `limits {context?, input?, output?}`,
  `modalities {input[], output[]}`, `attachment`, `toolCall`, `structuredOutput`,
  `temperature`, `reasoning {supported, toggle?, effort?[], budgetTokens? {min?, max?}}`,
  `interleaved` (`true` or `{field}`), `cost {input?, output?, reasoning?, cacheRead?,
  cacheWrite?, tiers?[{afterInputTokens, …rates}]}`, `status`, `releaseDate`, `family`,
  `canonicalId`.
- **Absent means unknown.** A fact the source does not state is left out: no `0` price, no
  `false` capability and no empty modality list stands in for "not stated". A token limit of
  `0` is read as not stated.
- **A listed `0` price is the source's statement, not "free".** In the full document about 650 models list zero;
  some are free tiers, many are unpriced. Cost display treats a zero price as "listed
  zero" (slice 5).
- Prices are USD per million tokens. `tiers` replace the base rates once the prompt
  exceeds `afterInputTokens`; the source's older `context_over_200k` form is read as a
  tier at 200,000 when no `tiers` are listed. Only prompt-size tiers are carried.

### 3.2 Provenance, name and license

Each document carries `provenance` — the URL, `fetchedAt`, the response `etag`, the sha256
of the raw download (`rawSha256`), the repository head (`upstreamHeadAtFetch`) and schema
blob (`upstreamSchemaBlob`) at download time, the sha256 of the pruned input
(`inputSha256`) — and `license`, the MIT text the data is distributed under. `sha256` is
the hash of the canonical JSON (sorted keys) of `schemaVersion`, `license` and `providers`:
it names the catalog's content in a run record (slice 3) and in the refresh cache
(slice 6), and lets a reader reject a damaged copy (`verifyModelCatalogDocument`).
Provenance is left out of the name on purpose: a second download of unchanged data has a
new `fetchedAt` and possibly a new ETag, and must still be the same catalog, so a cache
entry already stored under a name is kept rather than rewritten. A run record cites the
catalog by `sha256` alone; provenance says where a copy came from and is checked for shape
(`verifyModelCatalogDocument` refuses a copy whose provenance is malformed), but it is not
part of what the record names. `THIRD-PARTY-NOTICES.md` reproduces the license, and the
packaged app ships it as `licenses/models.dev/LICENSE-MIT` beside its resources
(`resources/licenses/models.dev/`, kept equal to the committed input's license by
`--check`).

### 3.3 Normalization

`normalizeModelsDevProviders` (`src/shared/model-catalog/normalize.ts`) is pure and
deterministic, so the generator and the refresh produce the same bytes from the same
input. It has two fault outcomes:

- a wrong **type** on a field the host computes with — the id, a limit, a price, a modality
  list, the reasoning flag — drops the **model**, with a diagnostic;
- an unknown **value** in an enumerated field (status, a reasoning effort, a reasoning
  control kind) or a malformed descriptive field (name, family, release date) drops only
  that **field or value**, with a diagnostic. The source adds enum values over time, and a
  new one must not make a model's known window disappear.

### 3.4 Provider map

`CATALOG_PROVIDERS_BY_VENDOR` (`src/shared/model-catalog/provider-map.ts`) is the one place
an Ave vendor id meets a catalog provider id. It is exhaustive over `LLMVendor`, so a new
vendor fails typecheck until it is placed. A vendor maps to the catalog providers whose API
host is the vendor's endpoint: Qwen and Qwen Code to `alibaba-cn` (DashScope's mainland
host, not the international `alibaba`), Doubao to `volcengine` (Ark). Copilot maps to
`[]`: Ave's Copilot vendor called GitHub Models (`models.github.ai`), which the catalog does
not list and which GitHub retired on 2026-07-30; the catalog's `github-copilot` provider is
the Copilot API (`api.githubcopilot.com`), another service. The vendor itself is being
removed (owner decision of 2026-10-12; a re-added Copilot integration is tracked in #2657 and
gets its mapping then), so it has no catalog mapping. The generic
OpenAI-compatible endpoint, local runtimes (Ollama, LM Studio) and vendors no catalog
provider serves at their endpoint (SambaNova, LiteLLM, v0, HiCap, Nous, Huawei MaaS, Ask
Sage, OCA) map to `[]`: their limits come from what the endpoint reports and what the user
configures, never from a public model that happens to share a name. A mapped vendor's model
the provider does not list stays unknown to the catalog (Doubao's default
`doubao-1-5-pro-256k-250115` is one) and falls to the next source.

The rule is held by a test against each provider's `api`, which the pruned input keeps:
every mapped provider's host is the vendor's default endpoint's host, and where the
catalog's path names a product beyond the version (z.ai's coding plan) the path matches
too. Providers the catalog lists without an `api` (the first-party APIs reached through
their own SDK packages) are listed with the reason. The vendor defaults follow the same
documents: Baseten's Model APIs are `inference.baseten.co` (the old `model-api.baseten.co`
does not resolve) and Nebius is `api.tokenfactory.nebius.com` (Token Factory, formerly AI
Studio); a stored copy of either old default is rewritten on every load
(`src/data/settings-store.ts`), and any other stored endpoint is kept.

### 3.5 Generator and committed input

`bun run generate:model-catalog` writes `src/core/model-catalog/bundled-snapshot.json`
from the committed input under `scripts/model-catalog/`:

| file | content |
| --- | --- |
| `models-dev-input.json` | the download, pruned to the mapped providers' models and to the fields the normalizer reads (`MODELS_DEV_MODEL_FIELDS`) |
| `models-dev-source.json` | URL, `fetchedAt`, `etag`, `rawSha256`, upstream head and schema blob |
| `models-dev-LICENSE.txt` | the license text at that head |

`--fetch` downloads a new input and regenerates; `--check` (run by `check:gate-core` in CI
and in the pre-push hook) fails when the snapshot differs from what the input generates;
`--report` prints the comparison of §8. Both JSON files are laid out one model per line, so
a refresh's diff is one line per changed model. `--fetch` writes nothing unless every
required download succeeded (a failed GitHub API call only leaves the upstream head and
schema blob out; a failed license download fails the run). The snapshot of 2026-10-12
holds 29 providers and 2,182 models in about 1 MB.

## 4. Resolution (slice 2)

One resolver answers each fact for a `(vendor, model)` route with a value and its source.
Precedence, per fact:

1. the user's explicit setting;
2. what the live endpoint reports (the `/models` cache);
3. refreshed catalog metadata (§7);
4. the bundled snapshot;
5. a host fallback, recorded as source `host-fallback`.

This extends `resolveModelContextWindow` (`src/shared/context-budget.ts`), whose sources
today are vendor setting, provider-reported, pricing table and fallback. The catalog key is
found by one `resolveCatalogKey(vendor, model)`: the provider map, then the exact id, then
`canonicalId`, then date-suffix normalization, then case-fold, with Ave-owned aliases in
one data file. A local or custom endpoint stays unknown unless the user names the catalog
model it serves (`llm.vendors.<v>.catalogModel`). Context-window consumers — engine
compaction, the renderer's context ring, the developer IPC — switch to the resolver; the
renderer receives the resolved values over IPC rather than bundling the JSON.

## 5. Output and reasoning (slice 3)

- **Effective output** is the smaller of the requested value — user explicit, else the
  purpose-specific limit, else the host default of 32,000 — and the model's output ceiling
  (endpoint-reported, else catalog; unknown means no clamp). The output that would still
  fit the remaining context is shown in diagnostics only; requests are not clamped by it.
- A stored `outputTokenLimit` of exactly `32000` — the old default written back — is
  migrated once to "default" and reported with source `host-default`.
- A numeric thinking budget stays below `max_tokens`. An effort value must be in the
  model's catalog list; otherwise it is lowered to the nearest supported value and the
  change is recorded in diagnostics.
- The UI and the cost estimate show the effective value and its source (replacing the
  renderer's assumed 4,096), and each run records the catalog `sha256` and the effective
  settings in its turn summary and audit entry.
- The purpose-specific small limits stay as they are: finalize 1,024; background 16,384;
  memory 1,400 / 1,600 / 4,000; work report 800 / 1,000; reviewer 256.

## 6. Modalities and pricing (slices 4 and 5)

Slice 4 replaces the vision regex lists with `modalities.input` and `attachment`, and
reads tool support from `toolCall`. Slice 5 prices through the catalog, tiers included,
and makes the renderer apply the user's pricing overrides as the engine already does;
user overrides keep the highest precedence.

## 7. Refresh (slice 6)

- Setting `llm.modelCatalog.refresh: "auto" | "off"`, default `"auto"` (owner decision);
  organization policy can force it off.
- The host fetches `https://models.dev/api.json` through `fetchPublicHttpResponse`
  (`src/core/network-guard.ts`) with a conditional ETag request, a 15 s timeout and a
  16 MB cap, prunes and normalizes it with the slice 1 code, and stores it under
  `~/.ave/cache/model-catalog/` as an immutable `<sha256>.json` plus a `current.json`
  pointer, each written temp file → fsync → rename. A failed or malformed fetch keeps the
  last known good catalog; the first launch offline uses the bundled snapshot.
- A refreshed catalog takes effect only at a lifecycle boundary — boot, or a moment with
  no active run — so one run never sees two catalogs.
- `AVE_MODEL_CATALOG=bundled|<sha256>` pins the catalog for headless runs and
  benchmarks.
- models.dev becomes a new outbound destination. The request carries no user data — it is
  a plain GET of a public document — and is documented in `architecture.md` and in the
  privacy and network pages in the same slice.

## 8. What the hand-kept table has that the catalog does not

`bun run generate:model-catalog -- --report` compares every `DEFAULT_PRICING` row with the
snapshot. Against the snapshot of 2026-10-12: 38 rows have a catalog entry, 36 of them
differ (mostly cache rates the table derives at run time, and OpenAI and Gemini rows the
table lists at zero); 47 rows have none. Slice 7 removes the table only after each of
these is answered:

- **Dated and retired ids** (`claude-sonnet-4-20250514`, `claude-3-*`, `gpt-4.1-2025-04-14`,
  `o3-2025-04-16`, `gemini-1.5-*`, …): resolved by the aliases of §4 or allowed to fall to
  the host fallback.
- **Copilot rows**: the Copilot vendor maps to no catalog provider and is being removed
  (§3.4); its rows go with it.
- **Self-hosted rows** (`openai-compatible`: `Qwen3.6-35B-A3B-NVFP4` 262,144,
  `Nemotron-3-Nano-30B-A3B-FP8` 131,072): the vendor maps to no catalog provider by design;
  these windows come from the endpoint's report or the user's setting.
- **Fields with no catalog counterpart:**
  - `contextWindow1MBeta` (Claude Sonnet 4.6 and Opus 4.6, also under Copilot) — the
    catalog lists these models at 1M with no note that 1M needs a beta header. That is a
    request-shape fact, and it moves to a host-owned request-shape table with the
    interleaved-thinking handling (slice 7).
  - `surchargeInputThreshold` / multipliers (GPT-5.4 and 5.4 Pro) — the catalog states the
    same prices as a tier at 272,000 (2× input, 1.5× output) and slice 5 reads the tier.
  - `tpmDefault` (GPT-5.4 mini and nano) — a host throttling default, kept in the
    host-policy module.

Host-owned values stay in that module: the 32,000 default output, the 128K fallback window,
`MAX_CREDIBLE_CONTEXT_WINDOW`, `tpmDefault` and the request-shape features.

## 9. Slices

Each slice is one pull request against `main`, opened in order:

1. Contract, generator, bundled snapshot with provenance, normalization and validation
   tests, the comparison report, this page, the third-party notice. No behavior change.
2. Resolver (precedence, aliases, local endpoints) and the context-window consumers.
3. Effective output and reasoning, the 32,000 migration, the adapter cutover, run records.
4. Modalities and tool capability.
5. Pricing through the catalog, renderer overrides.
6. Refresh, the setting and policy, `AVE_MODEL_CATALOG`, the network documentation.
7. Removal of the superseded tables and predicates, the request-shape table, documentation.

This page goes stale when a slice changes what it describes; update it in that slice's
commit.
