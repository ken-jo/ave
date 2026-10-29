# Permission rules, remembered approvals and judge settings

The [permission decision tree](../architecture/permission-decision-tree.md) is the single source of execution order, mode behavior, forced floors, reviewer outcomes and human availability. The [permission policy](../architecture/permission-policy-design.md) owns path/effect evidence, native execution, approval delivery and sandbox boundaries. This document records the rule language, approval-storage identity and judge configuration that support those decisions. It does not define another decision sequence.

User-owned browser and host-terminal actions follow their independent [session surface choices](../architecture/permission-policy-design.md#user-owned-surface-choices). Global mode, generic remembered approvals and exact shell rules do not replace that choice. The dedicated surface Auto check examines logical task/target consistency rather than general risk. Admission, deny rules, explicit ask rules and genuine principal/taint or exfiltration floors remain authoritative. A matching ask rule requires a normal card before the surface choice. Browser payment and irreversible-submit guards use bounded English/Korean element/form-attribute heuristics over recognizable live DOM targets. Native credential and manual-submit controls remain enforced; these checks do not prove the business effects of arbitrary site scripts or detect every payment/irreversible action.

## Decisions

### P1: rules and "Always allow"

One [parser](../../src/permissions/rules/rule-specifier.ts) owns rule syntax for Settings, approval cards and rule files.

| Rule | Identity |
| --- | --- |
| `Bash(<prefix> *)` / `PowerShell(<prefix> *)` | Literal command prefix in the named dialect, within the matcher's supported grammar. |
| `Bash(<exact>)` / `PowerShell(<exact>)` | Complete original raw words in that dialect. Quote style, argument content and program spelling remain part of the key. |
| `Edit(<path-glob>)` | Absolute or project-relative target; supported `*`, `**` and `?` patterns, with trailing `/**` also covering the directory. |
| `WebFetch(domain:<host>[:port])` / `WebFetch(domain:*.<host>[:port])` | Exact hostname or strict subdomains, with the configured port restriction. |
| `Mcp(<server>)` / `Mcp(<server>:<tool>)` | Registered server and original tool identity. |

Parsing is strict. The retired `HostTerminal(...)` grammar is not accepted or saved. Existing stored entries are listed as no longer used and can be deleted; they never match or grant authority. Legacy action-key patterns that do not have a rule-specifier prefix retain their existing glob representation; exact approvals are not converted into structural rules.

Shell matching normalizes interword whitespace only. Program/module spelling, quote characters and argument bytes remain raw identity. Detection may normalize a basename, suffix or case without rewriting that key. An inner-only rule cannot authorize an outer wrapper command. Dialect-specific allow rules do not cross into another dialect.

Fresh shell allow rules carry the current `SHELL_RULE_CANONICAL_VERSION`. Unversioned or wrong-version allows remain inert; deny and ask rules keep their narrowing authority. Reading or rewriting unrelated data does not reconstruct lost quote provenance or stamp an older row current.

### Approval and memory identity

Command rules, exact remembered approvals, directory grants and user-owned surface choices have different owners:

| State | Owner and scope |
| --- | --- |
| User command rules | `permissions.json` under the application home. |
| Project command rules | `permissions/project-rules/<identity>.json` under the application home; never written into the user's repository. |
| Exact remembered approvals | `permissions/user-approvals.json`, plus in-process session entries, through [user-approval-store.ts](../../src/permissions/user-approval-store.ts). |
| Additional directory authority | The owning permission settings store and its validated project roots. A generic tool allow does not create an external directory grant. |
| User-owned surface choice | Conversation-session and surface key in memory only, separate from generic approval memory and cleared at session teardown. |

[Project Rule Scope](../architecture/permission-policy-design.md#project-rule-scope) owns canonical repository discovery, linked-worktree identity, the home boundary and retained exact-directory scopes. Files are reread when they change; stored scope identity is not silently widened or copied to another project.

Generic exact approval identity binds tool, source, trust origin, host-derived argument or target identity and captured canonical working-directory identity. Canonical JSON hashing removes irrelevant object-key order differences. A tool's target-wide memory contract may replace exact arguments only where the host explicitly declares that semantic identity; it cannot be inferred from display text. Restrictive exact-input decisions retain their narrowing authority.

Generic session approvals are held under the resolved root conversation, including its children. Separate roots do not share them, and a missing session cannot receive a session grant. Process exit clears these entries. This generic root-conversation lifetime does not change the independently keyed user-owned surface choice.

Persistent exact approvals may be project-bound or global. Deny beats allow across scopes. Among eligible allows the conversation, project and global entries are consulted under their existing identity. Corrupt or unreadable policy stores fail admission closed under the decision tree; they are not ignored or replaced with reviewer permission. Repair must preserve unrelated state and cannot silently overwrite corrupt bytes.

### Approval rules UI

Ordinary cards offer only the choices supported by that request: once, session, persistent/project/global, folder or prefix. Forced floors offer this invocation only, without reviewer or reusable approval. The separate user-owned surface card offers its three session choices; generic command-rule controls do not substitute for it.

A shell remembering choice records a command rule in its selected scope, not an unrelated exact Store B grant. An unedited suggestion is host-derived; an explicit broader prefix must pass the shared [prefix policy](../../src/permissions/rules/shell-prefix-policy.ts). Rule-suggestion eligibility is not a second permission mode. Destructive or otherwise excluded suggestions remain refused according to that validator, even when ordinary mode policy can approve a particular invocation.

The renderer sends the selected action/scope and an edited pattern where offered. Main validates the card owner, grammar, applicable scope and that the rule covers the live request. Invalid, nonmatching or unwritable saves report an error and leave the card pending. Shell wildcard allows warn about broader scope; network wildcard allows retain their sandbox-only warning. The warning text does not authorize an effect.

A same-card rule save can advance policy identity only through the host's exact pending-request transition receipt. The receipt binds the authenticated decision object, expected before/after epochs and validated scope, and is consumed once. It grants no action, replaces no sender/signature check and cannot absorb unrelated changes, overlapping saves or replay. Final execution rechecks current policy after asynchronous route preparation.

Settings lists user/project rules and persistent/session exact approvals together with their stored identities. Revocation affects later permission checks; it does not answer an existing pending card. Unavailable scope files remain visible and revocable without silently rewriting their root identity.

### Scoped rule storage

`Edit`, `WebFetch` and `Mcp` use the existing validated global/project rule files. Host-created subjects bind actual canonical targets, reached URLs or registered foreign-tool identity. Tool-name resemblance does not establish any of these subjects.

Edit rules consider all sealed targets: every target must be covered by an allow; any matching deny or ask is retained as restrictive evidence. Moves/copies cover both endpoints and extraction covers archive/destination plus reached-entry enforcement. Relative globs use the discovered project root. Malformed patterns, ambiguous separators and escaped targets do not create broader authority. The [project-write contract](../architecture/permission-policy-design.md#project-file-writes) owns checkpoint eligibility, protected controls, secret-file distinctions and the single outside-write card.

Network rules describe URL host identity, not resolved address identity. The owning URL guard retains scheme, credential, DNS, private/reserved-address, redirect and destination checks at every reached effect. An allow rule is not an SSRF override or a plugin-domain grant. Credential/exfiltration evidence is supplied to the central pipeline rather than treated as an ordinary rule bypass. Browser user-owned surface choices and site/device protections remain separate.

MCP rules use the original server/tool identity. Read-only annotations and remaining first-use/per-tool memory behavior follow the decision tree and host adapter; an annotation never expands a manifest, account or process capability. A remembered tool decision cannot authorize unrelated plugin effects.

## Rule implementation

### Where the code is

- [decision-pipeline.ts](../../src/permissions/decision-pipeline.ts): the ordered decision owner.
- [permission-manager.ts](../../src/permissions/permission-manager.ts): trusted normalization and identity-bound review/memory redecisions.
- [rule-specifier.ts](../../src/permissions/rules/rule-specifier.ts), [shell-rule-matcher.ts](../../src/permissions/rules/shell-rule-matcher.ts) and [rule-scopes.ts](../../src/permissions/rules/rule-scopes.ts): grammar, dialect matching and scope composition.
- [scoped-rule-matcher.ts](../../src/permissions/rules/scoped-rule-matcher.ts): edit, network and MCP rule evidence.
- [rule-files.ts](../../src/permissions/rules/rule-files.ts) and [project-rule-files.ts](../../src/permissions/rules/project-rule-files.ts): validation and persistence.
- [user-approval-store.ts](../../src/permissions/user-approval-store.ts): exact approval identity and storage.
- [shell-argument-grammar.ts](../../src/permissions/rules/shell-argument-grammar.ts) and [verified-shell-command.ts](../../src/permissions/verified-shell-command.ts): static command facts and sealed native execution proof.

### Decision path

The [canonical tree](../architecture/permission-decision-tree.md) owns precedence. Callers provide host-created `ruleSubject`, canonical/lexical effects, project cwd, actual execution plan, trusted principal and human availability. They do not own another category/mode matrix.

Ordinary host shells and sandbox escalation use mode/human routing; they are not intrinsically exact-rule-only or forced one-shot. Ordinary secrets follow file/mode policy, while host credential stores retain admission denial and protected controls retain their specified floor. Ask rules are restrictive inputs to the mode decision; they are not automatically a new forced-floor class. Unproven/destructive evidence is ordinary unless it establishes one of the contract's actual floors.

The turn breaker routes only subsequent reviewer-bound requests to a normal human card, or denial without an approver. Earlier read, memory, rule, sandbox-auto and checkpoint-write outcomes retain their results. Admission denies and forced floors retain their outcomes. One human answer does not reopen that turn's reviewer automation.

### Shell matching authority boundary

Static evidence is not permission. `static-complete` means a registered grammar consumed the original command name and every argument with known roles. Unknown commands/options, incomplete operands, expansions, substitutions, callbacks, generated arguments, runtime state and analysis-limit refusals leave the request unproven. A matching rule or reviewer cannot manufacture a native proof; conversely, lack of proof is not an independent mode matrix.

Literal evaluator payloads remain opaque. A supported outer grammar may describe the exact literal command without inspecting payload effects. File/stdin/network indirection is not read or executed during analysis. Wrapper boundaries retain original command identity. Runtime argv producers do not acquire proof by reusing a suffix suggestion or a same-input file.

The [canonical shell contract](../architecture/permission-policy-design.md#shell-credential-and-sink-classification) owns parser bounds, positive grammars, visible credential/sink evidence, startup recipes and their accepted limits. The [checked repository-read contract](../architecture/permission-policy-design.md#checked-repository-reads) owns executable/metadata binding, output revalidation and native residuals. This document does not duplicate those catalogues or reinterpret their refusal as a different permission outcome.

### Shell classification buckets

| Evidence | Meaning | Consumer |
| --- | --- | --- |
| `visible-floor` | A literal path, credential source, sink or catalogue effect was observed. The label alone does not make every secret path a forced floor. | Normalize to actual admission, forced-floor or ordinary secret/effect evidence under the decision tree. |
| `unproven` | Parsing/grammar/budget/runtime facts do not provide complete static proof. | Central shell mode/human decision, with actual native preparation and confinement still enforced. |
| `static-complete` | The registered grammar consumed every original literal operand without unresolved runtime dependence. | Evidence for rule matching/read-only or sandbox handling; not a grant or an exact-only host-shell requirement. |

### Retained credential and sink floors

The host distinguishes protected credential stores from ordinary secret files and protected control paths. It also retains recognized direct credential-export/upload effects and critical delete/escape evidence. The [sensitive-path owner](../../src/permissions/sensitive-paths.ts) and canonical policy own exact membership and normalization. There is no blanket secret-path forced-floor table here.

Literal outer-command evidence can remain visible through a supported wrapper range. Detection may normalize a program name without changing its raw rule identity. Opaque code, variable values and runtime-produced arguments are not recursively interpreted to invent effect proof. Typed direct exfiltration remains forced even when the rest of the request is unproven; mere risky-looking payload text is not an additional floor category.

### Runner identities

Wrappers/interpreters remain in the complete raw command identity. Host-issued verified-launcher evidence binds original text, dialect, cwd, selected executable and owned argv/environment; a renderer, tool argument or copied result cannot mint it. Native preparation may still fail independently of a permission allow. The canonical startup/launcher contract above owns each supported recipe and its uncertainty limits.

### Dialect-scoped rules and grants

Bash and PowerShell rules retain distinct matchers and raw keys. Current shell-rule versions prevent old quote/identity provenance from being assumed valid. Host-terminal execution remains bound to the actual shell, physical cwd and shared surface choice; retired exact-terminal rules supply no authority. Read approvals, command rules and effect descriptors cannot be borrowed across another principal, destination or native execution plan.

### Egress and verification boundary

Shell-network grants remain bound to invocation/principal, destination class and lifetime. Current rule and permission evidence is reevaluated before cached answers or grants continue another phase. Native terminal connections keep their own authenticated ownership. Network allow is never an override of reserved-address, account, manifest or active-confinement requirements.

A sandbox filesystem block can request fresh host escalation only from trusted per-command native evidence. Current native attribution is available from the macOS monitor; installed Linux diagnostic attempts are rejected and retain the original failure. Controlled executor tests prove policy orchestration, not a native Linux supervisor. No worker grant is relaxed in place and no stderr/copy/untrusted metadata creates replay authority.

### P2: judge slot

`PermissionJudge` is the ordinary automated-risk seam. [judge-contract.ts](../../src/permissions/judge/judge-contract.ts), [judge-settings.ts](../../src/permissions/judge/judge-settings.ts) and [judge-engine.ts](../../src/permissions/judge/judge-engine.ts) own stage shapes, normalization, transport selection and execution. The permission tree owns eligibility and final outcome routing; this section records configuration rather than another decision order.

Ordinary global auto mode uses LOW/MEDIUM as the fixed allow behavior. HIGH, error, unavailable/malformed response or live abort falls back to a normal card; headless ordinary auto reviews first and denies required human fallback with no-retry guidance. The retired interactive off/low/medium selector is not another policy axis. User-owned surface Auto uses a dedicated logical-only prompt without general-risk cache reuse; headless surface actions always deny.

#### Settings and model selection

The persisted configured chain is ordered `permissions.judge.chain`. A stage has a unique id and its validated builtin/external provider fields. The settings parser owns defaults and any retained read compatibility; this prose does not introduce a fallback provider or a permissive partial chain.

```json
{
  "permissions": {
    "judge": {
      "chain": [
        {
          "provider": "external",
          "id": "selection",
          "escalateBelow": 0.8,
          "external": { "command": ["/opt/example/judge"] }
        },
        { "provider": "builtin-llm", "id": "review" }
      ],
      "mode": "shadow",
      "categories": { "shell": true, "write": true, "network": false }
    }
  }
}
```

A configured chain defaults to shadow: its result is audited without replacing the authoritative ordinary reviewer decision or adding breaker counts. Active stages apply only where the central pipeline allows review. External confidence thresholds use the stage contract; builtin risk verdicts do not pretend to provide that confidence. A stage ambiguity/failure may advance within the configured deadline; exhausted or failed review never silently permits execution. Explicit chains retain their budgets and cancellation; the implicit builtin path keeps the classifier's existing transport/retry limits.

`permissions.judge.model` selects the reviewer model. Unset follows the active chat model; an explicit stage model uses its selected provider/model. Missing credentials, missing model or provider failure does not silently choose another model. Settings read issues are visible. Corrupt/unreadable permission authority is admission denial before reviewer routing, not forced approval or queued permission.

Invalid settings writes fail before persistence. Valid writes preserve unrelated settings. A failed runtime refresh may roll back only while the written subtree still matches the write receipt; a later independent change is preserved and reported. Judge configuration remains user-only protected state. The owning permission authority is distinct from the app preference that stores owner-away waiting.

#### Transport, evidence and hooks

External command transport is a nonempty argv array with an absolute executable, launched without a shell and with a minimal environment allow-list. URL transport is HTTPS or permitted loopback HTTP, without embedded credentials. Bounded redacted stderr is diagnostic data, never a verdict. The host redacts external request/audit projections.

Requests require host-created invocation and conversation/task identity. General review receives normalized invocation, current user intent, rule/path facts and actual sandbox state; these facts do not certify unobserved plugin effects or native isolation. General tool results are not instructions to the reviewer. Logical surface review uses the user request/current task step and actual target/action identity specified by its separate contract.

User script PreToolUse runs before target authorization and only blocks; argument rewriting finishes before authorization. Judge hooks may redact, ask or deny within their contract, but cannot mutate the executing invocation or widen a decision. A judge may suggest a rule; only authenticated user intent may persist one.

#### Breaker, approval delivery and history

The shared breaker counts each completed classifier non-allow once per invocation in the active root turn. Three consecutive or twenty total blocks send subsequent reviewer-bound requests in that turn to normal human routing. Earlier pipeline allows, including ordinary reads, rules, remembered grants, sandbox-auto and checkpoint writes, remain unchanged. Allowed review resets only the consecutive count. Failures, aborted assessments, shadow observations and separate host rejections do not count as completed classifier blocks. Human approval does not reopen automation during the same turn; a fresh turn resets the turn state.

Only the registered application owner's exact native main frame can answer its current signed card. Focus, persisted ancestry, subframes and plugin/browser content cannot supply authority. Legitimate host-owned attachment transfers delivery; it does not isolate the application against its own compromised renderer. Capability, principal, exact action, current policy epoch, audit integrity and cancellation are checked again immediately before handler entry, after asynchronous preparation and without an await before the effect.

Owner-away cards wait indefinitely by default; an optional configured interval denies unanswered requests with no-retry guidance. True no-approver outcomes deny rather than queue an approval. Recently denied stores bounded redacted summaries and non-executable references to existing saved invocations. An explicit user rerun revalidates the reference and enters admission with a fresh human card while retaining the original session and turn-origin restrictions. Its manual consent never replays a stored decision or restores an ended turn's native authority. Parent-model and delegated away deciders are retired.

#### Audit and verification

The existing HMAC-protected audit records active stage identity, normalized/redacted request, final result, rationale and fallback; shadow uses its own channel. Active audit failure prevents execution. Cached reviewer evidence remains bound to the existing invocation/policy/substrate identity and cannot bypass a floor or pause. A fixture classifier result is evidence about that test, not proof of live provider behavior.

## Tests and document readers

The registered reader is [fixtures/runner-decisions.ts](../../src/permissions/__tests__/fixtures/runner-decisions.ts), consumed by [runner-decisions.test.ts](../../src/permissions/__tests__/runner-decisions.test.ts). That fixture is maintained as independent classification data; this document does not embed executable case expectations.

Relevant targeted suites also include the decision-pipeline/golden matrix, scoped-rule/storage, user-approval identity, shell rule/version, judge dispatch/breaker, effect/egress, user-owned surface, native approval/frame and same-card policy-transition suites. Run the recorded reader and the owning changed-boundary tests through the repository runner. This documentation update does not claim their latest results or replace the [validation record](permission-pipeline-validation.md).
