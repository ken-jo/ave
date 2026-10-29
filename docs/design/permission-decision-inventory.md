# Permission decision inventory

Snapshot: `e7c46b48c60df3ed632d4250fc2947e61d8656d1`, clean `feat/permission-pipeline-v4`, also `origin/main` after fetch on 2026-10-30. Line anchors below refer to this snapshot, not to the older snapshot in the supplied diagram. This is an implementation inventory, not a shipped policy specification.

Understood as: inventory the current main implementation and map every tool authorization decision to the approved ordered pipeline; stop before refactoring until the lead (the task requester or coordinating owner) confirms the prerequisite write-policy change is on main.

The approved input is the supplied workspace artifact `/private/tmp/cx-perm-v4/permission-trees.html`, section 4, read together with the owner's task brief in the coordinating conversation. Those inputs must accompany this snapshot at handoff; this inventory does not replace their full policy definitions. Repository policy context: [Tool Governance](../architecture/architecture.md#tool-governance), [Security And Audit](../architecture/architecture.md#security-and-audit), and [Permission Policy Design](../architecture/permission-policy-design.md). The repository copy of this inventory lives in `docs/design/permission-decision-inventory.md`; the requested workspace `INVENTORY.md` is a delivery copy with identical bytes. Relative links resolve from the repository copy.

## Stage legend and scope

| Label | Responsibility |
| --- | --- |
| S1 | Admission, finalized argument hooks, immutable deny rules. |
| S2 | Forced one-shot floor: protected paths, critical deletion, project escape, exfiltration, other-principal turns. Headless means deny; no reviewer or memory. |
| S3 | Ask/allow rules and remembered grants, with ask precedence. |
| S4 | Kind and resource classification: read, secret read, MCP annotation, network, checkpoint-backed project write, sandboxed shell. |
| S5 | Mode and human availability: strict/default ask, auto review, allow pass; unavailable approval denies with no-retry guidance. |
| S6 | Reviewer result and turn breaker: low/medium allow; high/error/abort ordinary ask; 3 consecutive or 20 turn denials delegate the remainder to the human. An ended/aborted turn still cannot execute. |
| S7 | Card, authenticated response, applicable grant choice, rejection, owner-away optional timeout. |
| E | Execution-time enforcement of admitted authority. Revalidate identity, paths, DLP and capabilities; do not independently choose mode or downgrade a pipeline decision. |
| R | Recently denied persistence and explicit user re-run through S1; no stored-decision replay. |
| O | Outside the agent tool decision tree; an adjacent user action or configuration boundary. |

The inventory includes helper classifiers and execution-time refusals because moving only the three entry files would leave contradictory enforcement. It distinguishes tool permission from transport identity, sandbox capability and manifest constraints: their hard safety checks remain enforced. IDs identify bounded code regions, not a count of individual `if` statements. “Duplicate” means overlapping policy ownership, not necessarily byte-identical code.

## Entry, normalization and admission

| ID | Site | Current decision and inputs | Pipeline disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| A01 | `src/tools/invocation-runner.ts:281` | Resolve category from tool descriptor, input and session. | S4 normalized kind input; no independent permission result. | A09, C14, H01. |
| A02 | `src/tools/invocation-runner.ts:410` | Missing tool denies; exact plugin-generation lease failure denies at 422; expected MCP owner mismatch denies at 465. Inputs: registry, pinned generation/server identity. | S1 admission findings; preserve exact owner checks. | Runtime generation revalidation, H04. |
| A03 | `src/tools/invocation-runner.ts:586` | Model-hidden tools refuse origins other than governed UI/app origins. Inputs: model visibility, invocation origin. | S1. | Registry exposure filtering and runtime UI dispatch. |
| A04 | `src/tools/invocation-runner.ts:634` | Root cwd or missing trust origin denies. Inputs: canonical cwd, host provenance. | S1. | B02, G01. |
| A05 | `src/tools/invocation-runner.ts:666` | Revoked controller or excluded remote meta/capability-expanding operation denies before any grant/card. | S1 immutable authority admission; eligible remote calls go S2. | C04, D03, G04, J02. |
| A06 | `src/tools/invocation-runner.ts:723` | In-process pre-hook blocks or rewrites arguments. Governed operations/controller requests currently suppress extension hooks. | S1, final rewrite before normalization/rules. Preserve admission restrictions on extension execution. | G01 late script pre-hook is a separate hook type, not a replacement. |
| A07 | `src/tools/invocation-runner.ts:761` | Governed operation resolution and host principal/generation/account checks deny malformed or mismatched identity. | S1; operation capability consumed at E. | D04, H04. |
| A08 | `src/tools/invocation-runner.ts:857` | Rationale resume refuses input changes after hooks. Inputs: sealed original/final input. | S1 sealed request integrity, E freshness. | D09, G04. |
| A09 | `src/tools/invocation-runner.ts:913`; `src/tools/pipeline/risk-classification.ts:10` | Flag-controlled host category derivation for plugin/MCP plus governed minimum risk. | S4 normalize host observations once. MCP read-only hint must survive normalization. | A01, H01, H02. |
| A10 | `src/tools/invocation-runner.ts:1016` | Route selection/acquisition fails closed; brokered file requests use guest namespace rather than host paths. Inputs: frozen shell plan, capability, tool identity. | S1 route validity; S4 actual confinement facts; E capability recheck. | B01, G04; does not permit host-path reinterpretation of guest requests. |
| A11 | `src/tools/invocation-runner.ts:1087` | Approval identity/schema derivation failure refuses malformed input. | S1. | Tool schema validation at handler boundary. |
| A12 | `src/tools/invocation-runner.ts:1147` | Explicit host request from remote controller denied before prerequisite directory ask. | S1 capability restriction; do not generalize host shell into S2. | A05, D02. |
| A13 | `src/tools/invocation-runner.ts:1169` | Exact stored deny refuses; corrupt store recorded for later mandatory ask; other lookup failure refuses. Inputs: finalized args, scope, source/trust, action identity. | S1 known deny; unreadable restrictions must fail closed without adding an extra forced-floor category. | C05, C12, D07. |

## Filesystem and shell boundary decisions

| ID | Site | Current decision and inputs | Pipeline disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| B01 | `src/tools/invocation-runner.ts:1826` | Shell path policy loops: outside directory asks, sensitive/dynamic/recursive/invalid cases deny; selected guest routes relax specified checks. Inputs: final command, resolved cwd, actual substrate, runtime roots. | S1 invalid request; S2 escape/exfil/protected/critical findings; S4 secret/unproven/destructive ordinary cases; S7 one outside card. Keep E confinement. | B02, B06, C02, C06. |
| B02 | `src/tools/shell-path-policy.ts:72`, `:87`; `src/tools/invocation-runner.ts:1836` | Cwd and parsed command operands classify path violations; native alternate-dialect analysis runs on its own grammar. | Produce normalized lexical/canonical effect findings for S1/S2/S4. Parser uncertainty alone is ordinary mode/human. | B01, C02/C06; grammar helpers are evidence, not another mode engine. |
| B03 | `src/tools/invocation-runner.ts:1936` | Structural command validation refuses final rewritten command. Inputs: correct dialect AST/prepared facts. | S1 structural admission; preserve execution parser proof. | C02 shell parsing, E command preparation. |
| B04 | `src/tools/invocation-runner.ts:2031`; `src/permissions/permission-manager.ts:612` | `checkPathScope` reports first sensitive hit, first outside target, unfenced outside read. Inputs: all canonical targets, effect, roots, read-fence setting. | S2/S4 evidence producer; stop hard-denying ordinary secret reads/writes. All targets must be considered before one result/card. | B05, B06, F03, G03. |
| B05 | `src/tools/invocation-runner.ts:2084` | Sensitive hit unconditionally hard-denies before normal policy. | Change: ordinary secret read → S4/S5; ordinary secret write → file rules; protected control paths → S2. Credential-store admission exceptions require explicit security rationale. | F03, G03, G05, I01. |
| B06 | `src/tools/invocation-runner.ts:2124` | Saved scoped edit allow widens effective call-only paths; separate allowed-directory loop starts at 2140. | S3 grant evidence; S4 project/checkpoint; S7 single combined outside card. | C03/C12, F01/F02. |
| B07 | `src/tools/invocation-runner.ts:1282` | Outside-directory helper validates grantability, suggests folder, runs reviewer/card, applies scope and can ask again later. | Replace permission choice with S4/S5/S7 single result including folder grant. Revalidate folder addition at E. | B06 and D10 second card. |
| B08 | `src/tools/invocation-runner.ts:1346` / append `:1361` | Headless/no-surface outside request denies and appends directory-grant deferred entry. | Remove append site 1; S5 deny + no retry, R redacted record. | D08, Q01–Q04. |
| B09 | `src/tools/invocation-runner.ts:2058` | Plugin tools and plugin skill loads deny when outside turn's plugin allowlist. | S1. | Tool discovery filtering, skill-load runtime. |
| B10 | `src/tools/pipeline/scoped-rule-subject.ts:9` | Build edit/webfetch/MCP subject from tool identity and all target paths. | Normalized S1/S3/S4 request input. | A11 approval identity; F01 target resolution. |

## Permission manager policy ownership

| ID | Site | Current decision and inputs | Pipeline disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| C01 | `src/permissions/permission-manager.ts:1218`, `:1234` | `checkDetailed` converts some headless shell asks to deny; `evaluatePermission` rejects forged/incomplete meta overrides. | Headless conversion S5; meta admission S1. Entry calls the one pipeline. | D02/D08; C14 strict/headless matrix. |
| C02 | `src/permissions/permission-manager.ts:1262` | Command length/parser budgets, recursion, dialect, cwd identity, analysis signals and literal-rule eligibility. | S1 malformed dialect/unsafe execution constraints; S4 unproven analysis; S2 only enumerated floors. | B01–B03, F04. |
| C03 | `src/permissions/permission-manager.ts:1320`, `:1397` | Project/global/session rule composition; deny beats ask beats allow. Checks source/subject integrity. | S1 deny and subject integrity; S3 ask/allow evidence. | A13, B06, F01/F04. |
| C04 | `src/permissions/permission-manager.ts:1413` | Remote meta/excluded tools deny; all other controller calls force local once. | S1 excluded authority, S2 other-principal floor. | A05, D03. |
| C05 | `src/permissions/permission-manager.ts:1440` | Corrupt user/project/exact rule store forces human for mutations. | Fail-closed restriction uncertainty handled by S1/S5 without extending S2's exhaustive list. | A13, D01. |
| C06 | `src/permissions/permission-manager.ts:1449` | Exfil, sensitive, destructive, budget and unproven signals choose forced ask or auto review. | Split: S2 exfil/protected/critical/escape; S4 ordinary secret/unproven/destructive; S5/S6 normal review. | B01/B05, F01/F03/F04. |
| C07 | `src/permissions/permission-manager.ts:1483` | Scoped floor and ask rules return force-modal; all generic ask rules forced. | S2 only enumerated floor; S3 ask wins allow, routes through S5. | F01/F04 and D02. |
| C08 | `src/permissions/permission-manager.ts:1506` | Staged-origin mutation asks before permits. | S2 other-principal evidence using existing provenance semantics. | D03, J01/J02. |
| C09 | `src/permissions/permission-manager.ts:1515` | Strict asks even reads; special headless mutation reviewer lane. | Change S4/S5: reads allowed, otherwise strict asks; no headless reviewer escape. | C14, I02 read-only auto-pass. |
| C10 | `src/permissions/permission-manager.ts:1532` | Sandbox recursive traversal forces ask; eligible reviewed shell floor returns reviewer route; sandboxed shell otherwise allows. | S1 execution constraints; S2 definite escape only; S4 uncertainty/sandbox-auto, strict override S5. | B01/C06 and G06. |
| C11 | `src/permissions/permission-manager.ts:1549` | Named local memory writes auto-allow; headless mutations route through category/reviewer early at 1562. | S4 file/checkpoint or normalized domain capability; S5 human availability. Preserve prerequisite memory behavior when rebasing. | D07, C14; cannot leave named auto-pass outside pipeline. |
| C12 | `src/permissions/permission-manager.ts:1568` | Scoped/global allows, tier checks, durable cache; host shell excluded unless exact command rule; plain shell fallback asks/denies at 1609. | S3 unified grants, prefix rule support; S4/S5 host shell ordinary; S2 remains earlier. | A13, B06, D02/D07. |
| C13 | `src/permissions/permission-manager.ts:1621` | Meta ask override can re-elevate allow unless stored dock grant/global allow; issue host-shell exact-rule evidence. | S1 meta validity, S3 per-tool grants, S4/S5 ordinary kind; E bind issued execution proof. | D01/D04 and host-shell permit validation. |
| C14 | `src/permissions/permission-manager.ts:2130`, `:2154`; `src/permissions/category-registry.ts:53` | Foreground reviewer eligibility and category × source × mode × headless defaults; low-trust MCP always asks, strict all asks. | Replace permission matrix with S4/S5 in pipeline. Registry retains descriptive metadata only. | A01/A09, C09, D06, H01. |
| C15 | `src/permissions/permission-manager.ts:590` | `routeJudge` opens active configured judge route for asks, excludes low trust/floors. | S5 auto → S6. A configured chain must not silently make default reviewer mode. | C14, D06, I03. |
| C16 | `src/permissions/permission-manager.ts:1704` | Reviewer assessment: availability, exact-memory shortcut, verdict cache, substrate/intent composition, stale-state/error handling and redaction. | S3 user grants; S6 verdict evidence/cache; E freshness. No floor/mode decisions in cache. | D07, F05, I03. |
| C17 | `src/permissions/permission-manager.ts:1971`; append `:2111` | Judge dispatch maps chain/baseline outcome and appends deferred on selected headless result. | S6 one verdict mapping; remove append site 2 → R. | D06/D08, Q01–Q04. |

## Authorization orchestration and card overrides

| ID | Site | Current decision and inputs | Pipeline disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| D01 | `src/tools/invocation-authorization.ts:416`, `:478` | Meta fast path, construct shell/scoped subjects; call manager or force ask when absent. | Normalized request → one pipeline. S1 meta contract; S5 unavailable policy. | C01/C13; B10. |
| D02 | `src/tools/invocation-authorization.ts:511` | Explicit/plain host exact-rule proof; missing exact rule forces once or headless deny; no reviewer. | Change S3 prefix grants; S4 host-shell ordinary S5/S6; preserve E binding. | C12, A12, I01 exact card construction. |
| D03 | `src/tools/invocation-authorization.ts:563`, `:596` | Remote read cannot auto-pass; remote local once; user-opened browser action requires per-action human. | S2 other-principal/protected authority evidence; S1 surface capability validity. User-owned browser consent must not disappear in consolidation. | A05/C04, I02, J02. |
| D04 | `src/tools/invocation-authorization.ts:613` | Pre-issued governed app mutation grant replaces ordinary ask after permission hook, never hard deny/floor. | S3 verified grant input, S1 block hook, E consume one-shot operation grant. | A07, H04. |
| D05 | `src/tools/invocation-authorization.ts:707`, `:828`, `:905` | Plugin read relaxation, effect-gated plugin writes, app-panel private-store relaxation turn asks into allows under bounded manifest/confinement conditions; permission hooks can block. | S1 manifest/capability validity; S4 kind/confinement evidence; S3 authenticated grant. No private branch in caller may override pipeline. Keep H03 effect enforcement. | A09, C14, H03; read relaxation remains conditional on active filesystem confinement. |
| D06 | `src/tools/invocation-authorization.ts:989`, `:1025` | Foreground reviewer route, memory before review, reviewer outcome replacement. | S3 then S5/S6; one result mapper. | C15/C16, I03, D07. |
| D07 | `src/tools/invocation-authorization.ts:1450`; `src/tools/pipeline/approval-memory-skip.ts:70`; `src/tools/executor-implementation.ts:344` | Second memory-skip lane, root/cwd identity and rule-risk constraints, paused breaker suppression. | S3 grant evidence; S2 cannot be bypassed. Keep cache/authority identities. | C12/C16, D06, A13. |
| D08 | `src/tools/invocation-authorization.ts:1242` | Headless ask either denies or dispatches reviewer and possibly defers. | S5 no approver → deny with no-retry; remove deferred handling; R. | C01/C11, B08, I03. |
| D09 | `src/tools/invocation-authorization.ts:1112`, `:1153`, `:1475` | Rationale batch/resume can suspend for human text authorization; verifies sealed plan/policy epochs; hooks block. | S7 alternate authenticated card surface after same pipeline; S1/E sealed-action freshness. | A08; pipeline rationale modules; no resumed grant may skip S1. |
| D10 | `src/tools/invocation-authorization.ts:1406`, `:1550`, `:1666`, `:1808` | Cross-agent reason may invoke reviewer then force ask; derive choices/read-only, run permission-request hooks, call gate. | S2 other-principal floor, S1 block hook, S7 card. Remove reviewer path for forced floor. | C08, J02, B07 first card, I01–I04. |
| D11 | `src/tools/invocation-authorization.ts:1909`, `:1938`, `:2091`; `src/tools/pipeline/approval-outcome.ts:11` | Response grants/denies persisted, breaker resumed, execution permit issued/revalidated; host timeout/rejection converts to denial. | S7 rejection/grant persistence, E live permit; breaker remainder-of-turn must not reopen on one approval. | C12, I01/I04, G04/G06. |

## Shared classifiers and enforcement

| ID | Site | Current decision and inputs | Pipeline disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| F01 | `src/permissions/rules/scoped-rule-matcher.ts:76` | Resolve lexical/canonical edit targets and floor; WebFetch target floor; MCP non-destructive eligibility; deny/ask any target, allow all targets. | Evidence-only matcher for S1 deny, S2 precise floor, S3 ask/allow. General MCP memory no longer depends on non-destructive hints. | C03/C07, B06/B10. |
| F02 | `src/permissions/rules/scoped-rule-matcher.ts:142`; `src/permissions/allowed-directories.ts:34`, `:96`, `:164`, `:227` | Depth candidates, sanitized roots, effect-aware containment, nearest parent, grant validity and adjacency. | S4 boundary facts/S7 folder choice, E grant validation. Preserve prerequisite removal of depth behavior; no inherited restriction surprises. | B04/B07, F01, G03. |
| F03 | `src/permissions/sensitive-paths.ts:116`, `:325`, `:385`, `:484`, `:594`, `:638` | Sensitive store table/globs; lexical/canonical separator and case folding; protected control subset; saved-session read exception. | Split S1 protected credential-store capability, S2 exact protected paths, S4 secret read/write. Shared evidence for callers/sandbox; no blanket secret deny remains. | B05/C06/G03/G05/I01. |
| F04 | `src/permissions/rules/shell-rule-matcher.ts:60`; `src/permissions/rules/rule-scopes.ts:155`; `src/permissions/rules/shell-prefix-policy.ts:320`; `src/permissions/rules/powershell-exfiltration.ts:686` | Grammar, restriction/prefix/exact matching, sensitive/exfil floors and analysis budgets. Inputs: host parsed command/cwd, all subcommands, three rule scopes. | S1 deny, S2 exact floors, S3 rules, S4 uncertainty; preserve dialect separation. | B02/C02/C06/C12. |
| F05 | `src/permissions/reviewer/risk-classifier.ts:117`, `:126`, `:314`, `:1579`, `:1783`, `:1938` | Disabled/strict/rule/LLM risk grading; network/intent/sandbox risk composition, retries/error verdict, classifier construction. | S6 evidence; S2 exfil signals must precede reviewer. Low/medium threshold is fixed by approved behavior, not a second mode matrix. | C16, I03, H05. |
| F06 | `src/permissions/user-approval-store.ts:269`, `:337`, `:388`, `:551`; `src/tools/approval-memory-context.ts:9` | Store exact/target/trust/source/cwd scope and lookup eligibility; legacy migration and corrupt-store behavior. | S1 stored deny, S3 authenticated grant, S7 persist only permitted choices; forced floor never read/write reusable grant. | A13/C12/C16/D07. |

## Execution and secondary boundary checks

| ID | Site | Current decision and inputs | Pipeline disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| G01 | `src/tools/invocation-execution.ts:259` | Script PreToolUse dispatch after permission; block result refuses handler. | Move to S1 before any card, block-only. It cannot allow/ask/rewrite the finalized invocation. | A06 argument hook is distinct. |
| G02 | `src/tools/invocation-execution.ts:298`, `:314`, `:842` | Rate budget and writable permission audit chain refuse execution, including after awaits. | S1 admission health, E live recheck. No reviewer/user permission bypass. | A02 admission and audit writer. |
| G03 | `src/tools/file-access-policy.ts:11`, `:16`; `src/sandbox/path-validator.ts:24` | Native file execute-time sensitive deny, special session read, directory/link confinement. | E validate pipeline-authorized effect and identity; ordinary secret approval must not be hard-denied here. S2 escape detection before approval. | B04/B05, F02/F03; all native file consumers. |
| G04 | `src/tools/invocation-execution.ts:842`, `:933`; `src/permissions/host-shell-execution-permit.ts:136` | Abort, audit, live controller, current route capability, exact shell permit and operation account bindings checked at mutation. | E retain checks; permission questions only through pipeline re-entry. | A05/A07/A08, D11. |
| G05 | `src/tools/guarded-file-transfer.ts:85`, `:211`, `:249`; `src/tools/archive-entry-reader.ts:124` | Both endpoints and reached archive/tree entries checked; member traversal, overlapping roots, links, invalid destinations refuse. | S1 invalid/archive structure, S2 escape, S4 all touched boundaries; E descriptor/link race checks remain. | B04, G03; no first-target-only allow. |
| G06 | `src/tools/invocation-execution.ts:858`, `:879`, `:923` | Late breaker turns prior allows into forced once or deny; human allow resumes automation. | S6 ordinary card, keep remainder of turn human-only; S7 response. Abort remains terminal. | C17, I03/I04. |
| G07 | `src/tools/invocation-execution.ts:730` | Canonical fetch rechecks network rules per reached URL; denies redirects to unapproved destination. | E destination validity/rule recheck; new approval need re-enters S1/S4 network request. | F01, H05/H06. |
| G08 | `src/tools/invocation-execution.ts:1048`, `:1471` | Runtime authorization-required result becomes terminal no-surface error and audit. | S4 sandbox escalation → S5, headless deny + no retry; R record; E handler cannot replay prior allow. | D08, G04. |

## MCP, plugin and egress decisions

| ID | Site | Current decision and inputs | Pipeline disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| H01 | `src/mcp/mcp-tool-adapter.ts:26` | Force network kind for all foreign tools; readOnlyHint/destructiveHint only contribute non-destructive scoped-rule identity. | S4 preserve explicit readOnlyHint → allow; remaining tools mode/human then per-tool memory. | A09/C14/F01. |
| H02 | `src/permissions/reviewer/host-risk-inspector.ts:211`, `:229`; `src/mcp/mcp-manager.ts:953` | Host reads require positive command evidence; discovery publishes mode overrides. | S4 normalized observations and MCP annotation, S1 schema validity; no additional default permission authority. | A09/H01. |
| H03 | `src/permissions/effect-enforcement.ts:124`, `:238` | Flagged plugin mutations: deny headless/no surface, once/durable descriptor grant or separate gate card; read effects pass. | Nested effect request enters same S1/S3/S4/S5/S7 pipeline, enforce at E. Preserve flag and bounded descriptors, no broad tool grant. | D05 and H04/H05. |
| H04 | `src/plugins/isolation/host-api-dispatcher.ts:1184`, `:1391`; `src/boot/steps/plugin-runtime/host-api-factory.ts:488` | Manifest/capability/domain/account effect guards; observed method classifies mutation. Governed operation grant binds account/generation. | S1 capability admission; E live effect binding; S4 host-observed kind. No plugin-specific permission branch. | A07/D04/H03. |
| H05 | `src/main/host-fetch-guard.ts:75`, `:218`, `:347`; `src/boot/steps/plugin-runtime/host-api-factory.ts:890`, `:905` | HostFetch URL/scheme/domain/private-network/SSRF checks, redirect revalidation, method effect and mutating gate. | S1 manifest/SSRF denies, S4 network; E each reached destination + credential lease; H03 pipeline for new consent. | F05/G07/H06; domain grant is not SSRF override. |
| H06 | `src/permissions/egress-ask.ts:161`, `:296` | Verify token/owner/destination/network class; workers use allowlist; shell evaluates rules/grants and prompts or headless denies; coalesces duplicate asks. | S1 identity/manifest/reserved denies; S3 rules/grants; S4 network; S5/S7 one card; E resolved IP recheck. User-typed terminal owner remains outside agent tree. | C03/F01/H05, H07. |
| H07 | `src/permissions/egress-approval.ts:31`; `src/permissions/egress-grants.ts:285`; `src/permissions/egress-invocations.ts:82` | Egress approval adapter issues scoped host/network card; grants keyed by principal, destination/class and lifetime; invocation registry proves owner. | S7 adapter, S3 scoped grants, S1 identity, E route lifetime. Keep network class segregation. | H06/I01. |

## Approval gate, reviewer outcomes and background work

| ID | Site | Current decision and inputs | Pipeline disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| I01 | `src/permissions/approval-gate.ts:1483`, `:1554`, `:1676`, `:1725` | Validate rationale/plan/binding, derive high-risk once-only and exact-shell choices; sensitive target can independently refuse. | S1 integrity; S7 choices selected from pipeline reason/kind, ordinary high/error retains normal card; remove blanket secret re-deny. E permit checks stay. | B05/D02/F03/G03/I03. |
| I02 | `src/permissions/approval-gate.ts:1750` | `isReadOnly` auto-approves before explicit/forced request flags; missing live surface denies at 1772. | Move kind decision to S4 and honor S2 first; S5 human availability. Gate must never reinterpret an ask as read-auto-allow. | D03/D10, C09. |
| I03 | `src/tools/pipeline/reviewer-dispatch.ts:34`, `:64`, `:218`, `:329` | Judge fallback/error → forced ask; headless failure/defer policy; interactive threshold maps verdict to allow/ask; cancellation denies. Append at 91. | S6 single mapping low/medium allow, high/error/abort normal ask if turn remains live; S5 headless deny. Remove append site 3 → R. | C15–C17/D06/D08/I04. |
| I04 | `src/permissions/judge/judge-breaker.ts:5`, `:46`, `:92`; `src/permissions/judge/judge-engine.ts:385`, `:465`; `src/permissions/judge/manual-approval.ts:6` | Existing 3/20 counter counts classifier ask/deny per root session, dedups invocation, pauses, manual allow resumes, session close forgets. | Change S6 lifetime to turn and preserve human-only remainder; no fresh breaker subsystem. | G06/D11; diagram's “absent” description is stale. |
| I05 | `src/permissions/approval-gate.ts:1819`; `src/permissions/away-authority.ts:203` | Bounded away authority may answer before UI using local grant and request constraints. | S3 scoped authority must never bypass S2; S5 owner-away app-open uses card; S7 default unlimited optional skip. Review existing delegated auto-answer against new wait requirement explicitly. | J01 headless conflation, I06 timeout. |
| I06 | `src/permissions/approval-gate.ts:1991`, `:2192`, `:2235`; `src/tools/pipeline/approval-outcome.ts:11` | Fixed approval wait timer denies; desktop-owner and nonce/HMAC/choice integrity checks accept/reject response. | S7 retain authenticated ownership; owner-away timer off by default, configured N-minute skip denies + no retry. | D11; no disabling integrity to implement unlimited wait. |
| I07 | `src/permissions/reviewer/deferred-queue.ts:45`, `:78`, `:128`; `src/boot/steps/reviewer-wiring.ts:159` | JSONL load, append, pending resolution, boot/reviewer coupling; queue presence controls reviewer readiness. | Delete queue API/readiness dependency. R capped redacted denial history, safely ignore/migrate legacy data, never import approvals. | B08/C17/I03/J04; four append owners. |
| I08 | `src/ipc/domains/permissions.ts:876`, `:905`, `:1063` | Deferred list/resolve and automatic question; resolution can grant folder/exact authority for future call. | Replace with R list + explicit re-run, no grant minting from history; S1 fresh request and S7 user approval. | I07 and Q01–Q04. |

## Provenance, child escalation and adjacent actions

| ID | Site | Current decision and inputs | Pipeline disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| J01 | `src/engine/turn/query-loop.ts:1569`; `src/engine/turn/trust-origin.ts:18`, `:41` | Owner-unattended bounds set headless=true; input origin/resource fences and tool results derive trust/taint. | Change S5 owner-away distinct from no-human; normalized S2 principal/taint comes from host provenance. | C08/D03/I05. Literal `externalContentSeen` symbol is absent in this baseline. |
| J02 | `src/engine/turn/query-loop.ts:2540`; `src/tools/invocation-authorization.ts:1406` | Intercepted search/plugin-request meta calls get cross-agent/remote gate outside ordinary executor; reason prefix can review/force. | S1 remote excluded meta deny, S2 other-principal one-shot; intercepted privileged actions must use same decision authority. | A05/C04/C08/D10. |
| J03 | `src/engine/subagent-runner.ts:898`; `src/permissions/approval-gate.ts:1123`, `:1330`, `:1868`; `src/permissions/parent-adjudicator.ts:155` | Child wrapper injects host provenance; eligible parent model adjudication can allow/deny or escalate before dock. | S2 child escalation skips reviewer/model substitute; S7 user's own approval; keep ancestry, session ownership and turn liveness checks at S1/E. | D10/I01 and J04. |
| J04 | `src/permissions/approval-gate.ts:1198`, append `:1245` | Unattended child escalation records deferred request then settles. | Remove append site 4. S5 app-open owner-away waits; truly headless deny + no retry; R history. | I07/I08 and J01. |
| J05 | `src/hooks/hook-command-policy.ts:28` | Hook command itself uses host-shell exact-only permission and separate card/receipt/recheck. | Hook process authority is S1/E; preserve block-only hook result. If hook shell needs consent it must use pipeline, never grant the target tool. Guard recursion when moving pre-hook earlier. | C12/D02/G01. |
| J06 | `src/tools/skill-load.ts:134` | Skill instructions can ask for scoped approval inside tool execution; denial stops loading. | Nested tool capability request must be normalized and re-enter S1/S7; retain skill trust checks. | B09/J02; cannot let loading a skill become general tool permission. |
| J07 | `src/permissions/agent-action-approver.ts:33`; `src/core/work-board-engine.ts:472` | Host mutation one-shot adapter and work-board gate directly ask. | Agent-triggered host capability uses same pipeline S1/S4/S7; user-origin host workflow remains O. No stored broad mutation grant. | I01 and H03. |
| J08 | `src/permissions/permission-mode-apply.ts:77`; `src/ipc/handlers/permissions.ts:52`; `src/main/exec-mode.ts:411` | Mode mutation requires user provenance/card; headless launch mode selected by operator. | O user-owned mode configuration, not model tool authority. Preserve four modes. | Settings/composer and headless entrypoints; no read-only mode. |
| J09 | `src/main/terminal/pty-manager.ts:699`, `:849`; `src/tools/invocation-authorization.ts:442` | Current agent terminal_run carries shell rule subject; physical terminal keystrokes and host turn authority are distinct. | O user-typed terminal commands per prerequisite terminal change; agent terminal_run remains governed according to its authority. Never route physical typing through pipeline. | H06 terminal egress is a distinct owner; merge prerequisite changes before recertifying. |

## Deferred removal and UI/contract sweep

| ID | Site | Current inputs and effect | Disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| Q01 | `src/shared/ipc-channels.ts:101`; `src/preload/internal-api-surface.ts:802`; `src/ui/renderer/types.ts:1465`, `:1546` | Deferred list/resolve/pending channel, preload and renderer contracts. | R replace all endpoints together: sender guard, schema, bridge, types, callers, fixtures, lock tests. | I07/I08. |
| Q02 | `src/ui/renderer/dialogs/DeferredQueueDialog.tsx:16`; `src/ui/renderer/components/permissions/DeferredQueuePanel.tsx:35`; `src/ui/renderer/App.tsx:192`, `:2308` | Queue dialog/panel, opening state, badges and resolution controls. | R Recently denied list with manual re-run card; delete old queue surfaces. | Q01/Q03; no stale “approve stored entry” action. |
| Q03 | `src/i18n/messages/generated/deferredQueueDialog.ts:1`; `src/i18n/messages/generated/deferredQueuePanel.ts:1`; `src/ui/renderer/format-ipc-error.ts:63` | Queue copy, key namespaces/barrels, IPC error mapping. | R remove/update source catalogs using generators; never hand-edit generated fragments. Update ko/en and recorded readers. | Q02/Q04 and UI catalog tests. |
| Q04 | `src/ui/renderer/tabs/PermissionsTab.tsx:290`, `:418`; `src/shared/permission-mode.ts:9`; `src/data/settings-defaults.ts:1`; `src/ui/renderer/onboarding/default-tour-scenarios.ts:1` | Mode/reviewer coupling, pending history, settings defaults and initial guidance. | S5/S7 four modes, owner-away N-minute setting default off; R history. Match card and onboarding ko/en copy to same pipeline. | C14/I05/I06/J08. |

## Additional native and process enforcement

| ID | Site | Current decision and inputs | Pipeline disposition | Duplicate or overlap |
| --- | --- | --- | --- | --- |
| K01 | `src/tools/file-read-core.ts:32`; `src/tools/file-tools.ts:316`, `:1844`, `:1886`; `src/tools/grep-search.ts:222`, `:330` | File read core hard-denies sensitive targets; native list/grep traversal silently omits sensitive roots/entries. | S4 secret read classification; E may enforce only approved per-target access and retained credential boundaries. Do not let a read approval silently return empty results. | B05/F03/G03. |
| K02 | `src/main/browser/browser-upload.ts:245`; `src/memory/project-agents-md.ts:66` | Upload rejects sensitive/link-changed files; instruction import silently refuses sensitive/outside files. | Upload exfil/identity evidence S1/S2 and E; automatic instruction discovery remains E with no new automatic secret exposure. User-selected upload or instruction discovery does not create a tool allow. | H05 and G03; automatic discovery is outside tool mode selection. |
| K03 | `src/plugins/isolation/out-of-process-plugin.ts:115`, `:178`, `:249` | Plugin sandbox grant resolution refuses sensitive paths, invalid roots, mutable/excluded storage; held grant revalidation pins identity. | S1/E process capability envelope; shared sensitive evidence must distinguish ordinary secret decisions from non-grantable host credential/control state. No broader plugin read relaxation without active confinement. | F02/F03/H03/H04. |
| K04 | `src/tools/shell-executable-read-paths.ts:33` | Executable read-path expansion omits sensitive lexical/resolved paths. | E sandbox evidence, no permission result; do not use this exclusion as another blanket secret read policy after approval. | B02/F03, shell sandbox materialization. |

## Implementation reconciliation

This is the pre-refactor source inventory. Its anchors and current-decision columns describe the recorded baseline, not the current branch. The original 97-ID destination columns record intended mappings. The Current-source reconciliation table below records the live implementation anchors, retained guards and explicit verification limits. A mapped destination is not proof that consolidation or removal is behaviorally validated. The [immutable owner decision tree](../architecture/permission-decision-tree.md) supersedes historical dispositions below, including headless immediate-deny, session-lifetime breaker, parent adjudication and exact-only host-shell statements.

Default is the displayed name of stored `strict`; Allow writes is stored `default`. New installations select strict; existing stored default remains unchanged. Headless auto reviews before human fallback, owner-away waits indefinitely by default, and manual rerun starts admission again with fresh human approval.

## Source disagreements and integration constraints

1. The HTML hooks card leaves script-hook placement and allow/ask support undecided. The brief resolves both: script PreToolUse moves before permission, block-only. In-process argument rewrites remain permitted and final. No hook may skip the card.
2. Section 4's rationale table labels its target column “v2” despite the section being the approved later design. Interpret its behavior under section 4 and the brief, not as another policy version.
3. The HTML opening sentence says mode is chosen at the top, but its actual tree puts the mode decision after admission/floors/rules/kind. The explicit ordered stages in the brief win. Strict's extra write/shell handling is in HTML prose rather than its arrows; retain that exception.
4. The diagram omits the sandbox-block/escalation edge; its prose and the brief explicitly route it to mode/human. Include it in the real pipeline.
5. HTML section 3 is anchored to `3e51a9e89`, not the requested base. In particular, the brief/HTML says no breaker exists, but `judge-breaker.ts` already has 3/20. Its session lifetime and manual-resume behavior differ from the requested turn lifetime. Reuse and correct it; test both thresholds and turn isolation.
6. The literal `externalContentSeen` identifier is absent at this base. Existing host provenance uses trust origin, resource fences, tool-result updates, staged origin and cross-agent approval reason. Preserve its actual taint semantics while normalizing S2; do not silently invent a broader “all tool results force ask” rule.
7. “Secret read asks” is the kind's mode/human route, not an absolute override of an explicit allow mode or applicable rule; S1 credential-store protection and S2 protected-control floors still win. The brief's explicit stage order resolves that shorthand. Strict allows ordinary reads; secret reads remain mode/human.
8. The prerequisite project-write change (#312) is not in this snapshot. Its in-project checkpoint allow, single outside card, template exception, patch memory and depth removal must be preserved after the lead authorizes Phase 1. Do not reconstruct them independently in this phase.
9. The user-typed terminal prerequisite (#308) may change terminal authority seams. Physical user commands stay outside this tree. This inventory records the current terminal_run subject only; it does not authorize converting physical typing into agent requests.
10. Existing delegated away answers and parent adjudication predate the requested owner-away wait/other-principal one-shot behavior. Their authentication and liveness checks remain; automatic answers must not bypass the new S2/S5 result.

### Credential-store separation

`SENSITIVE_PATH_ENTRIES` currently mixes ordinary secret files, control/config paths, browser cookie stores, host private runtime state and credential databases. Retain admission denial for host encryption keys and encrypted credential stores (`sensitive-paths.ts:68`, `:253`), credential-bearing runtime capability state (`:254`), and host session/cookie/token databases where raw filesystem access bypasses the app's credential-use protocol. These are host capability boundaries, not generic “secret-file read” restrictions. Ordinary `.env`/key files follow S4; prerequisite template exclusions stay intact. Config/control mutation belongs to S2. Phase 1 must enumerate the retained store entries and rationale explicitly; the current broad table cannot be kept wholesale merely by renaming it “credential stores.”

## Validation contract for the implementation

This inventory changes documentation only. No runtime behavior has changed. Behavioral evidence belongs to Phase 1, after the prerequisite merge and lead instruction.

- Independently authored data matrix: kind × boundary × four modes × human availability × exact floor × rule. Every changed outcome must name an approved behavior change; source/taint and multi-target reductions need focused companion rows.
- Bypass fixtures: symlink/junction, parent traversal, protected-name case and separator variants, multi-target patch, both transfer endpoints, archive entry escape. Verify secret approval remains executable through G03 and sandbox policy, without weakening protected stores.
- Hook ordering: blocked script call creates zero approval cards; script cannot allow/rewrite target; argument rewrite is the exact input later authorized.
- Reviewer: low/medium allow, high/error/live abort ordinary ask, both breaker thresholds, reset on new turn, no manual mid-turn automation reopening, no cache/grant bypass of floor.
- Headless: auto reviewer first, then deny a required human fallback with “Nobody can approve this request; do not retry.”; capped DLP-redacted history, legacy queue safe load/ignore, explicit re-run starts S1 and requires a fresh manual card.
- Owner-away: visible app card waits without timeout by default; configured elapsed N minutes denies once and sends no-retry guidance. Truly headless remains distinct.
- Contracts: preload-shape, channel-inventory, terminal-channels-internal, packaging-discipline plus changed settings/catalog/persistence consumers. Use targeted suites, typecheck and lint; no full suite.
- UI: isolated profile/port launch, settings and recent-denial screenshots without account/email prompt material; terminate only the owned process.
- Complexity: compare actual decision branches over the decision-owner regions above before/after, separately from the diagram's eight decision nodes. For reproducibility, extract the complete functions containing A02–A13, B01–B09, C01–C17, D01–D11, G01–G02, G04, G06–G08, H03, H05–H06, I01–I06 and J02–J07, deduplicate function spans, and report their absolute start/end lines in the measurement output. Count `if`, conditional expressions and switch cases with the same syntax traversal on both versions; exclude evidence parsers, transport guards, UI rendering and tests. Report region list and method, not just a smaller function's count.
- Changed-line policy: no explanatory external product names, no skip/only/todo/placeholder additions, LF blobs, no unrelated edits. No Phase 1 implementation is claimed by this inventory.

## Inventory verification

- Source inspection used declaration/caller searches plus direct reads of the three entry files, manager stages, shared matchers, hook paths, effects, egress, queue append owners and native file enforcement. A second sensitive-path consumer search found K01–K04 beyond the initial entry-file inventory.
- A cold read independently reconciled the first 93 IDs and four append owners. Its anchor/measurement-scope findings were corrected; the follow-up native/process sweep adds four IDs.
- The delivery/repository copies are byte-identical LF text. A local reference check verifies 97 unique IDs and that all explicit source-file anchors exist within their files. This verifies inventory structure, not runtime behavior.
- `bun run typecheck` failed with TS2688 because the checkout lacks the Node type definitions/dependencies. `bun run lint` cannot run because no lint script exists in this snapshot. No gate was bypassed or failure masked; no behavioral test counts are claimed for documentation-only work.
- The documentation is a snapshot companion to existing policy, not a second normative policy. Consistency audit records source disagreements above; policy consolidation is deferred to the authorized implementation phase. No external host behavior was asserted or independently researched here. Portability and metric-leakage checks do not apply to this source inventory.

## Coverage reconciliation

Every inventoried site is accounted for below. Multiple stages indicate an existing mixed responsibility that must be split; they are not permission to preserve caller-side decision branches. E and O are deliberate retained boundaries rather than unmapped exceptions. R changes represent queue removal/history replacement, never approval replay.

| Group | All IDs | Accounted destination | Change or preservation |
| --- | --- | --- | --- |
| Entry/admission (13) | A01–A13 | S1/S2/S3/S4, E | Centralize kind/deny decisions; preserve tool/principal/plan integrity. |
| Paths/shell (10) | B01–B10 | S1/S2/S3/S4/S5/S7, E, R | Remove blanket secret denial and duplicate outside card; preserve normalized all-target enforcement. |
| Manager (17) | C01–C17 | S1–S6, E, R | Remove independent mode matrices/host-shell exceptions; one ordered decision owner. |
| Authorization (11) | D01–D11 | S1–S7, E, R | Delete post-result policy rewrites; retain response persistence and live permits. |
| Shared evidence (6) | F01–F06 | S1/S2/S3/S4/S6/S7, E | Reuse parser/path/grant evidence; split broad sensitive table. |
| Execution (8) | G01–G08 | S1/S2/S4/S5/S6/S7, E, R | Move pre-hook; re-entry on new consent; no secret hard-deny after approval. |
| External effects (7) | H01–H07 | S1/S3/S4/S5/S7, E | MCP annotation/per-tool memory; pipeline-backed nested effects, preserve manifest/SSRF/identity checks. |
| Cards/background (8) | I01–I08 | S1–S7, E, R | Gate stops classifying; ordinary reviewer fallback, turn breaker, history replaces queue. |
| Provenance/adjacent (9) | J01–J09 | S1/S2/S3/S4/S5/S7, E, R, O | Owner-away distinct; forced other-principal; physical typing/configuration deliberately O. |
| UI/contracts (4) | Q01–Q04 | S5/S7, R | Coordinated channel/UI/catalog/settings removal and replacement. |
| Native/process enforcement (4) | K01–K04 | S1/S2/S4, E | Reconcile silent traversal exclusions and executable/plugin sandbox paths with admitted authority. |
| Total | 97 bounded sites; 4 deferred append owners: B08, C17, I03, J04 | All mapped or deliberately changed; no pending unmapped ID | Inventory is the refactor checklist; Phase 1 must reconcile it against the newly merged base before edits. |

## Current-source reconciliation

This table reconciles all 97 baseline IDs against the live implementation tree on 2026-10-30. Current anchors below replace the baseline anchors for source inspection; concurrent integration may move them. A source destination and a test reference are not a passing-test claim. Worker reports were cross-checked against actual declaration/call sites; final integrated results, native sandbox execution and rendered flows remain separate gates.

The approved committed [decision tree](../architecture/permission-decision-tree.md) remains the contract. A changed external source proposing per-session surface selectors is not adopted here while owner confirmation is pending. No old queue source/API is retained as a fallback; history contains no executable argument or stored approval replay.

Reconciliation results:

- C06/F04/F05: typed risk-floor tests distinguish recognized direct upload exfiltration (forced, reviewer-free) from opaque command payloads with no typed exfil signal (ordinary unproven mode policy). The corrected risk suite passes 449/449.
- J05: hook commands consume central reviewer evidence and authenticated exact host receipts; effect/policy/cwd races reject before spawn. The hook effect-race suite passes 27/27.
- J07: preserved O capability/transport and workflow consent is separate from tool execution; explicit callers are recorded in its row.
- K03/K04: native secret-deny projection is preserved and worker grants are never widened. Trusted native filesystem-denial attribution currently works only with the macOS monitor. Installed Linux diagnostic-attempt records are deliberately rejected; no trusted Linux supervisor exists for this bridge, so Linux retains the original failure. The 7/7 executor cases use controlled issued evidence, including a simulated Linux environment, and prove policy orchestration rather than native Linux attribution. Owner decision remains pending: accept this limitation or require a trusted Linux supervisor before delivery.

The [validation record](permission-pipeline-validation.md) separates targeted results, built-app evidence and pending delivery gates.

All 97 sites now map to the central decision owner or an explicit retained E/O boundary. This is a source reconciliation plus the cited targeted evidence, not a claim that all native backends, rendered flows or every referenced suite were rerun. External source drift and the Linux native-attribution delivery decision remain pending owner confirmation.

| ID | Current source anchor | Disposition and preserved boundary | Focused test reference |
| --- | --- | --- | --- |
| A01 | `src/tools/invocation-runner.ts:559` | S4 effective category remains normalized caller evidence. | [Native][inventory-native] |
| A02 | `src/tools/invocation-runner.ts:517` | S1 registry/generation/server identity admission retained. | [Executor][inventory-executor] |
| A03 | `src/tools/invocation-runner.ts:636` | S1 hidden-tool origin allowlist retained. | [Executor][inventory-executor] |
| A04 | `src/tools/invocation-runner.ts:675` | S1 root cwd and missing host trust reject. | [Executor][inventory-executor] |
| A05 | `src/tools/invocation-runner.ts:703` | S1 revoked/excluded controller capabilities reject; eligible controller requests become a floor. | [Auth][inventory-auth] |
| A06 | `src/tools/invocation-runner.ts:777` | S1 argument hooks finalize input before script hook and permission. | [Native][inventory-native] |
| A07 | `src/tools/invocation-runner.ts:825` | S1 governed operation/principal binding retained; execution consumes exact capability. | [Plugin][inventory-plugin] |
| A08 | `src/tools/invocation-runner.ts:912` | S1 sealed input mismatch refuses resume. | [Auth][inventory-auth] |
| A09 | `src/permissions/permission-manager.ts:1359` | S4 normalized kind preserves MCP read-only hint. | [Native][inventory-native] |
| A10 | `src/tools/invocation-runner.ts:363` | S1/E selected route remains frozen and capability-bound; guest operands remain guest paths. | [Executor][inventory-executor] |
| A11 | `src/tools/invocation-runner.ts:1162` | S1 identity derivation remains tied to final input; memory later redecides minted evidence. | [Auth][inventory-auth] |
| A12 | `src/tools/invocation-runner.ts:1227` | S1 remote explicit-host capability denied independently of ordinary host-shell mode. | [Auth][inventory-auth] |
| A13 | `src/permissions/permission-manager.ts:1274` | S1 corrupt policy store normalizes admission denial; exact deny lookup retained. | [Manager][inventory-manager] |
| B01 | `src/tools/invocation-runner.ts:1926` | S1/E path/parser checks retained; dynamic/recursive uncertainty reaches central policy. Trusted native filesystem blocks re-enter the full pipeline as a fresh exact host request. | [Paths][inventory-paths] |
| B02 | `src/tools/shell-path-policy.ts:1397` | S2/S4 lexical/canonical effect and delete-intent evidence, including partial uncertain input. | [Paths][inventory-paths] |
| B03 | `src/tools/invocation-runner.ts:1879` | S1/E exact final command prepared under actual dialect and plan. | [Executor][inventory-executor] |
| B04 | `src/permissions/permission-manager.ts:590` | S1 credential admission versus S2/S4 path evidence separated; runner collects all edit targets. | [Native][inventory-native] |
| B05 | `src/permissions/permission-manager.ts:1283` | S1 retained credential stores; ordinary secret evidence reaches kind/mode pipeline. | [Native][inventory-native] |
| B06 | `src/tools/invocation-runner.ts:2294` | S3 authenticated directory result reused for exact call; no second category card. | [Native][inventory-native] |
| B07 | `src/tools/invocation-runner.ts:1384` | S4/S5/S7 one combined full-argument directory/invocation result. | [Native][inventory-native] |
| B08 | `src/tools/invocation-runner.ts:416` | R one runner history capture replaces removed directory deferred append. | [History][inventory-history] |
| B09 | `src/tools/invocation-runner.ts:2153` | S1 per-turn plugin allowlist retained; no permission bypass via skill load. | [Plugin][inventory-plugin] |
| B10 | `src/tools/pipeline/scoped-rule-subject.ts:9` | S3 scoped subject derives all edit targets and foreign-tool identity. | [Rules][inventory-rules] |
| C01 | `src/permissions/permission-manager.ts:1185` | S1-S6 normalized manager request delegates to one pure decision owner. | [Manager][inventory-manager] |
| C02 | `src/permissions/permission-manager.ts:1314` | S2/S4 dialect/path/uncertainty evidence; analysis limit is not a second mode matrix. | [Paths][inventory-paths] |
| C03 | `src/permissions/permission-manager.ts:1344` | S1/S3 deny/ask/allow inputs composed before central decision. | [Manager][inventory-manager] |
| C04 | `src/permissions/permission-manager.ts:1276` | S1 excluded remote capability; other-principal forced evidence retained. | [Auth][inventory-auth] |
| C05 | `src/permissions/permission-manager.ts:1274` | S1 untrusted rule store denies every category; no reviewer/allow override. | [Manager][inventory-manager] |
| C06 | `src/permissions/permission-manager.ts:1317` | S2 recognized exfil/protected/critical/escape floors remain forced. Opaque embedded command text with no typed exfil signal remains ordinary unproven evidence; direct upload and headless regressions cover the distinction. | [Risk][inventory-risk] |
| C07 | `src/permissions/decision-pipeline.ts:66` | S3 ask-before-allow follows forced floors; ordinary asks are no longer automatically forced. | [Golden][inventory-golden] |
| C08 | `src/permissions/permission-manager.ts:1279` | S2 staged/controller/other-agent origin evidence precedes reusable authority. | [Auth][inventory-auth] |
| C09 | `src/permissions/decision-pipeline.ts:81` | S4/S5 ordinary reads pass in strict; strict mutation asks. | [Golden][inventory-golden] |
| C10 | `src/permissions/decision-pipeline.ts:87` | S4 shell sandbox/read-only/unproven/destructive/escalation facts drive shared result. | [Golden][inventory-golden] |
| C11 | `src/permissions/permission-manager.ts:1363` | S4 checkpoint-backed file writes normalize to central file-write kind; no named local-memory category escape. | [Native][inventory-native] |
| C12 | `src/permissions/permission-manager.ts:1349` | S3 authenticated grants and ordinary host-shell rules enter shared pipeline; no local exact-only host result. | [Manager][inventory-manager] |
| C13 | `src/permissions/permission-manager.ts:1368` | S1 meta validation and E exact host execution receipt remain; receipt does not replace pipeline decision. | [Auth][inventory-auth] |
| C14 | `src/permissions/category-registry.ts:62` | S4/S5 category descriptor delegates non-meta outcomes; metadata no longer owns parallel matrix. | [Golden][inventory-golden] |
| C15 | `src/permissions/decision-pipeline.ts:26` | S5 ordinary auto asks identify asynchronous review; configured chain does not turn default into auto. | [Golden][inventory-golden] |
| C16 | `src/permissions/permission-manager.ts:1221` | S6 exact minted result is consumed once, adding review evidence and redeciding against current policy. | [Manager][inventory-manager] |
| C17 | `src/permissions/permission-manager.ts:706` | R display store accessor replaces queue coupling; dispatch no longer appends deferred grants. | [History][inventory-history] |
| D01 | `src/tools/invocation-authorization.ts:369` | S1-S6 authorization gathers facts and calls manager; unavailable manager remains failure. | [Auth][inventory-auth] |
| D02 | `src/tools/invocation-authorization.ts:18` | S3/S4 ordinary host-shell result binds live exact execution; exact-only caller gate removed. | [Auth][inventory-auth] |
| D03 | `src/tools/invocation-authorization.ts:322` | S2 remote/cross-agent/user-owned browser facts supplied before outcome, no read auto-pass rewrite. | [Auth][inventory-auth] |
| D04 | `src/tools/invocation-authorization.ts:151` | S1/E governed capability handled without local result replacement. | [Plugin][inventory-plugin] |
| D05 | `src/permissions/effect-enforcement.ts:282` | S1/S4 each actual plugin effect re-enters central policy; caller read/write/private-store result overrides removed. | [Plugin][inventory-plugin] |
| D06 | `src/tools/invocation-authorization.ts:455` | S6 reviewer orchestration consumes evidence through manager, not caller mode mapping. | [Auth][inventory-auth] |
| D07 | `src/tools/invocation-authorization.ts:448` | S3 remembered authority redecides exact minted evidence; fresh manual rerun skips lookup. | [Auth][inventory-auth] |
| D08 | `src/tools/invocation-runner.ts:416` | S5 no-approver denial captured once as history; no deferred approval result. | [History][inventory-history] |
| D09 | `src/tools/invocation-authorization.ts:216` | S1/S7 sealed rationale checks remain; consumed directory result cannot resume a different sealed action. | [Auth][inventory-auth] |
| D10 | `src/tools/invocation-authorization.ts:1079` | S7 selected central decision renders native card; forced other-principal requests skip reviewer/memory. | [Auth][inventory-auth] |
| D11 | `src/tools/invocation-authorization.ts:878` | S7/E policy-epoch race rejects card authority; exact permit retains identity; human consent does not reopen turn breaker. | [Auth][inventory-auth] |
| F01 | `src/permissions/rules/scoped-rule-matcher.ts:73` | S1/S2/S3 all-target deny/ask, protected/escape floor and allow coverage remain evidence. | [Rules][inventory-rules] |
| F02 | `src/permissions/allowed-directories.ts:6` | S4/S7/E roots/grant sanitization rejects host admission paths; ordinary secrets are not blanket ungrantable. | [Paths][inventory-paths] |
| F03 | `src/permissions/sensitive-paths.ts:554` | S1 credential subset, S2 exact protected controls/escape, S4 ordinary secrets separated. Native confinement projection remains E; trusted shell block escalation re-enters policy without changing worker grants. | [Native][inventory-native] |
| F04 | `src/permissions/rules/powershell-exfiltration.ts:912` | S2/S4 separate dialect path/delete/credential evidence. Direct recognized exfil stays forced; opaque unproven payload text does not invent another forced floor. | [Risk][inventory-risk] |
| F05 | `src/permissions/reviewer/risk-classifier.ts:1903` | S6 classifier remains risk evidence. Framework v4 removes obsolete configuration routing prose. Typed risk-floor suite passes 449 cases, separating recognized direct effects from opaque unproven payloads. | [Risk][inventory-risk] |
| F06 | `src/permissions/user-approval-store.ts:353` | S1/S3/S7 exact source/trust/cwd scope and deny persistence retained; forced/manual rerun cannot reuse grant. | [History][inventory-history] |
| G01 | `src/tools/invocation-runner.ts:925` | S1 script PreToolUse moved before permission/cards; target hook exit2 regression exercises zero cards/effects. | [Native][inventory-native] |
| G02 | `src/tools/invocation-execution.ts:8` | S1/E audit integrity/rate budget retained before handler; no approval repairs unwritable required audit. | [Executor][inventory-executor] |
| G03 | `src/tools/file-access-policy.ts:24` | E native file execution checks admission subset, exact directory and links; approved ordinary native secret reads execute. Native OS filesystem refusals use the fresh host-request bridge rather than lifting the deny in place. | [Native][inventory-native] |
| G04 | `src/tools/invocation-execution.ts:813` | E abort/audit/controller/route/account/exact permit binding retained at effects. | [Executor][inventory-executor] |
| G05 | `src/tools/guarded-file-transfer.ts:90` | S1/E both transfer endpoints, reached entries and absent-destination ownership remain retained. | [Transfers][inventory-transfers] |
| G06 | `src/tools/invocation-execution.ts:847` | S6 late breaker uses ordinary card/no-approver denial; fresh human response does not resume automation for turn. | [Gate][inventory-gate] |
| G07 | `src/tools/invocation-execution.ts:15` | E reached canonical fetch destination/rules remain rechecked; new consent uses owning effect route. | [Egress][inventory-egress] |
| G08 | `src/tools/invocation-execution.ts:88` | S5/E runtime no-surface outcomes remain terminal and audited; handler result is not permission replay. | [Executor][inventory-executor] |
| H01 | `src/mcp/mcp-tool-adapter.ts:37` | S4 discovery annotation preserved on host Tool and reaches normalized MCP kind. | [Native][inventory-native] |
| H02 | `src/permissions/reviewer/host-risk-inspector.ts:211` | S4 host effective category remains evidence; it cannot create independent mode authority. | [Plugin][inventory-plugin] |
| H03 | `src/permissions/effect-enforcement.ts:242` | S1-S7 per-actual-effect policy with exact payload/path identity, not enclosing tool grant. | [Plugin][inventory-plugin] |
| H04 | `src/plugins/isolation/host-api-dispatcher.ts:869` | S1/E manifest/account/generation/capability checks retained independently of permission outcome. | [Plugin][inventory-plugin] |
| H05 | `src/main/host-fetch-guard.ts:220` | S1/E destination/redirect/SSRF/credential lease checks retained; actual network effect uses central policy. | [Egress][inventory-egress] |
| H06 | `src/permissions/egress-ask.ts:223` | S1/S3/E network identity and destination-class guards retained; agent requester carries headless/owner-away; physical terminal remains O. | [Egress][inventory-egress] |
| H07 | `src/permissions/egress-approval.ts:29` | S7 agent-network adapter consults central manager/reviewer; destination/class grants retain identity and lifetime. | [Egress][inventory-egress] |
| I01 | `src/permissions/approval-gate.ts:861` | S7/E gate validates signed choice/plan identity; no blanket secret re-deny or reviewer-HIGH forced rewrite. | [Gate][inventory-gate] |
| I02 | `src/permissions/approval-gate.ts:20` | S7 missing live surface denies; gate no longer independently auto-allows read-only asks. | [Gate][inventory-gate] |
| I03 | `src/tools/pipeline/reviewer-dispatch.ts:53` | S6 central reviewer result mapping; ordinary HIGH/error fallback is normal card; queue append deleted. | [Auth][inventory-auth] |
| I04 | `src/permissions/judge/judge-breaker.ts:88` | S6 counters reset at active turn, 3 consecutive/20 total; manual-resume module deleted. | [Gate][inventory-gate] |
| I05 | `src/permissions/approval-gate.ts:730` | S5/S7 away-authority implementation/API/UI removed; owner-away solely waits for actual human. | [Gate][inventory-gate] |
| I06 | `src/permissions/approval-gate.ts:1239` | S7 zero owner-away timeout means unlimited; configured N minutes denies with no-retry; integrity stays. | [Gate][inventory-gate] |
| I07 | `src/permissions/reviewer/recently-denied.ts:21` | R old queue module removed; capped redacted history with one-use live callbacks or non-executable references to existing saved transcript calls. The replay resolver revalidates digest/root/tool/schema before fresh admission. | [History][inventory-history] |
| I08 | `src/ipc/domains/permissions.ts:877` | R guarded native user rerun, no stored-entry approval or grant mint. | [History][inventory-history] |
| J01 | `src/engine/turn/query-loop.ts:1586` | S5 host owner-away no longer sets headless by itself; root turn begins breaker scope. | [Gate][inventory-gate] |
| J02 | `src/tools/invocation-authorization.ts:322` | S1/S2 intercepted privileged actions preserve remote capability and other-principal one-shot checks. | [Auth][inventory-auth] |
| J03 | `src/permissions/approval-gate.ts:248` | S2/S7 child escalation remains native one-shot; parent automatic adjudication removed, ancestry/liveness retained. | [Gate][inventory-gate] |
| J04 | `src/permissions/approval-gate.ts:868` | R old child deferred append removed; app-open owner-away waits, headless denies. | [History][inventory-history] |
| J05 | `src/hooks/hook-command-policy.ts:51` | S1-S7 hook command uses actual plan/argv/cwd, dispatches and consumes reviewer evidence, then binds fresh policy/effect/cwd identity before spawn. Signed allow-once/session/always answers issue the same one-use exact host receipt. | [Hooks][inventory-hooks] |
| J06 | `src/tools/skill-load.ts:64` | S1/S7/E existing content-hash scoped skill approval remains; no broad permission from loading instructions. Not newly refactored by this lane. | [Skills][inventory-skills] |
| J07 | `src/permissions/agent-action-approver.ts:34` | O preserved transport/capability consent, not tool execution: local-api-server.ts:246 and :265 adapt explicit external mutation/boot consent; a2a-remote-runtime.ts:179 binds message credential/lineage consent; core/work-board-engine.ts:472 approves the workflow plan. These do not replace any tool pipeline result. | [Actions][inventory-actions] |
| J08 | `src/permissions/permission-mode-apply.ts:74` | O user-only mode configuration retained with provenance; stable IDs/new-install strict in mode/store consumers. | [Modes][inventory-modes] |
| J09 | `src/main/terminal/pty-manager.ts:840` | O physical typing remains owner-terminal action; agent terminal commands retain scoped runtime identity. No pending selector-source proposal adopted. | [Terminal][inventory-terminal] |
| Q01 | `src/shared/ipc-channels.ts:101` | R list/rerun/changed channels replace old queue API across shared/preload/main/renderer. | [Channels][inventory-channels] |
| Q02 | `src/ui/renderer/dialogs/RecentlyDeniedDialog.tsx:5` | R old queue dialog/panel removed; history closes before the fresh rerun card. Restart rerun may resolve a saved transcript reference; missing or changed references remain unavailable. | [HistoryUI][inventory-historyui] |
| Q03 | `src/i18n/messages/generated/recentlyDenied.ts:2` | R history namespace/generated barrels replace queue fragments; IPC error mapping localized. | [HistoryUI][inventory-historyui] |
| Q04 | `src/ui/renderer/tabs/PermissionsTab.tsx:323` | S5/S7 stable modes, zero/unlimited setting and informational history; no parent auto-answer controls. | [Modes][inventory-modes] |
| K01 | `src/tools/file-read-core.ts:49` | E native approved secret read/explicit root grep/list executes; unapproved broad secret descendants and credential stores remain filtered. | [Native][inventory-native] |
| K02 | `src/main/browser/browser-upload.ts:245` | Retained E/O selected upload/instruction import identity and secret restrictions; not an automatic secret-discovery grant or mode bypass. | [Browser][inventory-browser] |
| K03 | `src/plugins/isolation/out-of-process-plugin.ts:124` | E preserved worker capability envelope and broad native sensitive projection; ordinary approval never widens worker grants. Forged plugin/MCP metadata cannot request host replay. Actual native block attribution is macOS-only; controlled Linux executor cases do not certify a Linux native bridge. Owner acceptance or a trusted Linux supervisor remains pending. | [Plugin][inventory-plugin] |
| K04 | `src/tools/invocation-runner.ts:2504` | E executable expansion retains sensitive-path omission. The macOS native monitor can issue command/cwd-bound evidence for one fresh host request. Installed Linux diagnostic attempts are rejected, so Linux keeps the original failure; no native Linux coverage is claimed from controlled executor tests. Owner acceptance or trusted Linux supervisor remains pending. | [Escalation][inventory-escalation] |

Test references identify relevant behavioral suites; they do not assert every case was rerun. The earlier three Risk failures were resolved by the typed-effect-versus-opaque-payload cases described above; the latest risk suite passes 449/449. Other integrated results and rendered/native verification are recorded separately.

[inventory-golden]: ../../src/permissions/__tests__/decision-pipeline.test.ts
[inventory-manager]: ../../src/permissions/__tests__/permission-manager-pipeline.test.ts
[inventory-native]: ../../src/tools/__tests__/executor-native-permission-pipeline.test.ts
[inventory-auth]: ../../src/tools/__tests__/invocation-authorization-pipeline.test.ts
[inventory-executor]: ../../src/tools/__tests__/executor.test.ts
[inventory-plugin]: ../../src/tools/__tests__/executor-plugin-read-relaxation.test.ts
[inventory-history]: ../../src/tools/__tests__/executor-recently-denied.test.ts
[inventory-paths]: ../../src/tools/__tests__/shell-path-policy.test.ts
[inventory-rules]: ../../src/permissions/__tests__/scoped-rules.test.ts
[inventory-risk]: ../../src/permissions/__tests__/risk-classifier.test.ts
[inventory-gate]: ../../src/permissions/__tests__/approval-gate.test.ts
[inventory-transfers]: ../../src/tools/__tests__/guarded-file-transfer.test.ts
[inventory-egress]: ../../src/permissions/__tests__/egress-approval.test.ts
[inventory-hooks]: ../../src/hooks/__tests__/hook-command-policy.test.ts
[inventory-skills]: ../../src/tools/__tests__/skill-load-turn-scope.test.ts
[inventory-actions]: ../../src/permissions/__tests__/agent-action-approver.test.ts
[inventory-modes]: ../../src/ui/renderer/tabs/__tests__/PermissionsTab.test.tsx
[inventory-terminal]: ../../src/main/terminal/__tests__/pty-manager.test.ts
[inventory-channels]: ../../src/ipc/__tests__/channel-inventory.test.ts
[inventory-historyui]: ../../src/ui/renderer/components/__tests__/RecentlyDeniedPanel.test.tsx
[inventory-browser]: ../../src/main/browser/__tests__/browser-upload.test.ts
[inventory-escalation]: ../../src/tools/__tests__/executor-sandbox-escalation.test.ts

Persisted history references: [resolver](../../src/permissions/reviewer/recently-denied-replay.ts) and [reconstruction tests](../../src/permissions/__tests__/recently-denied-replay.test.ts). References contain identity/digests rather than executable inputs; saved transcript lookup is revalidated before a fresh user-approved invocation. Restart alone does not disable a valid reconstructable reference.

## Decision-owner branch accounting

The measurement uses syntax-tree counts of `IfStatement`, `ConditionalExpression` and `SwitchCase`, including nested statements, over ten complete unique legacy decision-owner functions at baseline `89acbc0d0`. The legacy sum is **732** (379 if statements, 339 conditional expressions and 14 switch cases). The current `src/permissions/decision-pipeline.ts` module contains **23** (20 if statements, 3 conditional expressions and no switch cases). These are AST branch-node counts, not diagram nodes or cyclomatic-complexity scores.

| Baseline file | Complete function | Baseline lines | If | Conditional | Switch case | Total |
| --- | --- | --- | --- | --- | --- | --- |
| `src/tools/invocation-runner.ts` | `runToolInvocation` | 317–2419 | 95 | 74 | 0 | 169 |
| `src/tools/invocation-authorization.ts` | `authorizeToolInvocation` | 180–2114 | 60 | 82 | 0 | 142 |
| `src/tools/invocation-execution.ts` | `executeAuthorizedToolInvocation` | 200–1547 | 78 | 58 | 0 | 136 |
| `src/permissions/permission-manager.ts` | `evaluatePermission` | 1237–1673 | 61 | 43 | 0 | 104 |
| `src/permissions/permission-manager.ts` | `categoryBasedDecision` | 2157–2259 | 6 | 4 | 6 | 16 |
| `src/permissions/permission-manager.ts` | `routeJudge` | 593–598 | 3 | 1 | 0 | 4 |
| `src/permissions/approval-gate.ts` | `requestAndWait` | 1483–2180 | 31 | 42 | 0 | 73 |
| `src/permissions/effect-enforcement.ts` | `gateMutatingEffect` | 124–232 | 8 | 3 | 5 | 16 |
| `src/permissions/egress-ask.ts` | `createEgressAskCallback` | 161–429 | 34 | 23 | 3 | 60 |
| `src/tools/pipeline/reviewer-dispatch.ts` | `resolveDispatchedJudge` | 34–62 | 3 | 9 | 0 | 12 |

The old functions include admission, effect binding, transport and orchestration guards as well as permission choices; the new count covers the decision-owner module alone. Evidence collection, audit, execution checks and orchestration remain outside that module. The figures therefore describe concentration of decision ownership and are not an equivalent whole-system before/after reduction or proof that 709 checks disappeared. The 97-site table accounts for retained E/O boundaries separately.
