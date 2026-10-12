# Model capability catalog

Status: decided (issue #2501, owner decisions of 2026-10-12); being implemented in the
seven slices of §9. Slices 1 (the contract, the generator, the bundled snapshot and its
provenance), 2 (context windows, §4) and 3 (output limits, reasoning levels and run
records, §5) are implemented. §6–§7 are the plan; until their slices land, modalities
and prices still come from the code paths named in §1 and §8.

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
entry already stored under a name is kept rather than rewritten.
`THIRD-PARTY-NOTICES.md` reproduces the license.

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
vendor fails typecheck until it is placed. The generic OpenAI-compatible endpoint, local
runtimes (Ollama, LM Studio) and vendors with no catalog provider map to `[]`: their limits
come from what the endpoint reports and what the user configures, never from a public
model that happens to share a name.

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
a refresh's diff is one line per changed model. The snapshot of 2026-10-12 holds 28
providers and 2,110 models in about 950 KB.

## 4. Resolution (slice 2)

One resolver answers each fact for a `(vendor, model)` route with a value and its source.
Precedence, per fact:

1. the user's explicit setting;
2. what the live endpoint reports (the `/models` cache);
3. refreshed catalog metadata (§7);
4. the bundled snapshot;
5. a host fallback, recorded as source `host-fallback`.

**Implemented for the context window (slice 2).** `resolveModelContextWindow`
(`src/shared/context-budget.ts`) now answers, in order: `vendor-setting` (declared
`llm.vendors.<v>.contextWindow`), `provider-reported` (the route's `/models` row),
`model-catalog` (with `catalogEntry`, the `<provider>/<id>` that answered),
`pricing-catalog` (the hand-kept table, for a model the catalog does not know; slice 7
removes it) and `fallback` (128K). Refreshed metadata joins in slice 6, above the bundled
snapshot.

The catalog key is found by one `resolveCatalogKey(catalog, vendor, model)`
(`src/shared/model-catalog/resolve.ts`), across the vendor's providers in map order: the
exact id; an Ave alias (`src/shared/model-catalog/aliases.ts`, empty today — every
vendor id the snapshot can describe is found by the other steps, and an alias may only
join two ids documented to name one model); an entry whose `canonicalId` is the id;
the id without a release-date suffix; the id with case and version separators folded
(`claude-sonnet-4-6` → Copilot's `claude-sonnet-4.6`); the same ignoring a path prefix
on either side (`openai/gpt-5.4` → Requesty's `gpt-5.4`). The folded, prefix and
canonical steps answer only when exactly one entry matches.

A self-hosted or local endpoint is never matched by name. The user can name the entry it
serves as `llm.vendors.<v>.catalogModel` (`<provider>/<id>`, `settings.json` only, like
`contextWindow`); a named entry that is not in the catalog answers nothing rather than
falling back to a name match, and it applies to the vendor block's own model, not to a
marketplace preset reached through the same vendor.

Each process installs one catalog (`src/shared/model-catalog/active.ts`), and reading
before install throws. Main and headless install the verified bundled snapshot at the
start of `bootstrapCoreServices`; the snapshot is a dynamic import, so its data lands in
an async chunk instead of the main bundle's initial budget. The renderer asks main for
that copy over `ave:llm:get-model-catalog` and installs it before it mounts
(`src/ui/renderer/model-catalog-bootstrap.ts`), so the first settings snapshot the
context ring resolves is resolved against the engine's catalog. Tests install the
bundled snapshot in a setup file (`src/__tests__/vitest-model-catalog.ts`).

Windows the snapshot of 2026-10-12 changes against the table (the rest agree): GPT-5.4
Pro 1.1M → 1,050,000; GPT-4.1, 4.1 mini and nano 1M → 1,047,576; Gemini 2.5 Pro and Flash
1M → 1,048,576, Gemini 2.5 Flash-Lite 128K → 1,048,576; Copilot GPT-5 mini 400K →
264,000 and Copilot Claude Sonnet 4.6 1M → 200,000 (the table applied Anthropic's 1M
beta window to the Copilot row; the catalog lists Copilot's own window). Claude Sonnet and Opus 4.6 stay at 1M: the
catalog lists the window the adapter's beta header already delivers, and the decision to
send that header stays on the table until slice 7.

## 5. Output and reasoning (slice 3)

Implemented.

- **Effective output.** `resolveContextWindowForRoute(...).output` (`ResolvedOutputTokenLimit`)
  is the smaller of the requested value and the model's output ceiling, with both
  sources:
  - requested: the vendor block's `outputTokenLimit` when the user set one (`user`),
    else the host default of 32,000 (`host-default`);
  - ceiling: the endpoint's `/models` `maxOutputTokens` (`provider-reported`, which was
    carried and never applied before), else the catalog's `limits.output`
    (`model-catalog`); unknown clamps nothing;
  - `effectiveSource` is the requester when the request fit, the ceiling's source when
    it was clamped.

  The conversation loop sends `output.effective` with the thinking budget bounded
  against it (`src/engine/turn/round-llm-settings.ts`). The adapter also clamps every
  request to the catalog ceiling, which is where the purpose-specific limits — finalize
  1,024; background 16,384; memory 1,400 / 1,600 / 4,000; work report 800 / 1,000;
  reviewer 256, all unchanged — meet it. Those callers do not see an endpoint-reported
  ceiling, only the catalog's.
- **The default is no longer written into settings.** A vendor block stores
  `outputTokenLimit` only when the user set it; the default block has none. Before,
  every saved block carried the materialized 32,000, so a stored 32,000 could not say
  whether the user chose it. The one-time migration `llm-output-token-limit-default`
  drops a stored exactly-32,000 once; a 32,000 set afterwards is kept, and fresh
  installs start with the marker applied.
- **Remaining context** — the output the window still had room for after the turn's
  projected next input — is recorded in the turn summary only
  (`modelSettings.remainingContextOutputTokens`); no request is clamped by it.
- **Reasoning** (`src/engine/llm/reasoning-plan.ts`, `planReasoning`). Where the catalog
  knows the model, it decides whether an OpenAI-family route (OpenAI, Copilot, Azure)
  sends `reasoning_effort` and at what level. The level Ave's budget maps to is sent if
  the model accepts it, else the nearest accepted level below it, else the lowest
  accepted. An adaptive Claude effort is held to the model's accepted levels the same
  way. Where the catalog does not know the model, the previous name rules decide (slice 7
  removes them). Request shape stays a host rule: adaptive vs numeric Claude thinking,
  interleaved numeric thinking, and the Responses-vs-Chat routing. The catalog lists
  effort levels for models that take numeric thinking and carries no interleaving flag
  for Anthropic. Numeric budgets keep the adapter's existing rule: below `max_tokens`,
  except with interleaved thinking, where the provider allows the budget to span the
  turn. Behavior changes against the bundled snapshot: GPT-5 sends `minimal` (was `low`)
  and GPT-5.1 sends `none` (was `low`) for a budget at or below 500; a model the catalog
  marks as not reasoning gets no effort. A reasoning model whose levels the catalog does
  not list (Copilot `gpt-5.4-nano`) keeps the name rule: absent levels are unknown, not
  none.
- **Run records.** The turn summary and the audit `turn` row carry `modelSettings`
  (`src/shared/run-model-settings.ts`): the catalog `sha256`, the window and its source
  and entry, the output block above, and the reasoning plan as sent. It is omitted for
  subscription runtimes and for a turn a fallback served on another model.
- **UI.** The renderer's cost estimate assumes `output.effective` (it assumed a fixed
  4,096) and the estimate tooltip names who set the limit.

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
snapshot. Against the snapshot of 2026-10-12: 42 rows have a catalog entry, 40 of them
differ (mostly cache rates the table derives at run time, and OpenAI and Gemini rows the
table lists at zero); 43 rows have none. Slice 7 removes the table only after each of
these is answered:

- **Dated and retired ids** (`claude-sonnet-4-20250514`, `claude-3-*`, `gpt-4.1-2025-04-14`,
  `o3-2025-04-16`, `gemini-1.5-*`, …): resolved by the aliases of §4 or allowed to fall to
  the host fallback.
- **Copilot rows** the `github-copilot` provider does not list: resolved by aliases to the
  originating model, or left to what the endpoint reports.
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
