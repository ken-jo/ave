# Model capability catalog

Status: decided (issue #2501, owner decisions of 2026-10-12); implemented in the seven
slices of §9: the contract, the generator, the bundled snapshot and its provenance (1),
context windows (2, §4), output limits, reasoning levels and run records (3, §5), images
and tools (4, §6), prices (5, §6), refresh (6, §7), and the removal of the hand-kept
table and name rules with the host-policy module that keeps what the catalog cannot say
(7, §8).

Anchors: `src/shared/model-catalog/` (types, provider map, normalizer),
`src/core/model-catalog/` (document hashing and verification, the bundled snapshot),
`scripts/lib/model-catalog.ts` and `scripts/generate-model-catalog.ts` (the generator),
`scripts/model-catalog/` (the committed input), `src/shared/model-pricing.ts` (price
resolution, §6), `src/shared/model-host-policy.ts` (host-owned defaults and the
request-control projection, §8).

## 1. Problem

What Ave knew about a model — its context window, how many tokens it may produce, what
it accepts as input, how its reasoning is controlled and what it costs — lived in four
hand-kept places that disagreed with each other and with the providers:

- `DEFAULT_PRICING` held windows and prices for about 85 rows. Unknown models fell to
  `FALLBACK_PRICING` (128K window, zero price), and a zero price was read as free.
- Vision support was a pair of regex lists over model names.
- Reasoning controls were name predicates (`isOpenAIReasoningModel`,
  `supportsAdaptiveThinking`, …) in the request adapter.
- The output ceiling was a host constant (32,000) for every model; the ceiling a model
  endpoint reports (`maxOutputTokens` from `/models`) was carried and never applied, and
  the renderer's cost estimate assumed 4,096.

Every new model was a code change in several files, and a model the tables did not know
got wrong limits silently.

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
  zero": it is not shown as $0, and the estimate says the catalog listed it (§6).
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
host, not the international `alibaba`), Doubao to `volcengine` (Ark). Removed vendors
have no entry in the map; an unrelated catalog service cannot re-enable them. The generic
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
and in the pre-push hook) fails when the snapshot differs from what the input generates.
(A `--report` mode compared the hand-kept table with the snapshot for §8; it went with the
table in slice 7.) Both JSON files are laid out one model per line, so
a refresh's diff is one line per changed model. `--fetch` writes nothing unless every
required download succeeded (a failed GitHub API call only leaves the upstream head and
schema blob out; a failed license download fails the run). The snapshot of 2026-10-12
holds 29 providers and 2,182 models in about 1 MB.

## 4. Resolution (slice 2)

One resolver answers each fact for a `(vendor, model)` route with a value and its source.
Precedence, per fact, using one catalog document selected at boot (§7):

1. the user's explicit setting;
2. what the live endpoint reports (the `/models` cache);
3. metadata from the selected catalog;
4. a host fallback, recorded as source `host-fallback`.

A field absent from a refreshed catalog does not consult the bundled copy. The host
fallbacks are in `src/shared/model-host-policy.ts` (§8).

**Implemented for the context window (slice 2).** `resolveModelContextWindow`
(`src/shared/context-budget.ts`) now answers, in order: `vendor-setting` (declared
`llm.vendors.<v>.contextWindow`), `provider-reported` (the route's `/models` row),
`model-catalog` (with `catalogEntry`, the `<provider>/<id>` that answered) and `fallback`
(`FALLBACK_CONTEXT_WINDOW`, 128K). Until slice 7 the hand-kept table answered as
`pricing-catalog` between the catalog and the fallback. Refreshed metadata (slice 6) joins as a whole
document, not per fact: a verified refreshed copy no older than the bundled snapshot
replaces it at boot (§7), so `model-catalog` answers from whichever catalog is in force and
a run record's `modelCatalogSha256` names it.

**The prompt cap.** Beside the window the resolver reports the model's prompt cap when the
catalog states one below it (`inputLimit`, `inputLimitSource: "model-catalog"`, from
`limits.input`). No `/models` endpoint Ave calls reports a prompt cap apart from the
window (a gateway's `max_input_tokens` is read as the window), so the catalog is the only
source. `catalogEntry` also identifies a catalog-supplied prompt cap beside an
endpoint-reported window; preflight traces retain that entry, the cap value and its
source for both API and subscription budgets. A declared window carries none. The usable budget is
`min(window − Ave's output reservation, prompt cap)` and the compaction threshold is 80%
of it (`getUsableContext`, `getPreflightThreshold`), in the engine and in the renderer's
context ring alike; a threshold the cap lowered is traced as `thresholdSource:
"input-limit"`. Before, the threshold came from the window alone: GPT-5.2 (400K window,
272K prompt) compacted at 288,000, past what the endpoint accepts, and about 100 snapshot
entries had a threshold above their cap. Now none do (a test holds every entry
to it).

The catalog key is found by one `resolveCatalogKey(catalog, vendor, model)`
(`src/shared/model-catalog/resolve.ts`), across the vendor's providers in map order: the
exact id; an Ave alias (`src/shared/model-catalog/aliases.ts`, empty today — every
vendor id the snapshot can describe is found by the other steps, and an alias may only
join two ids documented to name one model); an entry whose `canonicalId` is the id;
the id without a release-date suffix (`-YYYYMMDD`, `-YYYY-MM-DD`, or `-MMDD` with a valid
month and day); the id with case and version separators folded
(`claude-sonnet-4-6` against a listed `claude-sonnet-4.6`); the same ignoring a path prefix
on either side (`openai/gpt-5.4` → Requesty's `gpt-5.4`). The alias step also drops a
Vertex version tag (`@default`, `@20250929`) from either side, since Vertex lists Claude as
`claude-opus-4-6@default` and Ave names it `claude-opus-4-6`. The version-tag, folded,
prefix and canonical steps answer only when exactly one entry matches.

A self-hosted or local endpoint is never matched by name. The user can name the entry it
serves as `llm.vendors.<v>.catalogModel` (`<provider>/<id>`, `settings.json` only, like
`contextWindow`); a named entry that is not in the catalog answers nothing rather than
falling back to a name match, and it applies to the vendor block's own model, not to a
marketplace preset reached through the same vendor. The engine logs a named entry the
catalog does not list once per route and name, so a typo does not pass silently.

An API child with a profile model resolves the same route using that model, preserving
the endpoint and credential scope. It does not inherit a named entry for the parent's
model. That identity drives provider construction, preflight and usage accounting.

**A custom `baseUrl` must establish model identity.** A mapped vendor matches by name
only in its native public-model namespace, including documented regional and
certificate-authenticated API hosts. A different
host may serve a different deployment under the same id: a gateway exposing `gpt-5.2` for
a 64K deployment and listing only that id does not establish the public model's 400K
window or 272K prompt cap. Name uniqueness within the catalog cannot identify what the
gateway runs. Implicit catalog limits are skipped there;
absent a declaration or endpoint report, the source is explicitly `fallback`, and the
engine probes the endpoint for metadata. The 128K fallback remains a guess; a deployment
that reports no limits needs an explicit capacity setting. A product-specific path also must match where
the same host serves multiple catalog products.

`azure-foundry` addresses deployment aliases, which may reuse any public model id.
Its resource hostname does not identify the deployed model: use an endpoint report,
`catalogModel`, or `contextWindow`. `vertex-ai` derives its actual endpoint from the
SDK's project and location. Its capacity comes from explicit settings or native
catalog metadata. Standard `/models` cache reports and background probes are excluded
because they target a generic endpoint rather than the SDK-managed route.

A proxy serving the catalog model can declare `catalogModel` to select that entry,
including its prompt cap. This setting wins over automatic catalog name matching; an
endpoint-reported window still outranks the entry's context limit. A declared
`contextWindow` outranks both and carries no inferred prompt cap. These distinctions
apply equally to native and custom endpoints.

Each process installs one catalog (`src/shared/model-catalog/active.ts`), and reading
before install throws. Main and headless install the verified boot-selected catalog at the
start of `bootstrapCoreServices`; the bundled snapshot is a dynamic import, so its data lands in
an async chunk instead of the main bundle's initial budget. The renderer asks main for
that copy over `ave:llm:get-model-catalog` and installs it before it mounts
(`src/ui/renderer/model-catalog-bootstrap.ts`), so the first settings snapshot the
context ring resolves is resolved against the engine's catalog. If main cannot hand it
over, main logs why and answers a refusal, and the window shows that the app cannot start
and offers a reload instead of staying blank. Tests install the bundled snapshot in a
setup file (`src/__tests__/vitest-model-catalog.ts`); one test empties it and runs boot's
own install step (`installBundledModelCatalog`), so a boot that resolved a model before
installing one would fail there.

Windows the snapshot of 2026-10-12 changed against the table (the rest agreed): GPT-5.4
Pro 1.1M → 1,050,000; GPT-4.1, 4.1 mini and nano 1M → 1,047,576; Gemini 2.5 Pro and Flash
1M → 1,048,576, Gemini 2.5 Flash-Lite 128K → 1,048,576. Claude Sonnet and Opus 4.6 stay at
1M. The advertised 1M window is the default, so no context-window beta header is
sent. Models absent from the catalog take the fallback described in §8.

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
  against it (`src/engine/turn/round-llm-settings.ts`). The adapter uses that same
  resolved ceiling when supplied; other requests meet the eligible catalog ceiling
  under the endpoint-identity rule in §4. That is where the purpose-specific limits — finalize
  1,024; background 16,384; memory 1,400 / 1,600 / 4,000; work report 800 / 1,000;
  reviewer 256, all unchanged — meet it. Those callers do not see an endpoint-reported
  ceiling, only the catalog's. A fallback model does not inherit the primary route's
  resolved ceiling or named identity: `streamWithFallback` drops them, restores the
  original requested output, and the adapter applies the fallback model's own ceiling.
  The original thinking budget is bounded against that fallback's effective output.
  A chat route also carries an explicitly unknown ceiling, so the adapter cannot
  replace the record's unknown answer with a different name match.
- **The default is no longer written into settings.** A vendor block stores
  `outputTokenLimit` only when the user set it; the default block has none. Before,
  every saved block carried the materialized 32,000, so a stored 32,000 could not say
  whether the user chose it. A value the user sets through settings is stamped
  `outputTokenLimitSetByUser: true` (clearing the limit clears the stamp). Every load
  drops a stored 32,000 that carries no stamp. This is not a one-time migration: an
  older build reinstalled after this one writes the unstamped 32,000 back, and a
  marker already on disk would leave it there.
- **Remaining context** — the output the window still had room for after the turn's
  projected next input — is recorded in the turn summary only
  (`modelSettings.remainingContextOutputTokens`); no request is clamped by it.
- **Reasoning** (`src/engine/llm/reasoning-plan.ts`, `planReasoning`). Where the catalog
  resolves an identity, the route carries its endpoint and eligible named entry
  into the plan and adapter together. A child or preset does not inherit the
  generic row's named entry, and an SDK-managed route ignores a dormant endpoint.
  Where the catalog
  knows the model, it decides whether an OpenAI-family route (OpenAI, Azure) sends
  `reasoning_effort` and at what level. The selected rung is sent if
  the model accepts it, else the nearest accepted level below it, else the lowest
  accepted. An adaptive Claude effort is held to the model's accepted levels the same
  way. Where nobody states the levels — the catalog does not know the model, lists no
  levels for it, or the route's endpoint does not establish its identity (§4: a custom
  `baseUrl` or an Azure deployment alias) — an
  OpenAI-family request carries no `reasoning_effort`, and the plan says so
  (`kind: "none"`, `source: "host-fallback"`, with the requested level). Such a request
  also asks for no reasoning summary, so the conversation loop logs it once per route
  when thinking is on, naming `llm.vendors.<vendor>.catalogModel`. A level guessed
  from a name is a 400 on a model that does not take it; naming the entry with
  `catalogModel` supplies the levels. Until slice 7 name rules (`isOpenAIReasoningModel`,
  `supportsReasoningEffortNone`) guessed one. Request controls now read catalog
  metadata too: a declared `budgetTokens` selects numeric thinking, including
  entries that also declare effort; qualitative-only reasoning selects adaptive
  thinking. An unknown entry gets no inferred thinking control. Numeric
  interleaving requires an explicit `interleaved: true` declaration; otherwise
  no beta opt-in is sent. Numeric budgets remain below `max_tokens`, except
  with declared interleaving, where the budget can span the
  turn. The shared [rung ladder](../../src/shared/reasoning-effort.ts) defines
  low, medium, high, xhigh and max intent. Settings retain the original token
  budget; exact presets recover their rung, while custom budgets choose the
  closest rung with ties downward. Thinking off remains a separate switch.
  The round carries that key before output limits bound numeric controls.
  Qualitative sliders retain all four ordinary rungs regardless of output
  limits, and show max only when the selected catalog entry accepts it.
  Numeric sliders remain bounded by output; max corresponds to 64,000 tokens
  before numeric request limits apply. Unknown internal effort values fail
  rather than selecting a different rung. A reasoning model whose levels are
  unknown receives no guessed effort.
  Reported controls select the request protocol. Native reasoning models use
  the response protocol, which accepts effort with tools. A custom endpoint
  retains the chat protocol unless its report explicitly names the response
  control; a catalog identity alone does not establish protocol support.
  Explicitly reported effort is preserved on tool turns rather than suppressed
  by an inferred model-family restriction.
- **Run records.** The turn summary and the audit `turn` row carry `modelSettings`
  (`src/shared/run-model-settings.ts`): the catalog `sha256`, the window and its source
  and entry, the prompt cap that bounded the budget when one did (§4), the output block
  above, and the reasoning plan for the last primary request started. A retry
  that drops tools recomputes that plan at the dispatch boundary, after runtime and
  cancellation guards pass. A named catalog identity also identifies the model
  family for capability resolution, even when the route uses a deployment alias.
  It is omitted for subscription runtimes and when the last request used a fallback,
  even if its provider and model match the primary: that attempt resolves generation
  limits again. A later primary request records its own resolution at dispatch.
  The output block records the route's resolution, which also bounds the UI estimate.
  Native serialization can narrow it further to a transport-known model limit,
  except that an endpoint-reported ceiling outranks the SDK's model-name table and is
  sent as resolved.
  Its serialized output and thinking limits are recorded as `requestControls`; the
  recorded numeric reasoning budget is updated to that serialized value. The original
  output resolution and its sources remain available beside those request controls.
- **UI.** The renderer's cost estimate shows a range. The upper end is the cost with
  the output at `output.effective` (before, it assumed a fixed 4,096), and the tooltip
  names who set the limit. The lower end, and the color tier, use the expected output:
  the mean output of this conversation's last five completed turns, bounded by the
  limit, or no output before the first turn completes. Tiering on the limit would
  color a typical turn several times dearer than it is; a fixed guess would ignore how
  this conversation actually runs.

### 5.1 Reasoning an endpoint reports (slice 7 follow-up, owner direction 2026-10-13)

`resolveReasoningSupport` (`src/shared/context-budget.ts`) is the one answer to "does this
route's model reason" for the settings chooser and the engine, in the style of
`resolveToolCallSupport`. Precedence: the user's named `catalogModel` entry; then the
endpoint's `/models` report — a reasoning parameter in `supported_parameters`
(`reasoning`, `reasoning_effort`, `include_reasoning`, preferred in that order) or an
`internal_reasoning` price; then the catalog where the route establishes the model; else
nobody states it (the host fallback). A report that names no reasoning parameter is not a
denial. The route carries the answer (`RouteModelCapabilities.reasoning`) into the round
settings, and `planReasoning` plans from it; a routeless call (a fallback) asks the
catalog alone. Plans the report decides have source `endpoint-report`.

What is sent, and why each is justified:

- **Commercial OpenAI-compatible routes** (OpenRouter and the other preset gateways and
  vendors; plan kind `endpoint-reasoning`) send only the parameter their own report
  names. `reasoning` → `reasoning: { effort }`, OpenRouter's unified object, which its
  reasoning guide recommends and which is the only control for Anthropic models there;
  `reasoning_effort` → `reasoning_effort: <level>`, the OpenAI-style enum OpenRouter's
  parameter reference also accepts (`xhigh … minimal, none`); `include_reasoning` only →
  `include_reasoning: true`, which OpenRouter defines as equivalent to `reasoning: {}`.
  A report with only an `internal_reasoning` price sends nothing (`kind: "none"`). The
  catalog never chooses a parameter here, so a catalogued model behind such an endpoint
  sends what the report says or, without a report, nothing, as before.
  Sources: `https://openrouter.ai/docs/guides/best-practices/reasoning-tokens`,
  `https://openrouter.ai/docs/api/reference/parameters`,
  `https://openrouter.ai/docs/guides/overview/models` (fetched 2026-10-13).
- **The level.** The report names a parameter, not the levels. The selected
  rung is preserved unless an eligible catalog identity declares accepted
  levels, in which case the same nearest-accepted-level rule applies.
  Numeric budgets are never sent through effort controls.
- **OpenAI-family routes** (OpenAI, Azure) send `reasoningEffort`, which the SDK writes
  as `reasoning.effort` on the Responses wire and `reasoning_effort` on Chat
  Completions; a report decides only when it names that wire's parameter (`reasoning`
  or `reasoning_effort`), otherwise the plan is `none` from `endpoint-report`.
- **The self-hosted class** (`openai-compatible`, LiteLLM, Ollama, LM Studio) keeps its
  own switch and budget (`chat_template_kwargs.enable_thinking`, both budget spellings)
  and gets no reported parameter.

The engine's warning (`warnUnstatedReasoningOnce`) fires only for a `host-fallback` plan,
so never when a report states reasoning. The chooser's reasoning badge reads the same
resolver (before, a separate reading of the live report); a model whose thinking would
send no effort because nobody states its levels — the engine's own `planReasoning`
answering `host-fallback` — is marked in the model and fallback pickers with an "Effort
unknown" badge (`llmTab.modelReasoningUnstated*`, en/ko, the "No tools" pattern), whose
help names the remedy: `llm.vendors.<vendor>.catalogModel` in the settings file. The
badge shares the row's first line with "No tools"; a CDP check at phone and desktop
widths measured no overflow.

## 6. Modalities and tools (slice 4), pricing (slice 5)

Slice 4 is implemented.

- **Images.** `supportsVision` (`src/engine/llm/vendor-capabilities.ts`) answers from the
  model's stated input modalities: an `image` in them allows images on the turn, and its
  absence refuses the send. The order is:
  1. the user's **Settings → Model → Image input** declaration for this model and
     provider route; if undeclared, the input list of the entry explicitly named with `catalogModel`;
  2. the endpoint's `/models` report (`inputModalities`; an empty list states nothing);
  3. the catalog entry's `modalities.input` for the model id, matched by name only
     where the endpoint establishes the model's identity (§4);
  4. nobody states the modalities: the turn may not carry images. Until slice 7 regex
     lists over model names (`supportsVisionByName`) guessed here.

  **Image input** defaults to **Automatic**, which applies that order. **Supported**
  and **Not supported** are stored in `llm.vendors.<vendor>.imageInput`, keyed by the
  serialized pair `[presetId or "", modelId]`. Declarations are merged per key;
  returning to Automatic clears only that model's declaration. A preset's declaration
  cannot change another preset or the generic provider. It changes image support only,
  retaining other reported modalities and leaving context, output and tools alone.

  A stated catalog input list without `image`, including an empty list, refuses images.

  `resolveContextWindowForRoute(...).inputModalities` carries steps 1–3 for the active
  route. The renderer passes it to the composer and the send path, which refuse on the
  same condition. A named entry missing from the catalog states nothing: the endpoint
  report can still answer, else nothing is stated, without another automatic catalog match.
  The settings vision badge uses the same resolver with the row's saved declarations,
  named entry and saved endpoint report.
  The API transport checks the same resolved route before sending any user or
  tool-result image, including direct calls and replayed history. A caller without a
  route uses the catalog under the same endpoint-identity rule. A fallback resolves its own model rather than
  inheriting the primary route's reported or named capabilities.
  A transport refusal carries `image-input-unsupported`; the stream collector
  presents localized recovery guidance for retained conversation images and
  keeps the refusal classified as a model error. Both this error and the composer
  refusal name **Settings → Model → Image input → Supported** for a custom model
  whose image support was not detected; the default is not loosened.
- **Not `attachment`.** The catalog's `attachment` flag says a model accepts file parts.
  The composer sends a file as a path the agent reads with its tools, never as a file part,
  so the flag decides nothing here.
- **Tools.** A route whose resolved tool capability is false gets no tool definitions,
  on every rebuild within the turn (`rebuildTurnToolSchemas` in
  `src/engine/turn/query-loop.ts`). Its turn record carries
  `modelSettings.tools: { sent: false, source: "model-catalog", catalogEntry }`.
  - Absent `toolCall` is unknown, and tools are sent as before. A same-name model at a
    custom endpoint is not matched to the catalog by name (§4), so it keeps its tools.
  - A tool capability the user explicitly names with `catalogModel` wins over the
    endpoint report, including a no-tools entry when the endpoint reports `tools`.
    Otherwise an endpoint's explicit `tools` in `supported_parameters` overrides a catalog denial with
    `{ supported: true, source: "provider-reported" }`. A missing `tools` is not a
    denial and leaves the catalog answer intact.
  - The model picker shows a localized **No tools** badge only when this same resolved
    capability withholds tools. Its accessible name and tooltip explain that tools are
    not sent to the model. It uses the row's saved endpoint report and the vendor route's
    named catalog entry, excluding that named entry for marketplace presets. A pending
    or failed cache save keeps the badge on the saved capability: a new positive report
    hides it only after settings confirm the save. Subscription
    runtimes own their tools and do not receive this API-route badge. The fallback picker
    uses its model's catalog capability under its vendor block's saved endpoint, as the
    fallback transport does. There is no
    composer notice.
  - The rule follows the route's model. A fallback that serves the turn on another model
    gets the same offered tool list, bounded by its own catalog capability at the API
    transport; fallback calls carry no endpoint capability report. Direct calls apply
    that transport check too. A primary route's named
    capability travels with the request so the transport cannot replace it with a
    conflicting name match.
    A fallback cannot regain tools the primary withheld. The turn's `modelSettings`
    is omitted when the last request used a fallback (§5), so a primary model's
    omission is never recorded as the fallback's capability.

**Pricing (slice 5) is implemented.** `resolveModelPricing(vendor, model, overrides)`
(`src/shared/model-pricing.ts`) is the one place the price sources are ordered, and
answers the rates with their source:

1. `user` — a correction for this exact vendor and model (`llm.pricingOverrides`, or
   `AVE_PRICING_OVERRIDE`, which replaces the whole list). It states what the
   deployment pays and is taken whole: no catalog tier or reasoning rate is mixed in,
   and a stated zero is a known $0.
2. `endpoint-report` — the prices the route's own `/models` answer reported for the model
   (slice 7 follow-up), where the route does not establish the catalog's identity for it
   (`allowsImplicitModelLimits` fails: Azure, a custom `baseUrl`) or the catalog has no
   price for it (an unmapped self-hosted, local or gateway endpoint, or an uncatalogued
   id). The report follows OpenRouter's convention: USD per token as decimal strings
   (`"0.0000025"` is $2.50 per million); `prompt`, `completion`, `input_cache_read`,
   `input_cache_write` and `internal_reasoning` map to the input, output, cache and
   reasoning rates. Both prompt and completion must parse as non-negative numbers
   (OpenRouter's `-1` for a router is not a price), a zero for both is not a price, and
   an extra rate that does not parse is dropped. OpenRouter's `overrides` tiers are not
   read. The engine prices the primary route's requests with it; a fallback model is
   priced without the primary's report. The estimate's tooltip names it ("the provider's
   model list"). Records without the source read as before.
3. `model-catalog` — the entry `resolveCatalogKey` finds (§4), with `catalogEntry`.
4. `unknown` — shown as unknown, never as $0.

Until slice 7 the hand-kept row answered as `pricing-catalog` between the catalog and
`unknown`. A price snapshot an earlier build recorded with that source is still read back
as recorded (`RecordedModelPricing`); a recorded long-context surcharge
(`surchargeInputThreshold` and its multipliers) is read as the prompt-size tier it priced
as, which gives the same USD.

A catalog entry with no price, or with only one of input and output, is unknown; one that
lists input and output at zero is too, and the answer is `unknown` with `catalogListsZero`
naming the entry.
A self-hosted route is not priced from the entry its user named as `catalogModel` (§4):
that names the model for its limits, and the public price is not what the user's own
endpoint costs.

`computeCost` (`src/shared/pricing-data.ts`) prices one provider request:

- **Tiers.** The highest tier whose `afterInputTokens` the prompt exceeds (strictly: a
  prompt exactly at the boundary pays the base) replaces the base rates for the whole
  request; a rate the tier does not state keeps the base rate. The prompt is every
  prompt token the provider read: fresh input plus the cache lines for Anthropic, whose
  usage counts them apart, and the reported input for everyone else, whose count
  already includes the cache. A turn is priced per request (`usageByModel`): a turn's
  rounds summed are not one prompt.
- **Cache.** Anthropic adds cache reads and writes at their rates (derived at 0.1× and
  1.25× input when the rates state none). Every other vendor's prompt is split into
  fresh, cache-read and cache-write parts, each at its rate, a missing cache rate being
  the input rate. Gemini and Vertex used to ignore the cache entirely.
- **Reasoning.** A positive `cost.reasoning` prices the reported reasoning subset of
  output, with the remainder at the output rate. Entries from `alibaba-cn` instead
  publish a thinking-mode output rate: once a request reports positive reasoning tokens, that rate
  covers both thought and answer tokens. The adapter carries
  `outputTokenDetails.reasoningTokens` through request usage, the turn summary and the
  audit row. An absent or zero catalog reasoning rate uses the output rate; a listed
  zero does not establish free reasoning. Without a reported split, all output uses
  the output rate.

The pre-send estimate (`use-cost-estimate.ts`) resolves current prices. Each completed
provider request records its resolved `pricing` in `usageByModel`; the per-turn badge,
usage dashboard and CSV use that snapshot, including an unknown or explicit free
price. For an older audit record without a request snapshot, the recorded primary-route
price applies only to a segment matching the audit route; otherwise current prices
apply. Older transcript segments without snapshots resolve current prices. The
dashboard's cache key includes the catalog's `sha256` for those older records. The run's
`modelSettings.pricing` records the primary route's answer; request snapshots also
cover mixed-model turns. The renderer
applies the corrections main resolves (`ave:usage:pricing-overrides`, fetched on each
settings snapshot; `src/ui/renderer/hooks/use-pricing-overrides.ts`) instead of reading
the setting raw, so an environment-forced list prices the estimate and the badge as it
prices the dashboard. Before, the renderer applied no correction at all. The estimate's
tooltip names who stated the rates, or that the catalog listed the model at zero.

Prices the snapshot of 2026-10-12 changed against the table: models the table listed
at zero or not at all are now priced — Gemini 2.5 Pro, Flash and Flash-Lite, GPT-5.1,
5.2 and 5.3 Codex, GPT-4o and 4o mini, GPT-4.1 nano, o1, o3, o4-mini, Claude Haiku 5.5 (with
its 100K tier) and Vertex AI models among them; GPT-5 mini drops from $1.25/$10 to the
listed $0.25/$2; Azure deployments named for a model the catalog's `azure` provider
lists are priced at that entry (before, Azure was unpriced without a correction).
Claude's dated ids the catalog does not list (`claude-sonnet-4-20250514`,
`claude-opus-4-20250514`, `claude-3-*`) priced from the table until slice 7 and are
unknown since (§8).

### 6.1 Retired models (slice 7 follow-up, owner direction 2026-10-13)

A model that is going away is in one of two tiers (owner decision 2026-10-13,
two-tier); nothing else puts it there, and the host keeps no list of retired model ids
(`RETIRED_LLM_MODEL_IDS`, which retired `gpt-4o` by name, is gone):

- **Retired (`"unlisted"`) — the vendor's own listing.** The route's last successful
  `/models` answer is complete and names no id equal to the model, ignoring case (no
  folding or aliases). Only a model the active catalog knows by that exact id under the
  vendor's mapped provider can be judged (lead decision 2026-10-13): an id it does not
  know — an OpenAI `ft:` fine-tune, a Fireworks `accounts/<own>/…` model, a Doubao `ep-…`
  endpoint, a model newer than the snapshot — may be served without appearing in the
  public list, so its absence proves nothing. Only a public vendor that serves its own models, on its native
  host, can prove this (`listingJudgesRetirement` in `src/shared/context-budget.ts`): the
  provider map (§3.4) maps the vendor, the vendor is not a gateway (`gateway: true` on the
  preset — OpenRouter, Requesty, LiteLLM, Hugging Face, Vercel AI Gateway, AI Hub Mix,
  Kilo), and `allowsImplicitModelLimits` holds (never Azure, never a custom `baseUrl`;
  never Vertex AI, whose SDK answers no standard `/models`).
  Local, self-hosted, custom and gateway endpoints list what they happen to route, so a
  missing id there says nothing. A listing is **complete** (`complete: true` on the cache
  entry) only when the response carried no continuation marker (`has_more: true`,
  `next_page_token`, `nextPageToken`) and every id fit the cache cap; the settings
  normalizer drops the flag when it truncates. A failed, partial or absent listing — and
  every cache entry written before the flag existed — proves nothing: unknown, not
  retired. Neither does a stale one: a listing taken before the end of the period the
  catalog says the model was released in — the day, or the whole month for a date given
  only as `YYYY-MM` — (or whose time cannot be read) cannot prove that model gone.
- **Deprecated (`"catalog-deprecated"`) — the catalog.** The active catalog marks the
  model `status: "deprecated"`. Judged only where the route itself establishes the model
  (`catalogModelFor` without a named entry, §4): a user's `catalogModel` declaration
  describes a model's shape, not whether that host still serves it, so an Azure
  deployment declared `openai/gpt-4` is not deprecated because OpenAI deprecated `gpt-4`.
  A dated id resolves through §4 like any other fact. The catalog's `deprecated` may mean
  "announced, still served", so this tier never blocks.

The listing outranks the catalog: a deprecated model the complete listing also dropped is
retired. `resolveModelRetirement` is the one rule; the settings pickers, the composer's
model card, the window notice and the settings load call it. A model in **either** tier
is not offered in the model picker, the fallback picker or the composer card.

A **saved selection** in the **retired** tier reuses the unresolved-choice flow #2658
built for removed vendors: the same `llm.retiredProvider` marker, which now holds either
the removed vendor id (a string, unchanged) or `{ vendor, model, reason: "unlisted" }`.
Every gate of that flow applies as is: API-key chat and host credentials are withheld
(the route reads as not configured), the window notice shows (`app.retiredModelNotice*`,
naming the model), the chooser shows no selection and does not offer the retired model,
an ordinary save preserves the marker, and an explicit pick clears it. The settings load
sets it and judges afresh on every launch, so a model that comes back is released and a
stored marker for a model the profile no longer names is dropped; a retired vendor wins
over a retired model. The marker is not derived on patch: a listing that lands
mid-session hides the model from the pickers at once but marks the saved selection at the
next launch.

A saved selection in the **deprecated** tier sets no marker. Chat keeps working and host
credentials are released as for any model. The renderer derives the tier from each
settings snapshot (`deprecatedLlmModel` in `use-settings.ts`, against the same catalog
main installed) and the window shows a non-blocking status notice
(`DeprecatedModelNotice`, `app.deprecatedModelNotice*`: "scheduled for retirement — pick
another model"), dismissible for that model until the next launch; the chooser's trigger
names the model and its tier instead of a selection.

A saved fallback in either tier is kept as saved; its picker shows no selection and
names the tier ("… is retired — choose a model" / "… is scheduled for retirement —
choose a model"), and the engine's fallback walk is unchanged.

Shipped defaults and curated options the bundled catalog deprecates were replaced so a
fresh profile is never born retired or deprecated (a test holds every vendor's default
and curated line to the catalog's status): OpenAI drops `o4-mini`; Vertex AI moves from Gemini 2.5 to
`gemini-3.5-flash` / `gemini-3.1-pro-preview` / `gemini-3.1-flash-lite` (its complexity
tiers follow); DeepSeek `deepseek-v4-flash` → `deepseek-flash`; Together
`Qwen/Qwen3.5-397B-A17B` → `Qwen/Qwen3.6-Plus`; Baseten `deepseek-ai/DeepSeek-V3.1` →
`deepseek-ai/DeepSeek-V4.1-Flash`; Xiaomi `mimo-v2-omni` → `mimo-v2.6-flash` (it keeps image, audio and video input; the
catalog lists no PDF input for it). Removing the
name list makes `gpt-4o` selectable again on OpenAI (the catalog lists it without a
deprecated status); `gpt-3.5-turbo`, `gpt-4`, `o1`, `o3-mini`, `o4-mini` and the other
OpenAI entries the catalog deprecates are no longer offered there.

## 7. Refresh (slice 6)

- Setting `llm.modelCatalogRefresh: "auto" | "off"`, default `"auto"` (owner decision,
  2026-10-12); a value that is neither reads as the default. The key is flat because the
  env-backed settings registry addresses settings as `group.key`. The switch is in
  Settings → Model → Model catalog (`ModelCatalogRefreshSection`), which also names the
  catalog in force and says when the pin or the policy is deciding.
- Organization policy turns it off with `{ "modelCatalog": { "refresh": "off" } }` in the
  managed policy file (`getAdminPolicyPath()`). The section fails closed: a file or a
  section that cannot be read exactly as written — bad JSON, a duplicate key, another
  key or value — turns the refresh off (`refresh-policy.ts`).
- `AVE_MODEL_CATALOG` pins the catalog for headless runs and benchmarks: `bundled`, the
  `<sha256>` of a retained cached copy, or the absolute path of a catalog file. A nonblank value turns the
  refresh off. A pin that cannot be honoured — no such cached copy, a file that fails
  `verifyModelCatalogDocument`, any other spelling — fails boot rather than running on
  another catalog. Cache retention can remove an old hash pin; a separate file pinned by
  absolute path is the durable option for reproducing an older run.
- Precedence for whether a check may run: the pin, then the policy, then the setting.
  It is decided at each check, so turning the switch off stops the next one without a
  restart.
- The host fetches only `https://models.dev/api.json`; the
  refreshed copy carries the license of the catalog in force and leaves
  `upstreamHeadAtFetch` and `upstreamSchemaBlob` absent — through
  `fetchPublicHttpResponse` (`src/core/network-guard.ts`, private addresses refused), with
  redirects refused, on the host's single-hop transport, never a plugin path. The request
  omits session credentials and carries `Accept: application/json`, plus `If-None-Match`
  when the cached copy has an ETag. An unsolicited 304 is refused. A 15 s wall-clock deadline
  bounds headers and body even when DNS or cancellation stalls; the 16 MB (16,777,216-byte)
  cap is enforced on decompressed bytes while the body streams. Certificate errors do not
  cause an HTTP retry. The
  download is pruned and normalized with the slice 1 code, verified, and refused when a
  catalog provider the catalog in force lists has no models in it, so a source that changed
  shape cannot replace a working catalog with an empty one (`refresh.ts`).
- The cache is `<AVE_HOME>/cache/model-catalog/`: an immutable `<sha256>.json` per catalog
  and a `current.json` pointer `{version, sha256, etag?, checkedAt}`, each written
  temp → fsync → rename (`refresh-cache.ts`) with private namespace permissions (0700 directories,
  0600 files on POSIX). Reads reject linked cache directories and files, read one regular
  inode under a byte cap, and verify those same loaded bytes before use. Hash-only pointer
  names cannot escape the directory. Writers enforce the same byte caps as readers.
  A conditional 304 renews `checkedAt` only. A cross-process lock serializes each check
  through publication (`refresh-cache.ts`). Boot's read-only cache access (`cache.ts`,
  `document.ts`) does not load publication, attempt-state, normalization or formatting
  helpers; document construction lives in `document-builder.ts`. Publication keeps at most five hash-named files, protecting the
  new copy and the preceding current copy; unrelated files are not pruned.
- Cadence: a running interactive app checks at boot and then hourly, and sends a request
  only when the last attempt is a day old. `.refresh-check.json` records an attempt before
  requesting, including failures; `current.json.checkedAt` still records successful
  confirmation. A launch inside that day sends nothing. A backward clock change permits
  rechecking instead of treating a future timestamp as indefinitely fresh. Headless runs
  never refresh. This interval limits checks; updates apply only after another launch.
- A refresh only writes the cache. The catalog a process resolves against is chosen once,
  at boot (`selectBootModelCatalog`, `bundled.ts`): the pin; else the copy `current.json`
  names, when it verifies and is not older than the bundled snapshot (an app update can
  ship a newer snapshot); else the bundled snapshot. So a refreshed catalog takes effect at
  the next launch, one run never sees two catalogs, and main and renderer always hold the
  same one.
- A failed or malformed fetch — a status other than 200/304, a timeout, the cap, bad JSON,
  verification, coverage — preserves the usable catalog. Scheduling state records failed
  attempts, and a failed publication can leave an unreferenced entry. With no usable
  cached copy, boot uses the bundled snapshot. A damaged pointer or copy reads as absent at boot.
  These fallbacks are tested offline (`src/core/model-catalog/__tests__/refresh.test.ts`).
- The source is an outbound destination owned by this feature. The request carries no
  account, API key, session authentication, cookie, prompt, file or conversation; the
  server sees the IP address and ordinary transport headers. It is documented in `architecture.md` and on the
  Trust & Security page (`web/app/docs/host/trust-security`, `web/app/en/docs/host/trust-security`).

## 8. What the hand-kept table had that the catalog does not (slice 7)

Before slice 7 a `--report` mode compared every `DEFAULT_PRICING` row with the snapshot.
Against the snapshot of 2026-10-12: 38 rows had a catalog entry by exact id, 36 of them
differing (mostly cache rates the table derived at run time, and OpenAI and Gemini rows the
table listed at zero); 47 rows had none. Slice 7 removed the table, the name rules and the
report after answering each kind of row:

- **Dated ids of listed models** (`gpt-4.1-2025-04-14`, `o3-2025-04-16`,
  `o4-mini-2025-04-24`, and month-day snapshots such as `gpt-3.5-turbo-0125`,
  `gpt-3.5-turbo-1106` and `gpt-4-0613`) resolve to their entry by the date-suffix step of
  §4, which reads `-YYYYMMDD`, `-YYYY-MM-DD` and `-MMDD` (a valid month and day only).
- **Dated and retired ids the catalog does not list** take the host fallback: a 128K
  window, an unknown price, no stated modalities (images refused) and, for an OpenAI-family
  route, no reasoning effort. No alias joins them (§4 allows an alias only between ids
  documented to name one model, and the `anthropic` provider lists no entry for Claude
  Sonnet 4, Opus 4 or Claude 3): `claude-sonnet-4-20250514` and `claude-opus-4-20250514`
  (were 200K), `claude-3-5-sonnet-20241022`, `claude-3-5-haiku-20241022`,
  `claude-3-opus-20240229`, `claude-3-sonnet-20240229`, `claude-3-haiku-20240307` (200K);
  `gpt-5.3`, `gpt-5.2-codex`, `gpt-5.1-reasoning`, `gpt-5.1-pro`, `gpt-5.1-codex`,
  `gpt-5.1-codex-mini`, `gpt-5.1-codex-max` (400K), `o1-mini` (128K); `gpt-4-32k`
  (32,768) and `gpt-3.5-turbo-instruct` (16,385), where the fallback is larger than the
  model's real window, so preflight compaction cannot fire before the provider's context
  error; a route still on one of them should declare `contextWindow`. (The `-0125` and
  `-1106` snapshots of `gpt-3.5-turbo` were in this list until the date-suffix step read
  `-MMDD`; they now take the catalogued `gpt-3.5-turbo` entry's 16,385.) Also: `gemini-2.0-flash`
  (1,048,576), `gemini-2.0-flash-lite` (128K), `gemini-1.5-pro` (2,097,152),
  `gemini-1.5-flash` and `gemini-1.5-flash-8b` (1,048,576). The table also matched any id
  that began with one of its keys (`gpt-5.4-preview`, `gpt-5.5-codex` through `gpt-5`,
  `claude-opus-4-6-eval`), case-insensitively; such an id now resolves only through the
  steps of §4, which is the guess §4 refuses. A Codex subscription model id the catalog
  does not list (`gpt-5.5-codex`, for example) budgets against the same 128K fallback
  and cannot recover above it: Codex's own context-window report can only tighten a
  subscription budget, never raise it (that rule predates slice 7), and a subscription
  route has no `contextWindow` or `catalogModel` setting.
- **Retired vendor rows** (Copilot, removed with GitHub Models): absent from both the vendor
  union and the provider map (§3.4).
- **Self-hosted rows** (`openai-compatible`: `Qwen3.6-35B-A3B-NVFP4` 262,144,
  `Nemotron-3-Nano-30B-A3B-FP8` 131,072): these windows come from the endpoint's report or
  the user's `contextWindow`, else the fallback, which the engine logs once per route.
- **Fields with no catalog counterpart:**
  - `contextWindow1MBeta` is removed: no context-window beta header is sent.
    Request controls use catalog metadata through `claudeRequestShape` in
    `src/shared/model-host-policy.ts`. Protocol selection uses reported controls
    or catalog reasoning through `usesOpenAIResponsesWire` in
    `src/engine/llm/reasoning-plan.ts`; neither parses model versions.

  - `surchargeInputThreshold` / multipliers (GPT-5.4 and 5.4 Pro) — the catalog states the
    same prices as a tier at 272,000 (2× input, 1.5× output). Recorded snapshots that carry
    the old form are read as that tier (§6).
  - `tpmDefault` (GPT-5.4 mini and nano, 200K) — a host throttling default, in the
    host-policy module (`hostTpmDefault`), for the same vendors (OpenAI, and Azure
    deployments, which borrowed OpenAI's rows) and the same case-folded id prefix.

Host-owned values live in that module: the 32,000 default output
(`DEFAULT_LLM_OUTPUT_TOKEN_LIMIT`), the 128K fallback window (`FALLBACK_CONTEXT_WINDOW`),
`MAX_CREDIBLE_CONTEXT_WINDOW`, the TPM defaults and request-control projection. None of it
describes a model's capacity, price, modalities or reasoning levels.

The output and tool capabilities never had name rules: an unknown output ceiling clamps
nothing (§5) and an unknown tool capability sends tools (§6).

## 9. Slices

Each slice is one pull request against `main`, opened in order:

1. Contract, generator, bundled snapshot with provenance, normalization and validation
   tests, the comparison report, this page, the third-party notice. No behavior change.
2. Resolver (precedence, aliases, local endpoints) and the context-window consumers.
3. Effective output and reasoning, the user-set output stamp, the adapter cutover, run records.
4. Modalities and tool capability.
5. Pricing through the catalog, renderer overrides.
6. Refresh, the setting and policy, `AVE_MODEL_CATALOG`, the network documentation.
   Shipped as described in §7.
7. Removal of the superseded tables and predicates, the request-shape table, documentation.
   Shipped as described in §8.

This page goes stale when a slice changes what it describes; update it in that slice's
commit.
