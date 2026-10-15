# Model Upgrade Verification

Status: Current procedure. Apply it whenever a change adds or replaces a model
in the catalog snapshot, the host request-shape table, or a vendor's default
model.

Static wiring can pass typecheck and unit tests while the live API disagrees:
a beta header the API ignores (the request silently falls back to a smaller
window), a model id the endpoint does not serve, or a renamed header. This
procedure adds a live check before merge.

## Where model facts live

| Fact | Source | Updated by |
|---|---|---|
| Context window, prompt cap, output limit, input modalities, reasoning levels, pricing, deprecation status | Bundled catalog `src/core/model-catalog/bundled-snapshot.json`, generated from committed input in `scripts/model-catalog/` | `bun run generate:model-catalog -- --fetch` |
| Vendor to catalog provider mapping | `CATALOG_PROVIDERS_BY_VENDOR` in `src/shared/model-catalog/provider-map.ts` | Hand edit; exhaustive over `LLMVendor`, so a new vendor fails typecheck until mapped |
| Request shape the catalog does not state (the 1M context beta header, interleaved numeric thinking) | `CLAUDE_REQUEST_SHAPES` and `claudeBetaHeaders` in `src/shared/model-host-policy.ts` | Hand edit |
| Wire choice (Responses API vs Chat Completions) | `usesOpenAIResponsesWire` in `src/shared/model-host-policy.ts` | Hand edit |
| Host fallbacks (128K window, output limit, TPM defaults) | `src/shared/model-host-policy.ts` | Hand edit |
| Default model per vendor | `DEFAULT_MODEL` behind `LLM_VENDOR_DEFAULTS` in `src/shared/llm-vendor-defaults.ts` | Hand edit |

A model the catalog does not know still runs, on the host fallback: a 128K
window, unknown price, no stated modalities (images refused). Resolution order
and fallbacks are specified in the
[model capability catalog](../design/model-capability-catalog.md#4-resolution-slice-2).
The running app refreshes the catalog itself
([Refresh](../design/model-capability-catalog.md#7-refresh-slice-6)); the bundled
snapshot is what fresh installs, pinned runs, and tests see.

## Procedure

### 1. Static wiring

1. If the catalog does not list the model, run
   `bun run generate:model-catalog -- --fetch` and commit both the snapshot and
   the input files. `bun run check:model-catalog` (part of `check:gate-core`
   and the pre-push hook) fails when the snapshot does not match its input.
2. If the model needs a request-shape feature, add a row to
   `CLAUDE_REQUEST_SHAPES`. Rows match id prefixes, so dated snapshots of the
   same family are covered. The catalog never says that a large window requires
   a header.
3. If you replace a vendor default, change `DEFAULT_MODEL` in the same change,
   and confirm the catalog lists the new id under the vendor's mapped provider
   without `status: "deprecated"` (see
   [Retired models](../design/model-capability-catalog.md#61-retired-models-slice-7-follow-up-owner-direction-2026-10-13)).

### 2. Live call (required)

Send at least one minimal request per affected vendor route with the exact
model id and the exact headers the adapter will send
(`claudeBetaHeaders` output for the `claude` vendor). For example:

```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: <value of CONTEXT_1M_BETA, if the row sets context1MBeta>" \
  -H "content-type: application/json" \
  -d '{"model":"<MODEL_ID>","max_tokens":50,"messages":[{"role":"user","content":"reply with just OK"}]}'
```

Read the result:

- `200` with content: model id and headers accepted. Pass.
- `400` naming the model, or `404`: wrong or unavailable id. Stop.
- `400` naming the beta header: header invalid or retired. Recheck the
  constant in `model-host-policy.ts`.
- `429` or `529`: rate limit or overload. Retry; only a later `200` passes.

Routes without beta headers need only the `200` check. For the `openrouter`
vendor route, `bun run smoke:llm` runs `test/smoke/live-model.smoke.test.ts`
with the key stored in Settings (local machine only; it decrypts a secret).

### 3. Large-context check (1M-window rows only)

A header being accepted is not proof that the large window is delivered.
Confirm one of:

- In the app, select the model and build a conversation past 250K input tokens
  (large attachments). A normal completion means the large window is active;
  a "prompt is too long" or context-length error means the smaller window.
- Send a request with more than 200K input tokens directly and get a `200`.

### 4. Record the result

Put the evidence in the pull request description:

```
## Model verification (docs/development/model-upgrade-verification.md)

- [x] Live call: 200, model=<MODEL_ID>, headers=<list>
- [x] Large context: <N>K input, normal completion
```

A catalog, request-shape, or default-model change without this evidence does
not merge.

## Enforcing checks

- `bun run check:model-catalog` - `scripts/generate-model-catalog.ts --check`.
- `src/core/model-catalog/__tests__/bundled-snapshot.test.ts` - snapshot equals
  generated input, every mapped provider present.
- `src/shared/__tests__/model-host-policy.test.ts` - request-shape rows and
  header order.
- `src/shared/model-catalog/__tests__/resolve.test.ts` - resolution and
  fallbacks.

The live call and large-context check have no automated gate; they are the
reviewer-visible evidence above.

## Related

- [Model capability catalog](../design/model-capability-catalog.md)
- [Release process](release-process.md)
- [Product vision](../vision/README.md)
