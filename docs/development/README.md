# Development handbook

Status: Active. This handbook is the single home for the host's **loading
policies** — how plugin, MCP, and builtin tools and skills move from registry to
model-visible schemas and instruction bytes, and how remote MCP servers
authenticate. It folds in what used to be four separate files; their code
referrers now point here. Each section keeps its source document's own status
line: in particular the [MCP resource consumption
policy](#mcp-resource-consumption-policy) is a frozen design whose implementation
is staged, not shipped behavior.

The budget mechanics and the `tool_search` host contract behind the tool policy
are a design record kept in its own file:
[Tool-level deferral](./tool-level-deferral-design.md). Architectural context is
[`docs/architecture/architecture.md`](../architecture/architecture.md)
(§4.5/§6.1/§6.4/§9/§14); the whole documentation map is the
[documentation index](../README.md).

## Contents

- [Tool loading policy](#tool-loading-policy) — budget-based hybrid exposure of
  callable tool schemas.
- [Skill loading policy](#skill-loading-policy) — progressive disclosure of
  `manifest.skills` instruction bytes.
- [MCP resource consumption policy](#mcp-resource-consumption-policy) — how the
  host lists and reads MCP resources.
- [Remote MCP authentication](#remote-mcp-authentication) — OAuth for remote
  Streamable HTTP servers.

Other development references in this directory: build and bundle budgets
([main-process bundle](./main-process-bundle.md),
[knip baseline](./knip-baseline.md)), the [theme system](./theme-system.md),
[release process](./release-process.md),
[model upgrade verification](./model-upgrade-verification.md), and the
[legacy sunset policy](./legacy-sunset-policy.md).

---


## Tool Loading Policy

> Status: implementation policy for Ave tool exposure. This document governs
> how plugin, MCP, and builtin tools move from registry to model-visible tool
> schemas. It complements `docs/architecture/architecture.md` §4.5, §6.1, §6.4,
> §9, §14 and the implementation design in
> `tool-level-deferral-design.md`.
>
> Keyword routing was **retired** in SDK v12 (2026-07-24).
> `manifest.keywords` is hard-rejected at manifest load
> (`src/plugins/runtime/manifest-validation.ts`); no keyword path promotes a
> Tool, and the only callable surface is manifest `Tool` objects. Bundled
> instruction discovery belongs to `manifest.skills` and is governed by its own
> symmetric budget — see `#skill-loading-policy`.

### Decision

Ave uses a **budget-based hybrid loading policy**. Plugin activation makes a
plugin's tools eligible for model exposure; the exposure mode depends on the
estimated token cost of exposing them eagerly:

- Below the eager budget: expose active plugin/MCP tool schemas eagerly. This
  avoids extra `tool_search` discovery rounds, which were measured to dominate
  TPM cost in #1176 — for a small surface, eager is *cheaper* than paying the
  per-round discovery tax.
- At or above the budget: switch to tool-level deferral. The model sees a
  compact catalog and promotes only the selected tools needed for the turn.

The budget is measured in **tokens**, not raw tool count. The MCP "Tools Tax"
(eager schema injection, ~10k–60k tokens/turn in multi-server deployments) is a
token cost, so a few very large schemas can exceed the budget while many tiny
schemas do not. `EAGER_TOOL_EXPOSURE_CEILING` (200) is retained as a cheap count
pre-filter — a hard upper bound that trips deferral without estimating — but the
authoritative gate is the estimated eager tool-schema token total against
`EAGER_TOOL_EXPOSURE_TOKEN_BUDGET` (see §7).

The canonical loading model is:

1. **Registered**: all runtime-loaded plugin tools remain in `ToolRegistry` so
   execution, permission, audit, deny rules, deprecation, auth/config/UI, and
   diagnostics use one source of truth. User-inactive plugins are not removed
   from this execution registry.
2. **Loaded eager**: when the eligible active-plugin/MCP tool count is below the
   ceiling, all in-scope active tool schemas are sent to the provider.
3. **Catalogued/deferred**: when the eligible count reaches the ceiling, active
   plugin/MCP tools not yet loaded are listed as compact `{name, description}`
   candidates in the system prompt.
4. **Loaded deferred**: in deferral mode, only builtins/meta-tools, explicitly
   promoted tools (via `tool_search`), and current-scope carried-forward tools
   are sent as full `tools[]` schemas to the provider.

User-inactive plugins are excluded from provider `tools[]`, `<tool-catalog>`,
and `request_plugin`, but stay runtime-callable through host/UI execution paths.

This is a budget contract, not a capability restriction. Deferring schema
exposure must never remove a tool from the registry or bypass permission checks.

### Reference Basis

- Published tool-search guidance recommends deferring tool definitions and loading
  only the definitions needed at runtime. It also notes that deferring a single
  function mostly saves parameter-schema tokens, while deferring larger logical
  namespaces saves more because function names and descriptions need not be
  repeated upfront.
  - `https://developers.openai.com/api/docs/guides/tools-tool-search`
- Published function-calling guidance describes the multi-step loop: provide tools,
  receive tool calls, execute them, then send results back for another model
  response. Any oversized tool schema set is therefore paid repeatedly across
  tool-use rounds, not once per user turn.
  - `https://developers.openai.com/api/docs/guides/function-calling`
- Prompt caching can reduce repeated-prefix cost/latency, but it is not a
  substitute for a small tool surface. Cache eligibility depends on stable
  prefixes and does not make large `tools[]` payloads safe under TPM pressure.
  - `https://developers.openai.com/api/docs/guides/prompt-caching`
- The Agent Skills pattern establishes **progressive disclosure** as the discovery
  pattern: at startup only each skill's name + description load (a few dozen
  tokens each); the full `SKILL.md` body loads only when a task matches, and
  bundled resources load on demand. The always-present metadata is a fixed cost,
  so it must be bounded — the same discipline this policy applies to tools is
  applied to skills in `#skill-loading-policy`.
  - `https://agentskills.io`
- Dynamic-toolset / "Tools Tax" reports converge on the same conclusion the
  local #1176 evidence reached: eager schema injection is a per-turn *token*
  overhead (~10k–60k tokens in multi-server MCP deployments), paid on every
  round, and just-in-time discovery keeps that cost roughly constant as a
  catalog scales from tens to hundreds of tools. Semantic (embedding) tool
  search reports ~97% hit-rate at K=3; Ave uses lexical scoring instead
  (cross-vendor, no embedding infrastructure) — embeddings remain future work.

### Local Evidence

The 2026-05-24 investigation originally suspected whole active-plugin schema
loading, but #1176 reversed that premise with measured data. Making deferral
unconditional caused the indexer workflow to spend many additional rounds on
`tool_search`, re-sending the same conversation prefix until it hit the 200K TPM
limit. The eager path for the same active plugin surface finished in far fewer
rounds and avoided the TPM spike.

Current plugin manifest sizes explain why the common case should stay eager and
why a high ceiling is still needed for future large surfaces:

| Plugin | Tools |
| --- | ---: |
| `hub` | 43 |
| `mail` | 30 |
| `meeting` | 29 |
| `portal` | 29 |
| `local-indexer` | 19 |

### Policy

#### 1. Registry Is Not Exposure

All installed tools may be registered, but registration must not imply provider
visibility. The registry is the authority for execution-time lookup and policy;
the provider request is a selected view.

Required invariant:

```text
registered_tools >= (loaded_schema_tools + catalog_tools)
```

The provider-visible view must come from the registry. In eager mode,
`catalog_tools` is normally empty and `loaded_schema_tools` contains the active
tool surface below the ceiling. In deferred mode, `loaded_schema_tools` is the
selected subset and `catalog_tools` carries compact discovery hints.

#### 2. Plugin Activation Means Catalog Scope

`request_plugin` activates a plugin into the current scope. After activation the
loop recomputes the eligible active-plugin/MCP tool count:

- If the count remains below the ceiling, the activation result should say the
  plugin tools are loaded and can be called directly.
- If the count reaches the ceiling, the activation result should say the plugin
  tools are discoverable through `tool_search`.

#### 3. Loaded Schemas Are Selected Tools

Tools may enter `tools[]` only through one of these paths:

- Builtin/meta tools required for the loop, such as `request_plugin` and
  `tool_search`.
- Eager full-schema exposure for all active plugin/MCP tools when the eager
  token budget (and the count pre-filter) is not exceeded.
- `tool_search` promotion from the current compact catalog.
- Carry-forward from the previous turn, clamped to the current active plugin/MCP
  scope.
- Explicit sub-agent/routine/headless allowlists.

No path may promote a tool whose owner is outside current scope or blocked by
deny rules.

#### 4. Not Always One Tool

When deferral is active, the target is not "exactly one plugin tool" in every
turn. One tool is the preferred floor for narrow requests, but real workflows
often need a small set of related tools. The deferred-mode policy is **small
selected subset**, not whole plugin.

Default promotion should be conservative:

- exact tool-name match: load the matching tool
- broad/natural-language query: score candidates and load only the top few
- explicit multi-tool intent: load a small group if the group is justified

When a plugin has large functional areas, prefer a logical namespace/group
smaller than the plugin. Keep groups below 10 tools where practical.

#### 5. Catalog Matching Must Be Bounded

Catalog matching must not use unbounded "any token substring" promotion. Broad
queries such as "list", "get", "work", or one-character tokens can promote many
tools and erase the token-floor benefit.

Required behavior in deferred mode:

- ignore very short query tokens
- score exact name, prefix, keyword, and description matches separately
- cap promoted tools per `tool_search` call
- cap total promoted tools per turn/session
- emit metrics for loaded/deferred counts and promoted names

#### 6. Projection And TPM Are Part Of The Contract

Before a request is sent, request-input projection must include the same
`tools[]` schemas that will be sent to the provider. The projection should
record:

- system prompt tokens
- provider-wire message tokens
- tool schema tokens
- loaded tool count
- deferred catalog count
- model TPM threshold source, if known

TPM protection must not rely on auto-compact alone. Compacting history does not
shrink the active tool schema set.

#### 7. Budget-Based Deferral Gate

There is no `experimental.toolDeferral` runtime flag. Deferral trips when
**either** bound is exceeded:

```text
eligibleActivePluginAndMcpToolCount  >= EAGER_TOOL_EXPOSURE_CEILING       // cheap count pre-filter
OR estimatedEagerToolSchemaTokens    >= EAGER_TOOL_EXPOSURE_TOKEN_BUDGET   // authoritative token gate
```

The token estimate sums a per-tool schema-token estimate over the eligible eager
set (the same schemas §6 projection records). The count pre-filter is a hard
upper bound so a pathological catalog can never be exposed eagerly even when
token estimation is unavailable; the token gate is what actually protects TPM,
because a few large schemas cost more than many small ones. Both are pure
functions of the eligible set — no runtime flag, no settings branch.

Required invariants:

- `request_plugin` to `tool_search` same-turn flow is covered by integration
  tests.
- Catalog and loaded-tool state remain coherent across rounds.
- Sub-agent, routine, and headless paths have explicit tool availability tests.
- Catalog matching uses bounded scoring/top-N instead of broad substring
  promotion.
- Carry-forward tools are clamped when a plugin leaves scope.
- Audit/trace metrics expose deferred-vs-loaded ratios and the token estimate
  that drove the decision, alongside the count.

Keeping a settings-based alternate path would violate the no-fallback-code rule.
The eager and deferred modes are not legacy fallbacks; they are both branches of
the single budget-based policy.

### Implementation Direction

 Tool discovery is `tool_search` promotion of individual tools or small tool
 subsets from the compact catalog. There is no keyword preload path (retired in
 SDK v12); bundled instruction discovery belongs to `manifest.skills`
 (`#skill-loading-policy`).

Do not switch the app to a single vendor's hosted tool search as the first fix. Ave
routes tool schemas through the cross-vendor Vercel AI SDK provider adapter, so
the stable implementation surface is client-side schema deferral in
`ToolRegistry`, `ConversationLoop`, and `SystemPromptBuilder`.

The long-term model should add manifest-level grouping, for example:

```json
{
  "toolGroups": [
    {
      "id": "hub.work-items",
      "description": "Create, list, update, and inspect hub work items.",
      "tools": ["hub_create_work_item", "hub_list_work_items"]
    }
  ]
}
```

Groups should improve discovery and preload precision. They must not become a
new way to load an entire large plugin.

---

## Skill Loading Policy

> Status: target policy for Ave `manifest.skills` instruction discovery. It is
> the skill-side twin of `#tool-loading-policy` and complements
> `docs/architecture/architecture.md` §4.5/§6.4. Where the tool policy governs
> *callable* schemas, this governs *instruction* bytes. Callable routing lives in
> Tools only; Skills never invoke a Tool (keyword routing was retired in SDK v12).

### Decision

Skills use **progressive disclosure**, the same discipline the tool policy
applies to schemas, applied to instruction bytes:

1. **Installed** — skill bytes sit on disk (`~/.ave/skills`, plugin bundles);
   nothing enters the prompt (`src/skills/skill-installer.ts`).
2. **Activated** — when a plugin generation is active (or a user skill exists),
   the skill is reflected into the in-memory catalog
   (`src/main/skill-store.ts`). Activation tracks the *current active
   generation*, not merely "installed".
3. **Catalogued (per turn)** — only each skill's **name + description +
   triggers** are injected into the system prompt as an untrusted-metadata
   catalog. Bodies stay hidden. This is the always-present fixed cost, so it
   MUST be bounded (see Policy §1–§3). `triggers` are the author's keyword
   hints from the front matter; they are dispatch metadata read by the model,
   not a router — keyword routing stays retired — and they are bounded at
   8 entries of 48 characters where the skill record is built, so every
   consumer inherits the same cap.
4. **Read on demand** — the model calls `skill_load({skillName})` (category
   `read`) before acting on a skill. First read is approval-gated with a sha256
   binding over the skill's approval **material** (TOCTOU-safe,
   `src/tools/skill-load.ts`) — the body for a flat skill, and the body plus the
   resource manifest for a skill carrying bundled files, so adding or resizing a
   bundled file re-prompts. The body is the **tool_result**: an
   `<ave-skill name base>` block (fence-neutralized) holding SKILL.md and the
   bundled-file manifest (`renderSkillReadResult`, `src/main/skill-overlay.ts`).
   The transcript shows the step as "Read skill · <name>".
5. **Extra files on demand** — `skill_read({skillName, resourcePath})` returns one
   bundled file, only for a skill already read in the same conversation.

The model selects the relevant skill by name from the catalog and reads it; the
body never enters the system prompt. This mirrors the tool `catalog →
tool_search → promote` loop and the reference hosts (metadata in the prompt,
SKILL.md read on trigger, referenced files read as needed).

#### Why the body is a tool_result (revision of the turn-scoped overlay)

The body used to render inside an `<ave-active-skills>` system-prompt overlay
for the rest of the user turn and was cleared at the turn boundary. That made the
read invisible (the tool result carried no content), changed the cached prompt
prefix twice per turn that used a skill (after the load and again on clear —
system prompt, tool schemas and history re-written to the cache each time), and
dropped the skill on the next turn so follow-ups ran without it. As a tool_result
the body is written to the cache once, stays in history, and the system prompt
never changes because a skill was read.

- **Per-conversation registry.** `SkillOverlay` records each read (owner,
  generation, canonical file, manifest — never the body) for `skill_read`
  authorization. It lives for the conversation and is cleared by
  `newConversation` and plugin-generation retirement; no generation lease is held
  past the read itself.
- **Compaction.** Mark-stale (`src/engine/auto-compact.ts`) exempts the most
  recent successful `skill_load` result of each skill; older duplicate reads go
  stale normally. Summary compaction drops reads like any history, and the
  catalog guidance tells the model to read the skill again when its result is no
  longer visible. Re-reads do not re-prompt (the approval is hash-bound).
- **Preview cap.** The generic tool-result cap (head/tail preview over 100 lines
  or 2k tokens) skips a well-formed `skill_load` result within
  `MAX_SKILL_READ_RESULT_CHARS` (body cap + manifest cap + header), so the model
  never gets a partial skill behind an extra chunk-read step; larger or
  malformed rows stay capped (`src/engine/conversation-history.ts`).
- **Typed `/<skill-name>`.** A non-built-in slash naming an indexed skill runs as
  a normal model turn with the text as typed (`src/engine/turn/run-turn.ts`); the
  catalog guidance makes the model read that skill first. Built-in commands win.

### Reference Basis

- **Progressive disclosure — the established Agent Skills discovery pattern.**
  Each skill costs only a few dozen tokens when summarized (name + description);
  the full `SKILL.md` body loads only when a task matches the description, and
  bundled resources load on demand. The name/description load into *every*
  session whether or not the skill is used — a **fixed cost** — which is why
  that metadata must be bounded and why the description is the load-decision
  signal.
  - `https://agentskills.io`
- **Tools-Tax / dynamic-toolset evidence** (see tool-loading-policy §Reference
  Basis): the per-turn cost that matters is *tokens*, paid on every round. A
  skill catalog that is unscoped and unbudgeted re-pays that cost each turn just
  like an oversized `tools[]` payload does.

### The gap this policy closes

Skill loading *timing* is already correct (progressive disclosure, turn-boundary
clearing, approval-gated bodies). Two **budget asymmetries** vs the tool policy
remain and are the target of this document:

- **Scope asymmetry.** Tool schemas/catalog are filtered by `activePluginIds`
  per turn (`system-prompt-builder.ts`), but the skill catalog is **global**
  (`getAvailableSkills: () => listCatalogSync()`, `src/boot.ts`) — every user
  skill and every active plugin generation's skills are surfaced every turn,
  including plugins that are out of the current tool scope.
- **Budget asymmetry.** The tool surface has a token budget and a bounded
  scored `tool_search`; the skill catalog has only a flat 80-entry alphabetical
  cap (`system-prompt-builder.ts`) with no token accounting and no relevance
  ranking.

### Policy

#### 1. Catalog Scope Mirrors Tool Scope

The per-turn skill catalog is filtered to the **same active-plugin scope** used
to build provider tool schemas, unioned with user-owned (non-plugin) skills:

```text
turnSkillCatalog = userSkills ∪ { skill | skill.pluginId ∈ activePluginIds }
```

A skill whose owning plugin is not in the current turn scope is not catalogued
(it remains installed and becomes catalogued again when `request_plugin` brings
its plugin into scope). This removes the case where the model sees skill
metadata — or loads a skill body — that references Tools it currently cannot
call. Registry/execution authority is unchanged; this is exposure, not removal.

The "or loads" half is ENFORCED, not merely catalogued: `skill_load` of a
`plugin:<id>:<localId>` selector is admitted by the SAME per-turn plugin scope
that admits that plugin's tools, at the same deny point (see
`src/tools/pipeline/plugin-turn-scope.ts`). A user skill has no plugin owner and
is never turn-scoped. A turn that declares no plugin scope at all (an
unrestricted caller) is unaffected.

#### 2. Catalog Is Token-Budgeted

The catalog is bounded by an **estimated token budget**
(`SKILL_CATALOG_TOKEN_BUDGET`), not only an entry count. The projection (§tool
policy §6) records skill-catalog tokens alongside tool-schema tokens so the
combined system-prompt cost is visible. The existing entry cap is retained as a
cheap pre-filter; the token budget is the authoritative bound.

#### 3. Over-Budget Selection Is Deterministic; Query-Relevance Stays Reactive

**Decision (reference-backed): the resident catalog is NOT re-ranked in place by
the turn query.** When the in-scope catalog exceeds the budget, entries are kept
by a deterministic priority — user skills first, then plugin skills, alphabetical
within each band — and the overflow is reachable through `skill_list`
(enumerate-then-load). Nothing becomes unreachable; it is deferred exactly like a
deferred Tool. Query-relevance selection lives where the reference agents put it:
the **reactive** path — the model narrows by calling `skill_load` (or, for Tools,
`tool_search`, which already lexically scores against the query it is handed),
not by the host re-ordering an always-present catalog.

**Host-side query pre-ranking of the resident catalog was evaluated across the
mainstream agent hosts and deliberately NOT implemented.** This is a decision,
not an oversight — do not implement it without revisiting all three reasons
below:

- **No precedent for lexical in-place re-ranking.** The mainstream design is a
  bounded catalog in a stable order, with the model deciding; query scoring
  happens only inside a model-invoked search step. The one shipped analogue of
  pre-ranking (opt-in vector *subset retrieval*, not in-place ranking) was
  removed by its own maintainers as too slow to be worth it. Where a host does
  pre-select by query it uses embedding semantics plus candidate *promotion*,
  never lexical re-ordering of the resident set.
- **Prompt-cache stable prefix.** Re-ordering the resident catalog every turn
  changes the cached prefix and invalidates KV/prompt caching — a real per-turn
  cost paid on every round, against a speculative relevance gain. Published
  tool-search guidance leaves the prefix untouched for exactly this reason, and
  hosts that do re-order their catalog disable it for cache-sensitive backends.
- **Lexical ranking hides.** A lexical pre-rank can drop a skill the model would
  have picked (synonym/paraphrase miss) — which is why the pre-selecting design
  reached for embeddings instead. The reactive `skill_load`/`tool_search` seam
  has no such failure mode: the model chooses.

Because the catalog is already plugin-scoped (§1) and token-budgeted (§2), the
always-present set stays below the size where catalog degradation is reported to
bite (~100+ resident tools). If a future need arises, the only cache-safe shape
is a **semantic** promotion block placed *after* the stable cached prefix, or a
shared semantic extension of the reactive
`tool_search`/`skill_load` scorer — never an in-place re-order of the resident
catalog. This is shared future work with the tool side, not a gap in this policy.

#### 4. Bodies Stay Out Of The Prompt And Gated

Load-bearing:

- First `skill_load` is approval-gated with a sha256 hash binding over the
  approval material (body, plus the resource manifest for a bundled skill).
  Bundled approvals live in their own record-key namespace (`<name>#bundled`),
  so the two material encodings can never be confused for one another.
- Bodies reach the model only as the `skill_load` tool_result inside a fenced
  `<ave-skill>` block; they are never part of the system prompt.
- A plugin skill is loadable only while its plugin generation is active
  (lease-checked).

#### 5. Projection And TPM Are Part Of The Contract

Before a request is sent, projection must include skill-catalog tokens alongside
the tool figures, so a turn's true system-prompt cost (tools + skills) is one
number. Read skill bodies are history and are counted with it. TPM protection must not rely
on auto-compact; compaction does not shrink the active catalog.

### Security invariants

- Catalog scoping never invokes a Tool and never loads a body.
- A skill body loads only via `skill_load` with a matching sha256 hash over its
  approval material and, for plugin skills, an active generation lease.
- A bundled resource is readable only via `skill_read`, only for a path the
  manifest listed, and only under the same bundle root the catalog resolved — the
  containment check is a single chokepoint (`isBundleRoot` + `isSafeResourcePath`),
  not a per-caller convention.
- Ranking/selection operate on metadata only; they cannot promote a body.
- Skill metadata is injected as `trust="untrusted-metadata"` and bodies arrive as
  fenced tool_result data — a skill cannot escalate its own trust or scope.

### Implementation Direction

Client-side, Host-owned, cross-vendor (no embedding infrastructure): scope
filtering in the skill-catalog accessor (`src/boot.ts` /
`src/main/skill-store.ts`), token budgeting + ranking where the catalog is
rendered (`src/prompts/system-prompt-builder.ts`), reusing the existing
`tool_search` scorer for relevance. Embedding-based semantic ranking (reported
~97% hit@3 for tools) remains future work and is shared with the tool side.

### Verification

- Scope: an out-of-scope plugin's skill is absent from the catalog until
  `request_plugin`, then present.
- Budget: a synthetic over-budget catalog is ranked + trimmed to budget, with
  overflow reachable via `skill_list`.
- Symmetry: the same active-plugin scope drives tool schemas, the skill catalog,
  and `skill_load` admission in one turn — an out-of-scope plugin's skill is
  refused at the same deny point that refuses that plugin's tools.
- Bodies: approval-gate + hash binding unchanged; a read body is a tool_result,
  absent from every system prompt, present in later turns, and its latest read
  survives mark-stale.

### Front Matter

A SKILL.md header is YAML, and is parsed as YAML. The fields it may carry are
`$defs/skillComponent` of the host-owned `schemas/skill-package.schema.json`
— `name` and `description` required, `triggers`, `license`,
`compatibility`, `metadata` and `allowed-tools` optional. All of them
are kept on the skill record; the host does not re-validate the header against
the schema, because admission belongs where publication is.

`allowed-tools` is carried and surfaced but **not enforced**. A skill cannot
widen its own reach by declaring it; the permission layer does not read it.

Names must match `SKILL_NAME_ALLOWLIST` (`^[a-zA-Z0-9_-]+$`), which is the
schema's charset. The schema's 64-character ceiling is an admission rule the
marketplace applies at publication; the host enforces no length of its own.

#### Headers that a real YAML parser rejects

The header used to be read line by line, which accepted things YAML does not.
A header that no longer parses does not load — the skill is skipped with a
diagnostic in the log, and on the plugin path only that skill is dropped, not
the plugin. The shapes that change:

| header | why it fails | fix |
| --- | --- | --- |
| `description: use when: deploying` | a colon *followed by a space* opens a nested mapping (`3:1` with no space is fine) | `description: "use when: deploying"` |
| `description: @mention first` | `@` is a reserved indicator | `description: "@mention first"` |
| `description: [draft] notes` | reads as a sequence, not text | `description: "[draft] notes"` |
| indentation with tab characters | YAML forbids tabs for indentation | indent with spaces |

One shape parses but reads short: an unquoted `#` starts a comment, so
`description: cost #1 priority` is the value `cost`. That is YAML behaving
correctly, and quoting fixes it — the loader compares the parsed value against
the raw line and logs a warning naming the skill and the field when the two
disagree, so the loss is visible rather than silent.

---

## MCP resource consumption policy

Status: design frozen, implementation staged.
Scope: `resources/list`, `resources/read`, `resources/templates/list`,
`notifications/resources/list_changed`. Excludes `resources/subscribe`
(deliberately — see §7).

### 0. Why this exists

Ave consumes MCP **tools** and, since the prompt work, MCP **prompts**. It does
not consume **resources** at all: `resources/read` exists in the client but only
for the `ui://` scheme, which is the MCP-Apps extension, not the core capability.
`resources/list` appears in the governance capability map and is never called. So
a server can publish a schema, a document, or an issue and the user has no way to
put it in front of the model except copying it by hand — the exact gap the prompt
work closed for its own primitive.

### 1. Who chooses — and why that answer

The spec is explicit that resources are **application-driven**: the host decides
how context gets incorporated, and the canonical illustration is a resource
picker. It is NOT a model-controlled primitive like tools, and NOT a
user-invokes-then-server-authors-the-turn primitive like prompts.

Reference-host check (required before freezing a provenance design — the spec text
alone has misled this project before): shipped hosts expose resources two ways at
once.

1. `@server:protocol://path` mentions in the composer, autocompleted alongside
   files, fetched and included **as attachments** when referenced.
2. Host-provided tools to list and read MCP resources when servers support
   them — i.e. the model can also enumerate and read.

Both, not either. Ave follows the same split, because they answer different
questions: the mention is how a person says "consider this", the tools are how the
model follows a reference it discovered mid-task.

### 2. The provenance decision

A resource is **untrusted server-authored data attached to a turn**, not a staged
turn origin.

This is the one design question worth stating explicitly, because the staged-origin
table (`shared/staged-origins.ts`) is right there and reusing it would be the easy
move. It would also be wrong. A staged origin means *the turn's input was placed by
a non-user actor* — the whole message is theirs, so the turn runs with force-ask on
and the user's own authorship revoked. A resource attachment is the opposite: the
user wrote the message and pointed at some data. Marking that turn `plugin-emitted`
-style would force-ask every write for a turn the user genuinely authored, and
would teach users to click through the gate — weakening the mechanism where it
does matter.

What the resource DOES get:

- an untrusted fence, so the model can tell data from instruction. Reuses the
  `mcp-app-context` framing already used for app-published state: fenced,
  `trust="untrusted-metadata"`, with guidance that imperatives inside are data.
- a `FenceTag` entry (`mcp-resource`) so the closed union keeps its compile guard,
  and `neutralizeFenceClose` so a body cannot escape its own fence.
- bounded size and count, per §5.
- an audit row naming server + URI + byte count.

Tool-call provenance for the turn stays the user's. That is correct and it is not a
gap: the untrusted framing is what carries the trust signal, exactly as it does for
`mcp-app-context` today.

### 3. Discovery

At connect, after `tools/list` and `prompts/list`:

- gate on the server having **advertised** `resources` in its capabilities AND the
  capability being approved by governance — the same two-key gate `prompts/list`
  uses; an unadvertised or unapproved capability means no request leaves the host.
- paginate with a page cap (`MCP_RESOURCE_MAX_PAGES`, 20 — the same value the
  prompts loop uses), so a hostile `nextCursor` loop cannot hang the handshake.
- **sanitize at the wire boundary.** The declared TS types are casts, not checks.
  Each entry keeps `uri`, `name`, optional `title`/`description`/`mimeType`, and
  `size` only when they are the right type and within bounds; anything else is
  dropped there, so one shape reaches every consumer. This is the lesson from the
  prompt work, where a non-string `name` would have thrown when React rendered it.
- URI validation is a host-side allowlist of schemes PLUS a character exclusion over
  the whole string. `file:`, `git:`, `https:`, and server-custom schemes are permitted
  as OPAQUE identifiers — the host never resolves them itself. `ui:` is reserved for
  the MCP-Apps extension path and is excluded here so the two never cross. The
  characters RFC 3986 excludes from a URI (space, `"`, `<`, `>`, `\`, backtick, `^`,
  `{`, `}`, `|`) are refused outright, so no consumer has to escape them: the same
  string is printed into a fence attribute, a tool result, an audit line, and soon a
  picker, and one of those already let a `">` in a URI break out of the fence. A
  legitimate URI percent-encodes them, so nothing expressible is lost — but note the
  consequence for stage 3b: an RFC 6570 template (`file:///{path}`) is rejected by
  this rule, so templates need their own predicate rather than a flag on this one — and
  the same applies one level up: a template's identity field is `uriTemplate`, not `uri`,
  so a picker item's `uri` would be a lie for one, and handing a brace-string to
  `isUsableResourceUri` refuses it into the generic-failure bucket.
- The same rule also refuses INVISIBLE and text-reordering characters (bidi overrides
  and isolates, zero-width, the default-ignorable set). A URI is an identifier, and one
  carrying `U+202E` renders `annual-<RLO>gnp.exe` as `annual-exe.png` while a zero-width
  space makes two different resources render identically — a user cannot tell which row
  they clicked. Refusing at the boundary rather than normalizing per consumer is forced
  by one consumer that CANNOT normalize: the audit row is a forensic record, and
  rewriting it would falsify it. Deliberately NOT the whole non-ASCII range — a
  filesystem server publishing a CJK or Hangul path is honest and common — but it is not
  "any non-ASCII is fine" either: the class is shared with the display sanitizer, so a
  name carrying an emoji variation selector or a ZWJ sequence is refused too. That is an
  ACCEPTED COST of one definition rather than two policies, and the boundary test pins it
  as an expected refusal so nobody later reads it as a bug. Display
  strings (`name`, `title`) are prose and take the opposite treatment: every codepoint
  is legitimate in them, so they are normalized at the render site instead.

`resources/templates/list` is discovered under the SAME two keys and the same
`resources` capability — a separate capability would ask the user a question they have
already answered. It landed with the mention UI rather than with the plumbing, because
a template is a URI pattern the user must fill and a catalogue nothing can render is
just a liability.

Templates get their own predicate (`shared/mcp-resource-template-bounds.ts`), and it is
**RFC 6570 Level 1 only** — `{var}`, no operators, no modifiers, no explode. That is not
a shortcut around the spec; it is the property the read path rests on:

  - Level 1 expansion percent-encodes everything outside the unreserved set, so a user
    typing `../../etc/passwd` produces one segment, not a traversal. `{+var}` is defined
    as RESERVED expansion, which does NOT encode `/` — accepting it would hand the server
    exactly that traversal, chosen by whoever is typing.
  - a value can never introduce URI STRUCTURE: `/`, `?`, `#`, `:` and `@` all encode, so
    what the user types stays inside the component the server put the variable in.

A server publishing an operator is refused at discovery and appears nowhere, which is the
fail-closed direction: an un-offered template costs a feature, an un-encoded one costs a
read outside what the server meant to publish. The predicate is written by REMOVING every
well-formed expression and validating the literal skeleton with `isUsableResourceUri`, so
the two rules cannot drift — a template cannot smuggle in a scheme or an invisible
character that a plain URI could not.

What Level 1 does **not** buy is a fixed scheme, and an earlier version of this section
said otherwise. A server may publish `{scheme}://host/{path}`: its skeleton `x://host/x`
is a legal server-custom scheme, so it catalogues, and the user picks the scheme —
percent-encoding is no help, because `javascript` and `ui` are already unreserved. Two
things hold instead, and both run on the EXPANSION rather than on the pattern: the
ordinary URI predicate re-validates the finished string, which is where a reserved scheme
dies, and the client re-derives the `https:` refusal from it. That is also why the
discovery-time `hostFetchRefused` flag on a template is display-only — it answers the
literal-scheme case for the picker, and the read never consults it.

`notifications/resources/list_changed` is **not handled** — no listener exists for it in
`src`, for resources or for templates. An earlier version of this line described a
debounced re-discovery as if it were implemented; it never was. Until it is, a catalogue
is what the server declared at connect, and a server that adds a resource mid-session
does not appear until the next connection. Corrected rather than deleted, because "we
consume the notification" is the kind of claim someone plans against.

### 4. Reading

`resources/read` returns `contents[]`, each either `text` or base64 `blob`.

- **text only.** A `blob` becomes an explicit placeholder naming its mimeType and
  byte count, never silently dropped and never decoded into the turn — same rule
  the prompt renderer follows for image/audio blocks.
- the read is gated on the URI having been **listed**. A URI the host never saw is
  refused before the request, so a model cannot use `resources/read` as a general fetch
  primitive against the server's URI space.
- a TEMPLATE read is gated on the **template**, exact-matched against what the client
  listed, and the host produces the URI itself. This is deliberately not "expand in the
  renderer, then check the URI against a pattern": that check needs a matcher, and a
  matcher for `file:///{path}` accepts `file:///../../etc/passwd`. Exact-matching the
  pattern and expanding host-side is the version that cannot be got wrong. The `https:`
  refusal is re-derived from the EXPANSION rather than inherited from the template,
  because a template's literal scheme is not necessarily its expansion's.
- a missing or blank value is a refusal, not an empty substitution: expanding `{path}` to
  nothing points at the directory above — a different resource than the user asked for,
  and one they cannot see they asked for.
- `https:` resources are NOT fetched by the host. The spec says servers should use
  that scheme only when the client can fetch it directly; Ave does not, because
  host-side fetching of a server-chosen URL is an SSRF primitive. Such a resource
  is listed and reading it returns a code the UI explains.

### 5. Bounds

Mirrors the prompt bounds, and shares the module where the numbers overlap:

| Bound | Value | Why |
|---|---|---|
| catalogued resources per server | 200 | the picker is a list a person scans |
| rendered text per read | 32 KB | larger than a prompt because a resource IS the payload |
| contents blocks per read | 32 | a read is one document, not a conversation |
| attachments per turn | 8 | keeps a mention storm from filling the window |
| URI length | 2048 | audit rows and labels interpolate it |
| name / title / description | 128 / 128 / 512 | host chrome renders them |
| template variables | 8 | a form a person fills, not a payload |
| template value length | 512 | bounded before it becomes part of a URI |

Every one of these is enforced in main, and the UI uses the same constants from a
shared module so a field the user can fill is never one main drops.

The composer's own `MAX_COMPOSER_ATTACHMENT_COUNT` (5) is a SEPARATE lane and resources do not count
toward it: that number bounds how many chips stay legible side by side, while this one
bounds how much server text a turn carries. Folding them would mean five attached
documents stops the user adding a screenshot, and would make the bound above unreachable
from the only surface that produces resource attachments.

### 6. Surfaces

Stage 1 — plumbing (no UI): discovery, sanitization, bounded read, governance
gating, audit. Exposed to the renderer through the existing `mcp:servers` state so
the picker work has data to build on.

Stage 2 — the model path: `mcp_resource_list` / `mcp_resource_read` builtin tools,
categorized `read` (never `write`), subject to the ordinary permission gate. Their
output is a `tool_result`, NOT a fenced block: that is the channel every tool
result already uses, the model reads it as data it fetched rather than as context
the host injected, and adding a second framing for one tool would make the fence
mean less everywhere else. The fence belongs to stage 3, where resource text is
attached to a USER turn and therefore does enter the prompt as context.

Because these builtins hand the model untrusted server content, they declare
`requiresMcpScope`, so the turn scope's `includeMcp` switch applies to them as it
does to MCP tools. Without it a builtin badge would be a way around the decision
that headless (routine) loops run with no MCP surface.

**Templates are deliberately NOT on the model path.** The expansion would still be
host-side and still percent-encoded, so this is not a containment gap — it is a reach
decision. A listed resource is a finite set the server chose to publish; a template is a
FAMILY, and handing the model one turns "read what this server published" into "read
anything matching this shape", with the model choosing the values. That is a wider reach
than stage 2 was argued for, and it should be argued for on its own rather than arriving
as a side effect of the picker work. Recorded here as a non-goal, not an omission.

Stage 3 — the user path, split at the process boundary the way stages 1 and 2 were:

  - **3a (landed):** `ave:mcp:attach-resource` reads a declared resource and
    returns the fenced block to attach. The HOST builds the fence — never the
    renderer — because this text lands beside the user's own words, which is the one
    place the model has the most reason to read it as the user speaking. The
    per-turn cap is enforced in main, not in the composer: the renderer decides what
    to offer, main decides what a turn carries. `McpManager.listDeclaredResources`
    is the one projection for callers that need the catalogue as a list (the model
    tools today); the attach path deliberately does not use it, so the listed-URI
    check stays in one place inside the client instead of being copied into the
    handler.
  - **3b (landed):** the composer `@` mention with autocomplete, and templates. The
    picker offers both kinds of row from one catalogue (`ave:mcp:list-resources` and
    `ave:mcp:list-resource-templates`, fetched together — two effects would each set the
    catalogue and the later one would erase the other's rows). A resource row attaches; a
    TEMPLATE row opens a host dialog, because a template is an offer rather than an
    identifier. The dialog collects values only; it never composes a URI.
    `ave:mcp:attach-resource-template` takes the template plus the values, and main
    expands, reads, and fences — keyed on the URI IT produced, which it hands back for the
    chip's label. That echo grants nothing: `attach-resource` is the only channel routing a
    renderer-supplied URI into the **core-capability** read, and that read is gated on the
    listed set, which an expansion was never in. Stated that narrowly on purpose — "no
    channel accepts a URI" is false (`attach-resource` does) and so is "no channel accepts
    an unlisted URI" (`mcp:ui-resource` does, on its external arm; see §7).
    Values cross the boundary as a plain object and become a `Map` immediately,
    so a variable named `__proto__` or `toString` is an ordinary key rather than an
    inherited slot. Both attach channels share the user-initiated rate bucket with
    `prompts/get`: one server, one budget for round-trips the user asked for.

The per-turn cap lives at the turn-entry chokepoint (`runStreamedTurn`) because
`chat send` and `sidechat send` parse their payloads separately, so a bound in one
would not exist for the other, and that is the one place attachments enter a turn. It
counts fence OCCURRENCES in the attached parts, so the bound is a property of what was
attached rather than of how the renderer packaged it — a composer that joins several
attachments into one part cannot spend more than the budget — and it REFUSES the turn
rather than trimming, because dropping the extras would leave the model answering from
fewer documents than the user believes it read.

Two things follow from counting ATTACHMENTS rather than all of a turn's text, and both
are decisions rather than omissions:

  - The user's own message text is never counted, even though a fence pasted there is
    indistinguishable from a host-built one. Counting it looked stricter and was worse:
    a refusal is only ever explainable when the host built the material, and a
    developer pasting an Ave transcript excerpt — which contains these fences verbatim
    — would otherwise be told to remove resources they never attached, with no way to
    discover why. A fence a user types frames their OWN words as less trusted, so it
    buys a forger nothing. It also kept the refusal off the replay paths, which matters
    more than it looks: `retryEffort` truncates history BEFORE streaming, so a throw
    there would leave a conversation permanently shortened.
  - Stage 3b therefore carries a hard constraint: **a mention must resolve to an
    attachment part**, never to text spliced into the user's message. That is the one
    field this bound does not measure, so 3b lands with a test that fails if the
    composer inlines a fence — a comment will not hold it.

    This constrains the WIRE shape, not the UI. The reference-host precedent in §1 is an
    inline `@server:uri` mention, and that stays available: the composer may render an
    inline chip while the material it sends rides as its own part, which is how
    attachment chips already work. Only conflating the two creates a conflict.

    And if 3b finds the part-only rule genuinely fighting the UX, the answer is NOT to
    widen the count back over the message text — that reintroduces both the false
    refusal and the history-truncating replay. It is to stop pattern-matching provenance
    altogether: have `attach-resource` return a handle, let the renderer pass it back,
    and have main resolve and count what IT built at send time. That makes the bound
    structural and retires the forgery and false-positive questions together. Written
    down here so the next person reaches for it instead of the input count.

The bound interacts with the user-initiated MCP rate bucket that prompts and attachments
share, which had to grow once attaching stopped being one click per call — at a flat 20,
three full-attachment turns in a minute hit `rate-limited` mid-turn. The bucket is NOT
derived from this bound, though it was briefly: it is a ceiling on requests to somebody
else's server, while this is a budget for our own context window, and deriving it meant a
change to our window budget silently re-deciding how hard a server can be hit. The
relationship is checked by a test instead, so moving either one forces a look at both.

The fence is `<mcp-resource trust="untrusted-server-data">`, registered in the
`FenceTag` union so its builder had to answer the escape question. Inside the fence
the body's own closing tag is neutralized (it cannot end the region and continue
outside it) and so is any opening tag (it cannot forge frames, which would let one
hostile resource spend the whole per-turn budget and refuse the user's send). Neither
rule requires a well-formed tag: `</mcp-resource` alone is neutralized, because a rule
that waited for the closing bracket was both quadratic on unterminated tags and — once
the span between was bounded to fix that — escapable by padding the close tag past the
bound. The consumer is a model reading prose, so "looks like a tag" is the standard, and
that makes tag-name matching the whole rule.
Attribute values printed into the open tag go through the same module's
`fenceAttrValue`, because an attribute carrying `">` is the other way out of a fence.
A clip is admitted in a line the model reads rather than a flag the UI could ignore.

Stages land as separate PRs. Stage 1 touches no cluster-sensitive path; stages 2
and 3 do (`src/tools`, `src/ipc`), so their owners should record proportionate
architecture, critique, and security consideration. The detector is advisory and
never requires an attestation or blocks merge.

#### Resolved decision: PII redaction covers attached resource text

The `piiRedactEnabled` privacy toggle applies in main immediately before the main
Composer's `ave:chat:send` turn reaches the provider. It processes the input and every
validated `type: "text"` content part together. On the normal Composer path those parts
are host-built MCP resource fences, so the SAME resource bytes that would be redacted if
pasted into the draft are also redacted when the user attaches them with `@`.

- The renderer still forwards its host-built fence byte-for-byte to main. With the toggle
  enabled, only the provider-bound copy may differ: sensitive spans become placeholders.
  This deliberately includes fence headers, so a matching value there no longer has
  literal source-byte identity in that copy. Fence tags, attachment order, image/file
  parts, user-origin provenance, and the raw keyboard `requestAnchorRawIntent` remain
  unchanged.
- The handler scans each text span separately and aggregates their counts into exactly
  one `redact_notice` and one count-only warning for the logical turn. The renderer
  therefore adds one system badge, not one badge per attachment.
- `redactForLLM` continues to emit count-only DLP audit rows per hit-bearing span. Their
  summed counts match the turn notice, but they are intentionally not a one-row-per-turn
  telemetry contract. The main session ID is resolved at the hit, so a new/resume/fork
  cannot attribute a later redaction to the boot-time session. These new DLP records and
  the warning contain no raw resource body or URI; existing resource-attachment metadata
  audit is a separate URI-bearing record and is not changed by this decision.
- For normal Composer resource attachments, the existing limits bound this additional
  scan to at most 8 host-bounded text parts of 32 KB each (about 256 KB). That is not a
  claim that arbitrary internal IPC `text` parts are bounded by the resource policy.

This scope is the main-chat provider boundary: normal Composer `chat:send` plus its
edit-resend, continue, and retry replay helpers. A replay can fold an older resource fence
into its input text, so applying the same boundary there also protects legacy/imported raw
history. If DLP rewrites a replayed staged-provenance header into a value the parser cannot
recognize, main retains only its fixed origin kind long enough to reject the replay
fail-closed; it does not forward the raw source as a side channel, and the pre-send history
truncate is restored. The current SideChat UI has no resource-attachment creation path, but its separate
internal API can carry attachments. It has a separate stream channel and session store,
while that attachment-capable surface currently has no DLP redaction, notice, or
side-session audit correlation. Extending it needs an explicit side-channel and audit
design rather than silently reusing main-chat behavior.

### 7. Deliberately excluded

- **`resources/subscribe`.** A subscription is a server-driven push into a live
  session — the channel-style surface, with its own re-entrancy and rate questions.
  It is not needed to close the consumption gap and it would be the only
  server-initiated context write in the app; it gets its own design if it is ever
  wanted.
- **Binary content in the turn.** Placeholder only, per §4.
- **Host-side `https:` fetching.** Per §4, SSRF.
- **Resource-derived tool provenance.** Per §2, the turn stays the user's.

#### `mcp:ui-resource` — the second `resources/read` caller (CLOSED)

Found while reviewing the template work, fixed straight after it. Recorded because the
shape is the point, not the incident.

`resources/read` is ONE wire method serving TWO host paths with different gates:
`readDeclaredResource` (gated on the listed set) and `readResource` (the MCP-Apps
extension). `CHANNELS.mcp.uiResource` takes a renderer-supplied `serverId` + `uri` and
reaches the second one. On the LOOPBACK arm that was already gated —
`plugin-ui-resource-provider.ts` refuses anything that is not a declared `ui:` URI. On the
EXTERNAL arm nothing in MAIN checked the scheme at all: the `ui://` restriction lived only
in the renderer's bridge handler, which is the side the threat model assumes is
compromised. Governance could not close it either — it sees one method and cannot tell the
two callers apart, so a non-`ui:` URI fell through to requiring `resources`, which any
resource-publishing server holds.

Net effect: a compromised renderer could read ANY URI from ANY connected external server.

The fix is one predicate, `isMcpAppUiUri` in `shared/mcp-app-partition.ts`, enforced in
`McpClient.readResource` — the method whose stated contract, since the day it was written,
was that it fetches a `ui://` resource. Governance's capability exemption now asks the
same predicate rather than its own `startsWith`, because the two decide one question ("is
this the Apps path?") and must not answer it differently: a URI governance exempts but the
client refuses is a dead request, and one the client would serve but governance refuses
breaks MCP Apps on a tools-only server.

The general lesson, which outlives this bug: **when two host paths share a wire method,
neither the method name nor the capability gate can tell them apart.** The gate has to sit
with the caller whose contract it is. That is the same reason the template read is gated
on the TEMPLATE rather than on the URI it produces.

### Security invariants

- No `resources/*` request leaves the host unless the capability was advertised at
  discovery AND approved by governance; unclassified methods fail closed. The ONE
  exemption is the MCP-Apps read: a `ui://` URI does not require `resources`, because
  a tools-only server may legitimately publish a card (§0). That exemption is keyed on
  the URI namespace, which is all governance can see — it is handed a method, not a
  caller — and it is bounded PER CALLER: by the scheme gate on the Apps path
  (`McpClient.readResource`), and by the listed-set / listed-template gates on the
  declared paths, which is where a `ui://` URI would have to have come from.
- `readDeclaredResource` accepts only a URI the host listed, and
  `readDeclaredResourceTemplate` only a TEMPLATE the host listed, expanding it itself;
  the URI is an opaque identifier the host never resolves. `readResource`, the MCP-Apps
  path, does not share the listed-set gate — it is restricted by SCHEME instead, to
  `ui://` only, enforced in main (see §7).
- Nothing a user types into a template can move the read off the component the server put
  the variable in: values are percent-encoded, so they cannot span components, and cannot
  BE a dot segment either — `.` is unreserved, so that one needs its own refusal. The
  expansion is then re-validated with the ordinary URI predicate, which is what stops a
  variable in scheme position from producing a reserved scheme.
- Resource text is bounded wherever it enters the host, and the shape it enters in
  depends on the surface: a `tool_result` for the model path (stage 2 — the channel
  every tool result uses), and an untrusted FENCE with the body's own closing tag
  neutralized for the user path (stage 3), because that one becomes prompt context.
- A resource can never carry tool authority: it is data in the turn, and the
  permission decision belongs to the turn's real origin.
- Wire fields are validated at the client boundary, so one shape reaches main, the
  renderer, and the audit log.

---

## Remote MCP authentication

Remote Streamable HTTP servers configured with OAuth, whether added in MCP settings or bundled with a plugin, can use browser authentication from their server row. Select OAuth for an HTTP server, save it, then choose **Authenticate**. An HTTP 401 challenge on that server marks authentication as required without opening a browser. The host opens the authorization page only after the user chooses the action, receives a loopback redirect, and reconnects through the existing MCP manager after authentication succeeds.

Authentication status is separate from connection status: `required`, `authenticating`, `authenticated`, `insufficient_scope`, or `error`. An authenticated server can still fail to connect because of transport, policy, or protocol errors. Background connection attempts never open an authentication browser. The authenticate action can be retried after failure.

The renderer receives status and one of these error codes, never access tokens, refresh tokens, client secrets, authorization codes, or authorization URLs:

| Code | Meaning |
| --- | --- |
| `mcp-auth-required` | No usable grant; choose **Authenticate**. |
| `mcp-auth-failed` | The flow or connection failed; retry. |
| `mcp-auth-storage-unavailable` | Encrypted secret storage is unavailable, so no flow starts. |
| `mcp-auth-storage-unreadable` | A saved credential record could not be decrypted or read. |
| `mcp-auth-registration-unsupported` | The configured client registration cannot be used with this server. |
| `mcp-auth-resource-mismatch` | The protected-resource metadata describes a different resource than this endpoint; nothing was registered or opened. |
| `mcp-auth-index-unreadable` | Shown on the server row while the credential index cannot be read; stored sign-ins are not cleaned up until it is rebuilt. |

Each code has English and Korean text in the MCP settings tab.

The flow follows the MCP authorization specification revision `2026-07-28` (the current revision as of 2026-10-22): [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [authorization server discovery](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery) and [client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration).

### Ownership and reuse

| Responsibility | Owner |
| --- | --- |
| MCP framing, HTTP transport, tool discovery and invocation | Existing `McpClient` and `HttpTransport` in [`mcp-client.ts`](../../src/mcp/mcp-client.ts) |
| Authentication session, discovery, token attachment and refresh | [`mcp-oauth.ts`](../../src/mcp/mcp-oauth.ts) |
| Connection lifecycle and tool registration | [`mcp-manager.ts`](../../src/mcp/mcp-manager.ts) |
| Encrypted credential persistence | Existing `SettingsService` secret methods and secret document store |
| Loopback callback listener | Existing [`AuthRedirectCatchers`](../../src/main/auth-redirect-catcher.ts) |
| Outbound HTTP | Existing host `singleHopNetworkFetch` and [`network-guard.ts`](../../src/core/network-guard.ts) |
| Discovery, registration, PKCE and token request primitives | Installed protocol SDK authorization helpers |

No alternate MCP transport or credential file is introduced. The host supplies browser opening and callback capabilities during boot. Authentication does not grant permission to invoke tools; discovery and invocation retain the [architecture's permission and audit requirements](../architecture/architecture.md#mcpplugin-execution-parity-invariant).

### Discovery and authorization

The session reads `resource_metadata` and scope information from a server's `WWW-Authenticate` challenge. Without that metadata URL it tries the endpoint-specific protected-resource well-known URI, then the origin's well-known URI. Protected-resource metadata is required; the MCP origin is never guessed to be the authorization server.

The resource identifier must match the configured endpoint exactly, or use the same origin with a containing path at a segment boundary and no query component. When the metadata was located through a challenge's `resource_metadata` parameter, its `resource` must be identical to the endpoint's canonical URI ([RFC 9728 §3.3](https://www.rfc-editor.org/rfc/rfc9728#section-3.3)). A mismatch in any of these checks, or against a configured `oauth.resource`, fails with `mcp-auth-resource-mismatch`. The selected value sent on the wire is the resource the metadata declares. Validation happens before client registration, browser opening, or credential transmission. The authorization server comes from the validated resource metadata. Its metadata is discovered using the standard authorization-server and identity-provider well-known locations, including issuer paths. Its `issuer` must exactly match the selected issuer identifier.

Authorization requires metadata that explicitly advertises PKCE `S256`. The session records the issuer, a fresh state value and the code verifier for that attempt in host memory. It validates state and any returned `iss` before exchanging a code; when metadata sets `authorization_response_iss_parameter_supported: true`, a missing `iss` is rejected too. Issuer comparison uses the decoded string without URI normalization.

The selected resource identifier is included in the authorization request, authorization-code exchange and refresh request. It is sent in canonical form ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)): an origin-only resource has no trailing slash, and a path keeps its exact spelling. The SDK helpers serialize a parsed URL, which always adds a slash after an origin, so the session sets the `resource` parameter itself. Access tokens are attached only to requests to the configured MCP endpoint. Metadata and token requests use the host's egress transport with URL validation, timeout policy and redirect rejection. Production authorization endpoints require HTTPS. Explicit private-network configuration permits loopback HTTP for local development; it does not permit insecure non-loopback authorization endpoints.

The initial unauthenticated resource request can discover a challenge, but a successful anonymous response never reaches capability discovery. Later requests cannot fall back to anonymous access after losing a grant. A failed initial network request can be retried without granting anonymous access.

### Client registration

The session chooses a client in the order the client-registration specification recommends:

1. **Pre-registered client.** When `oauth.clientId` is set, it is used as a public client (`token_endpoint_auth_method: none`). No metadata document is fetched and no registration request is sent. The ID must be 1 to 256 visible ASCII characters with no spaces. It can be combined only with an omitted `clientRegistration`, `preregistration` or `manual`. The operator registers the redirect URI `http://127.0.0.1` with any port.
2. **Client ID metadata document.** When authorization-server metadata sets `client_id_metadata_document_supported: true` and either omits `token_endpoint_auth_methods_supported` or lists `none`, Ave uses its published document as the `client_id`: [`https://ave.agent-connector.ai/oauth/mcp-client.json`](https://ave.agent-connector.ai/oauth/mcp-client.json). Its source is [`web/public/oauth/mcp-client.json`](../../web/public/oauth/mcp-client.json), and the web deployment serves it as `application/json`.
3. **Dynamic registration.** This is the deprecated compatibility path, used when the server advertises a registration endpoint. A saved dynamic registration is reused only when it was issued by the same authorization server, has not expired, and lists the redirect URI of the current flow. Otherwise the session registers again. A registration response that names `client_secret_basic` or `client_secret_post` must carry a secret and name a method the token endpoint lists. A response that names `none` is a public client and is accepted even when `token_endpoint_auth_methods_supported` lists only secret methods, as GitLab's does.

An omitted `clientRegistration` follows this order. If the server then refuses the metadata document — an `invalid_client` or `unauthorized_client` error on the authorization callback (acted on only after its `state` and RFC 9207 `iss` check out) or at the token endpoint — the same **Authenticate** action runs the flow once more with dynamic registration, and later flows in that session go straight to registration. A refusal shown only in the browser, without a redirect back, cannot be detected and ends as a timeout. `client-id-metadata-document` requires the metadata document and never falls back. `dynamic` uses only registration. When the configured mode cannot be used with the server, the flow stops with `mcp-auth-registration-unsupported`. This happens before a callback listener opens or a browser starts. Modes are never silently converted.

The callback listener binds `127.0.0.1` on an ephemeral port, so each flow can use a different port. The metadata document and pre-registered clients therefore list `http://127.0.0.1` without a port. [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3) requires authorization servers to accept any port for a loopback IP-literal redirect. [§8.3](https://www.rfc-editor.org/rfc/rfc8252#section-8.3) discourages `localhost`. Other callers of the shared callback listener keep their `localhost` default.

This feature covers HTTP transport authorization. Stdio credentials keep their existing configuration path.

### Step-up authorization

A token-bearing request answered with HTTP 403 and `error="insufficient_scope"` records the challenged scope and metadata location. Status moves to `insufficient_scope`, and existing tools stay registered. No browser opens. The next **Authenticate** action requests the union of the granted and challenged scopes. A failed step-up keeps the previous grant and status; a token response is validated before it can replace the stored grant. Each challenged scope set gets at most two step-up attempts per session; after that the 403 is returned as an ordinary failure. This keeps the specification's "no more than a few times" bound.

### Bundled servers

A plugin-bundled OAuth server is withheld from activation until it is authenticated. Its lifecycle records `credential_required` (retryable). Its settings row offers **Authenticate** under the bundled configuration ID. The session key is derived from the package and server name, so a regenerated runtime ID keeps the same credentials. A successful action disconnects that server's runtime instances and asks the bundled credential source to reconnect. The connection then sends requests through the authenticated session. No host code branches on a specific plugin.

Bundled grants are recorded in the credential index under their stable ID. Each package kind registers a bundled-credential source: agent plugins from installed content, and app plugins (`plugin/…`) from the plugin lifecycle. The app-plugin source lists the OAuth servers of active generations and reconnects one by preparing and publishing that generation's MCP servers again, as a trust change does. Its installed set comes from the plugin registry, so a disabled or not-yet-loaded plugin still counts as installed; a missing, unreadable or mid-replacement registry cannot vouch, and nothing is pruned then. A grant is retired only when its package is gone from the installed set, or when a package the source lists no longer declares that server. Pruning also waits while a marketplace package install, update or uninstall holds or waits for a package lock (`MarketplaceService.packageTransactionsIdle`); this is checked again when the queued work runs. A reconcile that a package transaction or an unvouched installed set defers is marked and runs again when the marketplace releases its last package lock. When an app-plugin uninstall commits its registry removal (from the marketplace or from plugin settings), the manager revokes that plugin's grants and disposes its sessions at once, whatever the installed set says later. A reinstall of the same ID that commits before the package locks settle therefore starts signed out, and a session it prepares while the revocation is still running reads the store only after it. Retiring a grant always disposes its in-memory session, so a reinstalled plugin asks to authenticate again.

When a source can vouch for its installed set, it also indexes declared bundled OAuth servers that are not indexed yet, using the credential key their session would use (derived from the stable ID, URL and OAuth metadata). This covers an index rebuilt before those servers were prepared: the rebuild includes them from sources that can vouch at that moment, and the others add them when they next can.

Agent-plugin packages cannot declare OAuth servers in their static MCP format, so bundled OAuth servers in practice come from app plugins.

### Token lifecycle and failure behavior

Stored registration and token records are bound to the server configuration, selected resource and authorization issuer. The credential key derives from the server ID, URL and OAuth configuration. Discovery rejects reuse if the issuer or resource changes. Each record also stores its client source, and a record with an unknown source or a non-canonical resource is not used.

Secrets use the existing encrypted store. Encryption availability comes from the settings service (`isSecretStorageEncrypted`), which is the same source the secret writer uses. It is checked before discovery, a callback listener, or registration. An unavailable backend stops the flow with `mcp-auth-storage-unavailable` and never creates a plaintext credential path. A record that cannot be read sets `mcp-auth-storage-unreadable`; the next action reads storage again.

A metadata location supplied by a challenge is retained in the encrypted record so refresh can rediscover it after restart. The host still validates the URL, resource and issuer again before using stored credentials.

Refresh preserves a prior refresh token when the issuer omits a replacement and stores a rotated refresh token when supplied. Within one server session, concurrent refresh requests share one refresh operation, and concurrent authenticate actions share one login operation. Each HTTP request permits one refresh and one retry after a token-related HTTP 401. Repeated HTTP 401 responses do not create an unbounded retry loop.

A permanent grant rejection clears saved tokens and returns the server to `required`, allowing the user to choose **Authenticate** again. A rejected client registration also clears the client credentials. Transient refresh failures preserve saved credentials and set `error`, allowing a later retry without discarding a usable refresh token. Credential generations prevent an obsolete refresh result from overwriting newer login credentials or clearing their authority.

The callback listener is released after success, cancellation, failure or disposal. Session creation is synchronous per server, so concurrent connections share one session. The manager keeps an encrypted index from server ID to credential key. Replacing a session deletes the old record only when the credential key changed. An unrelated edit, such as a header, keeps the grant: the old session first lets a refresh it has in flight finish and persist (a rotated refresh token is not lost), and the new session reads the record after that. Removing a server deletes its record after the configuration file is rewritten, and removal does not fail when the old URL no longer parses.

At startup, records in the index that no configured server uses are deleted, which also covers configuration edits made while Ave was not running. This happens only when the configuration file itself was read and parsed. A missing, empty or unparsable file, a file without a top-level `servers` array (`{}`, another app's `mcpServers` map, a misspelled key, a bare array), or a legacy `.bak` fallback deletes nothing, so a syntax or shape error cannot sign the user out of every server. A wrongly shaped file is logged as a configuration error like a parse failure, not read as an empty list. While the file exists but is invalid, adding, updating or removing a server is refused with a configuration error (en/ko) instead of rewriting it, so the user's content is never replaced; a missing file with only a legacy `.bak` can still be written. A first run has neither a file nor an index. An index that cannot be read or parsed is logged as an error and shown on OAuth server rows. Nothing is deleted on its account. After the next successful configuration load it is rewritten from the keys known then; records it had listed for servers that no longer exist stay in the store, unreferenced.

Kill, removal and shutdown retire pending authentication before connection teardown. Lifecycle generations and the configuration critical section prevent a delayed login from reconnecting or registering tools after retirement. Losing authorization also removes the server's available tools. Provider response bodies and credential-bearing URLs must not appear in logs, IPC responses or user-facing errors.

### Verification

The runtime tests use local HTTP servers. Most run with the explicit private-network option; one integrated case addresses the mock server by a public HTTPS host name so resource, metadata and token requests pass through the network guard's public-address resolution without that option. They inspect actual registration and token requests, verify the challenge against the received verifier, and exercise authenticated MCP requests. Required cases are discovery from a challenge and well-known metadata, issuer and resource rejection, PKCE `S256`, resource parameters on each grant, refresh rotation, revoked-token reauthentication, bounded retry, state and callback issuer rejection, and credential isolation.

The authorization-server fixture is strict. It checks redirect URIs exactly at authorize and token time. Only a loopback IP literal ignores the port. It rejects unknown clients and validates a fetched metadata document's `client_id`, required fields and redirect URIs. Mode cases cover selection order, metadata documents, pre-registered clients without registration, re-registration for a new redirect URI after revocation, step-up and its limit, origin-only resources, challenge resource equality, and storage failures before any browser step.

Manager tests cover authentication state, reconnection through governance, session disposal, tool removal, retired login races, credential-identity deletion, orphan cleanup, concurrent session creation and bundled authentication. The integrated manager/session/client mock flow exercises the real transport and authorization boundaries together. IPC and preload tests cover the typed authenticate action and sender validation. The changed MCP-settings browser flow checks action availability, busy state and status rendering. A mock issuer validates protocol behavior; it does not establish interoperability with an external authorization service or the availability of a machine's encrypted storage backend.
