# Workflow templates — engine plan (PR-B: WT-3 … WT-8, PR-E: WT-15 … WT-18)

Design only; no product code changes. Code read against main `c2214d704`. Authority: `decisions.md` and `unattended-review.md` on `origin/design/workflow-templates` at `a3df543d4` (D1–D9, W1, W2, OD-1..OD-4). Where `notes-r6.md` (c) disagrees with the decisions, the decisions win.

Revision 2 (2026-11-16) applies the owner's answers:

- A workflow is general-purpose. Nothing in the engine assumes git, source code or a build. A stage works on files and tools; git is one kind of workspace.
- W1: every stage has its own workspace under the Ave home; parallel stages always run in parallel; the serial fallback is gone. Joins never touch the user's branch or folder.
- W2: host commits carry the user's git identity and a run/stage trailer; ignored and secret files are never copied; setup commands ask like any tool call.
- Reviewer breaker: one breaker per stage session and per grandchild for template runs. The shipped flow is unchanged.
- `Create and run` starts only the current confirmed version. A schedule starts its attachment pin.
- The Review lane is derived from `stageRuns`; `awaiting_approval` never appears without a `planApproval`.
- WT-8 is no longer blocked: it is the schedule attachment plus the interim limit that only all-read-only templates may be scheduled. PR-E (WT-15..WT-18) lifts the limit.

Revision 3 (2026-11-16) aligns the plan with the WT-2 types that shipped at `bf73b8a6e` (branch `wt/2-store-b`). Where the SSOT spelled out a shape, the code kept it and the plan now follows the code: §13 lists the shipped shapes and names. Lead rulings applied in the same revision:

- Two hashes. `resultHash` binds a stage gate to the stage output. `outputHash` binds a requested-output approval (§10). At `bf73b8a6e` the stage-run gate field is still named `outputHash`; a follow-up WT-2 lane renames it to `resultHash`, and this plan uses `resultHash` for gates everywhere.
- Tools an envelope declares are generation or fetch tools with a data-sent flag. A publishing tool is never allowed in an envelope.
- Code an item takes from an upstream project is ported under the attribution rule of §15.

Revision 4 (2026-11-16) applies the lead rulings on R16–R20 and the fixes from the rev3 review:

- R16–R20 are decided (§14.1). R20 removes the host table of tool names: each template `requestedOutputs` entry declares a `kind`, an exact `toolName` and an owner id, all inside `graphHash`, and matching is exact only (§10). WT-17 is no longer blocked.
- Setup commands reach all-tools stages only, as one rule in §2.5, §3.4 and R17.
- Lead ruling R21: the attachment stores the scope it was approved for, and a scheduled run takes its project only from that snapshot. A template whose scope changed since refuses `scope-changed` until someone attaches again. The `Create and run` approval also binds the project root shown on the card (§2.4, §7.2).
- Detach has one outcome per case (§2.4, §7.2).
- §15 carries the owner's exact attribution rule.
- Shape and validation changes the rulings need from WT-2 are listed in §13 as "WT-2 follow-up lane (pre PR-A)".

Revision 5 (2026-11-16) applies the lead's rev4 choices C1–C4 and the fixes from the rev4 review. Shipped names were read again at `9ead78a61` (WT-2 review fixes on top of `bf73b8a6e`).

- C1: an explicit detach removes the routine. Plain removal of a `template-run` routine that has an active attachment is refused, and the refusal names detach (§7.1, §7.2). WT-8.
- C2: a git push is a requested output with the reserved owner id `host:git`, tool name `git_push` and kind `external-write`. The engine performs it after the human gate; it is never a model tool. The `host:` owner prefix is reserved (§10, §13.1). It replaces the rev4 default that refused every push request.
- C3 replaces the R17 validation wording: setup commands are refused only for a template with no all-tools stage. A mixed template may carry them, and they reach all-tools stages only (§3.4, §13.1).
- The codes `project-mismatch`, `scope-not-authorised` and `output-not-declared` are confirmed. Each is a reasonCode with en and ko strings and a test that reaches it (§2.4, §10).
- C4: §15 keeps only the neutral attribution rule. The candidate list moved to the PR body.
- R19: `dataSent` decides nothing anywhere; the denial example in §8 is gone.
- One run per schedule holds across a reattach: admission looks at every attachment id of the routine, current and detached, through one serialized path (§7.2). WT-8.
- At `9ead78a61` the gate field is already named `resultHash`, and the store's confirm method is `confirmDraft` with `expectedDraftRevision`. §13 and §13.1 say so where they name them.

Revision 6 (2026-11-16) follows the WT-2 head that shipped, `51d5d582f` (branch `wt/2-store-b`), applies the lead ruling R22 and fixes the two findings of the rev5 review. Where an earlier revision note above says a change is left for a WT-2 follow-up lane, that lane is finished and the change is in `51d5d582f`.

- §13 lists the shapes and names of `51d5d582f`. §13.1 no longer lists requests: it records what shipped for R17 with C3, R20, C2 and R21, and what WT-3, WT-8 and WT-17 must call.
- Every type the plan tells the engine to import is exported at `51d5d582f`. `RunPin`, `LaneBlockCode`, `OutputExecution`, `JoinConflict`, `OutputFile` and `StageGate` are private to their module there. The engine uses `TemplateVersionPin` for the pin and derives the others from exported aggregates (§2.2). No new WT-2 export is needed.
- Three shipped facts differ from what rev5 expected, and the plan follows the code: the declaration-time name check for publishing tools is gone (§8, §13; revision 7 states the design that replaces it); `setup-outside-commands` no longer compares setup commands with a stage's `commands` (§3.4); a stored attachment with no scope snapshot still loads and is refused `scope-changed` when it is used (§2.4, §13.1).
- The four reason-code strings shipped in en and ko. WT-3 and WT-17 emit the codes and add the reaching tests; they add no strings for them (§2.4, §10).
- R22 is decided (§14.1): the engine push may use the git credentials the user already configured, inside the bounds of §10. It replaces the rev5 default that used no credential helper. `remote-not-configured` is a new code with en and ko strings, owned by WT-17.
- §15 states the owner's port rule in full again, in neutral prose.

Revision 7 (2026-11-16) follows the WT-2 head `6942aca82` (branch `wt/2-store-b`: the review-2 fixes, one commit on top of `51d5d582f`) and applies the lead's review-2 rulings, ruling P, the push details 1–4 and ruling G1. Where a note above or a section below says a thing shipped at `51d5d582f`, it is unchanged in `6942aca82`. The engine builds on `6942aca82`.

- Two of rev6's three "shipped facts" are reversed by `6942aca82`. Confirmation again refuses an all-tools stage whose envelope does not cover the template's setup commands (N1, §3.4). `approvedScope` is required, and a template file that holds an attachment without one is refused when it loads (N2, §2.4, §13).
- The third is replaced by ruling P (§8). The declaration-time ban is the closed effect enum. At confirm, an envelope tool that the host registry flags as outward-effect, or about which it has no metadata, is refused. It is judged by registry metadata and never by name. P did not ship in WT-2: it is WT-15's, with its success criteria (§8, §12).
- N8: the scope snapshot is the authorised project-registry root, compared exactly. It is not a filesystem real path (§2.4, §13).
- N3: `resultHashOf` shipped in `shared/workflow-template-output.ts`. WT-3 imports it and adds none (§2.6).
- B: `work-board/board.json` is in the home trust manifest (§13). N7: the shipped detach handler no longer looks the project up (§7.1).
- Push details 1–4 are lead rulings and replace R23 (§10, §14.1): one approval pushes at most once; the resolved URL, with its user-info part stripped, is bound into `outputHash`, and a mismatch at execution ends `failed`; a bad request is refused at request and fails again at execution; the record is in `OutputExecution.detail` with no credentials.
- G1: WT-16 does not merge before WT-15's outward-effect resolver is on main, and a WT-16 test enforces it in code (§9, §12).
- P3-3 (WT-2 review 3): the P check also covers a version confirmed before WT-15 landed, and every attachment of one. It is asked again at attach, at fire and before every spawn, before WT-16 lifts the read-only limit (§8, §9).

Revision 8 (2026-11-16) applies the lead's rulings Q1–Q6 on rev7 and the fixes from the rev7 review. No shipped code changed: the engine still builds on `6942aca82`. Where a rev7 note above says the P check refuses a confirmation, or that an attachment is listed "needs reattach" for it, this revision replaces that.

- Q1: the codes `outward-effect-tool` and `tool-effect-unknown`, with their en and ko text, are decided (§8).
- Q2: ruling P never blocks a confirmation. The envelope governs the unattended lane only. Confirm succeeds and writes the version with its envelope unchanged inside `graphHash`; the confirm screen marks the version "can't run unattended: `<tool>` `<reason>`"; attach is refused with that code (§8).
- Q3: R25 is accepted. All four envelope tool collections are checked (§8). Q4: R24 is accepted as stated and stays open. A generation tool that is not read-only is unknown, and unknown is refused for the unattended lane only (§8, §14.3).
- Q5: after the URL compare, the engine pushes to the compared URL itself, not to the remote name, so nothing resolves the remote again between the compare and the push (§10).
- Q6: the P check is asked again at attach, at fire and before every spawn, and a temporary unknown is refused like a permanent one. A fire that fails it is skipped with the status "skipped: `<tool>` unavailable" and counts toward the existing schedule breaker; it is not "needs reattach". A spawn that fails it settles the run `cancelled` with the reason code (§2.4, §7.2, §8, §11).
- One qualification result carries the failing tool and the reason from the one check to the attach, fire and spawn verdicts. `unattendedAllowed` returns it instead of a boolean, and `RunAuthorityVerdict` gains the two codes and the tool (§2.2). The lead approved this result. The limit-lifting commit of WT-16 owns the coordinated change of the predicate and its consumers, with integration tests that show the tool and the reason at attach, at fire and at spawn (§9).
- The two summaries of the setup-command validation now state both causes: no all-tools stage (C3), and an all-tools envelope that does not cover a setup command (N1) (§3.4, §14.1).

Revision 9 (2026-11-16) applies the lead's rulings on rev8 and three leftovers of rev8. No shipped code changed: the engine still builds on `6942aca82`. Where a rev7 or rev8 note above says the push URL has its user-info part stripped, or calls a ko text a draft, this revision replaces that.

- R26 is ruled (§10, §14.1): only secrets are stripped from the push URL. An ssh or scp-form user name is kept and is not a secret.
- URL rewrite rules are ruled, not deferred (§10, §14.1): the bound and displayed URL is the post-rewrite push URL that `git remote get-url --push <remote>` reports. Execution resolves it the same way, compares, and pushes to that literal URL. Two WT-17 tests replace the rev8 "not verified" caveat.
- Items 3–10 of the rev8 proposal, the two ko texts among them, are accepted as listed in §14.1. R25 is closed. Storing the resolved URL in `args` is this plan's mechanism and is not one of those items.
- Leftovers: at attach a version with a stage that has no envelope is refused with the shipped code `schedule-requires-read-only` (§2.2, §7.2, §8, §9); `EnvelopeToolRef` and `UnattendedQualification` are listed as WT-3's additions to `shared/workflow-template-types.ts` (§2.1, §12, §13.1); the tool and reason placeholders are code spans.

Revision 10 (2026-11-16) applies the lead's rulings on rev9 and on the rev9 review. No shipped code changed: the engine still builds on `6942aca82`. Where a note above says that pushing to the compared URL is enough to bind the endpoint, or that a stage with no envelope is refused at attach before the limit is lifted, this revision replaces that.

- Push URL guard (§10, §14.1): a URL given to git on the command line is still rewritten by `insteadOf` and `pushInsteadOf` rules. Immediately before the push the host reads the effective rewrite rules and refuses when any of them would rewrite the bound URL. WT-17 gains the tests for it. One residual is accepted and recorded: the user's own configuration edit between that read and the push.
- A remote with more than one push URL is refused `remote-not-configured` (§10).
- User-name-specific https credential or rewrite configuration is not supported by the engine push, because the whole https user-info part is stripped (§10). A two-account fixture bounds the outcome.
- The no-envelope refusal is a rule of the lifted limit only. While the interim limit stands, `isAllReadOnlyVersion` is the predicate and an all-read-only stage with no envelope still qualifies (§7.2, §9). The lift tests gain the boundary case.
- The §14.1 row for the rev8 choices lists exactly the accepted items 3–10. The `args` shape `{ remote, url }` is described as a plan mechanism.
- One consequence of the lift is listed as open (R27, §14.3): an attachment made under the interim limit for a version with a stage that has no envelope.

Revision 11 (2026-11-16) applies the lead's rulings on rev10 and repairs a defect in rev10's guard tests. No shipped code changed: the engine still builds on `6942aca82`. Where a note above says that R27 is open, or where rev10 gave every failure of the push URL steps the text "push failed: remote URL changed", this revision replaces that.

- Guard fixtures (§10). In rev10 the fixtures of guard cases 1, 2 and 5 put a rule on U itself after the approval. That rule also changed what the remote resolves to, so the compare refused and the guard was never reached. Now U is reached through a rule that exists at approval, or for `pushInsteadOf` through an explicit `pushurl`. The new rule matches U and leaves the remote's resolved URL unchanged, and each test asserts that the compare passed. The failed-read test had the same fault and is repaired with an injected read result.
- The guard also runs at request, where it refuses `remote-not-configured`, and is checked again at execution (§10). So the guard cases are now split by when the rule exists: at request, or only after the approval.
- The rule read (§10): exit 1 with empty output means no rules; exit 128 or any other error is a read failure. Each has a test.
- Two failure texts, each in en and ko (§10): "push failed: push URL could not be verified" for a guard refusal and for a configuration read failure; "push failed: remote URL changed" for a compare mismatch only.
- The https limitation is stated plainly and is required in user-facing help text (§10): with several https accounts on one host, use SSH or a credential helper keyed by path.
- R27 is ruled (§7.2, §9, §14.1): the template file loads, and only that attachment is refused. Its state is labelled "needs a new version: add envelopes and confirm", not "needs reattach", and its refused fire counts toward the schedule breaker.
- The points this revision had to choose (R28, R29) were accepted by the lead and are ruled (§10, §14.1).

Stage statuses use the WT-2 names. Mapping to the brief's words: pending = `waiting`, gate = `awaiting_gate`, stopped = `cancelled`.

## 0. Findings that change the build

| # | Finding (verified) | Consequence |
| --- | --- | --- |
| F1 | The reviewer breaker is keyed by the root session, and a child of `work-board:<id>` resolves to that origin (`src/permissions/root-session-resolver.ts:19`; calls at `permission-manager.ts:667, 1734, 2019, 2101`). The counter resets only at a depth-0 turn (`engine/turn/query-loop.ts:353`) and is forgotten only by `endSession(root)` (`permission-manager.ts:1063-1066`), which no work-board path calls (the only caller is `permissions/session-scope-end.ts:16`, reached from chat delete `ipc/domains/chat.ts:1678` and routine removal `ipc/domains/routines.ts:89`, `boot/steps/workflow-stores.ts:143`; repo-wide grep). | Today all children of one item share one counter that is never reset in the process. The owner corrected the breaker keying: template runs key the breaker per stage session and per grandchild (§4.3); the shipped flow keeps today's keying. |
| F2 | "This session" grants are keyed by the requesting session: rules in `permission-manager.ts:579, 982, 1004`; exact approvals in `user-approval-store.ts:202, 429, 452`. | Sibling stage sessions share nothing today. D5 needs a new scope; it cannot reuse the item origin, which would cross runs. |
| F3 | One visible card is a renderer rule only. The host gate holds any number of pending requests (`permissions/approval-gate.ts:700`); the window FIFO is `lib/approval-queue-reducer.ts` via `ui/renderer/hooks/use-approval.ts:84`; the board draws per item in `components/work-board/use-board-approvals.ts:88-101`. | D4 needs no host change. |
| F4 | A child's first-turn trust origin is hard-coded (`engine/subagent-runner.ts:3011`), and `SubAgentSpawnResult` (`:224`) reports none. | D7 "taint carries" needs one host-only spawn input and one result field. |
| F5 | `reconcileInterruptedRuns` turns every `executing` item into `error` (`main/work-board-store.ts:757-762`); only a decidable plan survives (`:756`). | A parked stage gate would die on restart. The reconcile rule changes (§2.7). |
| F6 | `inFlight` is a mutex: a decision is refused `already_running` while a phase runs (`core/work-board-engine.ts:783-787`). | With parallel stages a gate decision must land while siblings run. Template runs use a per-item serial event queue instead (§2.2). |
| F7 | Three independent blocks stop nested spawning: the blocklist (`subagent-runner.ts:625`, applied `:2336-2343`), `spawnDepth: 1` (`:3007`, `:3946`), the tool's refusal (`tools/agent-spawn.ts:162-165`). A grandchild's origin is a real session id, so `buildSubAgentApprovalProvenance` (`:862-884`) would route its asks to the stage model. | D2 must change all three and force direct-to-user approval (§5). |
| F8 | No worktree helper exists. Host git calls go through `buildHostGitArgs` (`shared/host-git.ts:47`); the marketplace `GitRunner` (`marketplace/git/run-git.ts:209`) is transport-specific. | WT-4 adds its own small git module. `HOST_GIT_CONFIG` (`shared/host-git.ts:5`) covers only bare-repository discovery and fsmonitor, plus the hooks path; filters, textconv, credential prompts and signing are not covered and WT-4 must add them for its calls. |
| F9 | The Ave home is closed twice. Reads: the sandbox denies the whole home and re-opens only the rows of `AVE_HOME_READ_REALLOWS` (`permissions/ave-home-read-boundary.ts:26-42`); there is no `worktrees` row. Writes: `protectedControlEntryFor` (`permissions/sensitive-paths.ts:568-591`) classes every path under the home as `application-home`, a protected-path floor, except `<home>/workspace` (`:580-583`). | A stage workspace under `<home>/worktrees/` is unreadable in the sandbox and every write to it is a forced ask (a deny when nobody can answer) until both places change. WT-4 owns both edits (§3.5). Lead ruling T2: the write and read carve-out is a session binding, not a path prefix. |
| F10 | `revokeWorkspaceRoot` (`engine/subagent-runner.ts:1066-1095`) cancels only wire children whose `wireProjectRoot` equals the removed root (`:999`); every other active child only has that root removed from its scopes. | A stage child's root is its own workspace, so removing the project does not stop it. The engine must interrupt stage children itself; a test proves it (§2.9, answers Q13). |
| F11 | `decidePermission` has one call site (`permissions/permission-manager.ts:1432`). In the Allow mode `applyMode` (`permissions/decision-pipeline.ts:54-57`) returns allow before the no-approver deny for everything but an exfiltration signal in a headless request (`:55-56`), a secret-file read included (`:126`). | A schedule-started child that takes the ambient mode can act with nobody present. WT-8's interim children must not take it (§7.4, R8); WT-15 removes the dependency. |
| F12 | A headless tool scope drops every MCP tool and every egress builtin (`engine/turn/tool-scope.ts:119-121, 136`). | The unattended lane needs "declared tools only" instead of "none" (WT-16). |
| F13 | The only host-assigned budget of a child is `maxRounds` (`subagent-runner.ts:197`). `SubAgentSpawnResult` (`:224`) carries no cost, and routine metrics carry tokens only (`shared/routines-types.ts:142-147`). | WT-18 can enforce rounds and minutes now. A cost budget has no verified source (R11). |

## 1. Hook points in today's code

| Concern | Anchor | Use |
| --- | --- | --- |
| Engine factory, deps | `core/work-board-engine.ts:108, 422`; wired `boot/steps/conversation-wiring.ts:613` | Add template deps; `runItem` branches on `item.templateId`. |
| Single-child state | `:429 inFlight`, `:431 planSettling`, `:434 executingChildByItem`, `:438 cancelRequested`, `:441 executingTurnByItem` | Shipped flow keeps them. Template runs use `StageRunEngine` state. |
| Approval surface per phase | `:468-481 guarded` (attach `:470`, release `:479`); children inherit at `subagent-runner.ts:2703`; registry `permissions/approval-surface-registry.ts:42, 123, 185` | Template run attaches once per live period of the run, releases when no child is live. |
| Run start | `:483 runItem` (guard `:494`), `:526 runItemGuarded`, `store.beginRun` `work-board-store.ts:696`; IPC `ipc/domains/work-board.ts:234` | The `Create and run` tuple becomes the pin in `beginRun`. |
| Child creation | `:592-627` plan spawn, `:680-708` execute spawn; `SubAgentSpawnInput` `subagent-runner.ts:185`; `spawn` `:2423` | `spawnStageChild` is the only spawn site for template runs. |
| Fenced data | `engine/parent-directive.ts:54 fenceDirective`, `:72 formatPlanRevisionDirective`; `neutralizeFenceClose` from `shared/fence-sanitizer.ts` | New `formatStageInputDirective`. |
| Work approval | engine `:772 noteRefusal`, `:779 decidePlan`; store `:887 decidePlan`, `:131 planHashOf`; IPC `ipc/domains/work-board.ts:316` (sender, keyboard intent, owner frame, redaction, audit) | `decideStageGate` and `decideStageJoin` copy this boundary exactly. |
| Steer / Stop | engine `:936 steerRun`, `:961 cancelRun`; runner `:1659 queueHostDirectiveToWorkBoardChild`, `:2069 interruptRun`; IPC `:278`, `:373` | Resolve the child by `stageId` from host state. |
| Restart | `boot/steps/work-board-setup.ts:22` → `work-board-store.ts:746` | Stage-aware reconcile. |
| Progress, transcript | `shared/work-board-types.ts:259, 308, 329`; `work-board/run-transcript.ts`; channels `shared/ipc-channels.ts:54-82` | Optional `stageId`, `attempt`; phases `stage_gate`, `stage_passed`, `stage_failed`. |
| Card label | `subagent-runner.ts:904` (`[Sub-Agent: <title>]` at `:915`); work-board children get no parent adjudication (`:872-876`) | Stage title = stage name. |
| Tool approvals on the board | `use-board-approvals.ts:63` (session → item map `:70-77`) | Session → (item, stage) map. |
| Remembered approvals at `R` | F2 anchors; choices `approval-gate.ts:281`; rememberable test `:1155`; save `approval-rule-save.ts:185`, `ipc/domains/permissions.ts:1248`; scope type `shared/permissions-events.ts:11` | Run scope. |
| Breaker | `permissions/judge/judge-breaker.ts:17, 50, 88`; `judge/judge-engine.ts:171, 460, 501` | Per-session key for run members. |
| Trust origin | `engine/turn/trust-origin.ts:18, 66-80`; `query-loop.ts:348, 362-366` (a `file-content` origin sets the existing `other-principal` extension floor) | Carry taint in and out. |
| Routines | `shared/routines-types.ts:11, 69`; `main/routines-scheduler.ts:183`; `boot/steps/routines-wiring.ts:187`; `tools/routine-schedule.ts:139, 262`; headless deny text `permissions/decision-pipeline.ts:46`; store `main/routines-store.ts:74, 416, 665, 775` | WT-8: a third execution kind created only by the attach approval (§7). |
| Workspace helpers | none (F8). Project root reaches the child at `subagent-runner.ts:2695-2703`; workspace revocation `:1066` (F10); host git ordering `shared/host-git.ts:21, 31` | Every stage child gets its own workspace as its project root. |
| Ave-home boundary | F9 anchors; wraps in `permissions/asrt-sandbox.ts:689, 787, 1054-1095`; Windows home checks `shared/ave-home.ts:675, 1015-1027` | A stage session re-opens only its own workspace. |
| Decision pipeline | `permissions/decision-pipeline.ts:7 (request), 54, 74`; built in `permission-manager.ts:1397-1432`; review-required intermediate `decision-pipeline.ts:62, 108` | WT-15 adds the lane branch after the floors. |
| Sandbox route and egress | `permissions/host-shell-execution-plan.ts:28, 38`; `permissions/egress-runtime.ts:55, 67-97`; tool scope F12 | WT-16. |

## 2. WT-3 — stage scheduler

### 2.1 Modules

| File | New / changed | Content |
| --- | --- | --- |
| `src/work-board/workflow/stage-graph.ts` | new | Pure: `assertPinnedVersion`, `readyStages`, `parallelGroupOf`, cycle and unknown-id checks. |
| `src/work-board/workflow/stage-machine.ts` | new | Pure reducer: `(RunSnapshot, RunEvent) → { stageRuns, joins, runStatus, effects }`. |
| `src/work-board/workflow/stage-prompt.ts` | new | `buildStagePrompt`, bounds, taint union. |
| `src/work-board/workflow/stage-gates.ts` | new | Pass-condition registry; `stage_ok`, `check_exit_zero`. |
| `src/work-board/workflow/stage-workspace.ts` | new | `StageWorkspaceProvider` interface and `unavailableWorkspaceProvider`, whose `open` refuses `workspace-unavailable`. No template run can start until WT-4's provider is wired; tests use a fake. There is no shared-folder mode. |
| `src/work-board/workflow/stage-run-engine.ts` | new | Event queue, effect runner, `spawnStageChild`, stop, steer. |
| `src/work-board/workflow/run-authority.ts` | new | `authoriseRunSource`: the single run-authority function, with the D1 and OD-1 members (§2.4). |
| `src/work-board/workflow/workflow-errors.ts` | new | `WorkflowInvariantError` with a `code`. |
| `src/work-board/workflow/shipped-shapes.ts` | new | Type aliases only: the shipped shapes that are private to their module, derived from exported types (§2.2). |
| `src/core/work-board-engine.ts` | changed | Branch in `runItem`; add `decideStageGate`, `decideStageJoin`, `retryStage`, `continueRun`; `steerRun` / `cancelRun` take the template path. |
| `src/main/work-board-store.ts` | changed | Stage-aware reconcile only. `beginRun(…, pin?)` and `updateStageRun` shipped with WT-2 (§13). |
| `src/shared/work-board-types.ts` | changed | Event fields, refusal and result types. |
| `src/shared/workflow-template-types.ts` | changed | Two new exported types, and nothing else: `EnvelopeToolRef` and `UnattendedQualification` (§2.2). No shipped shape, validator or error code changes. |
| `src/shared/work-board-lifecycle.ts` | changed | `isAwaitingStageReview(item)`: true when any `stageRuns[]` is `awaiting_gate` or any join is `conflict`. The Review lane uses it (`:10, 21, 29-30`). |
| `src/ipc/domains/work-board.ts`, `src/shared/ipc-channels.ts`, `src/preload/internal-api-surface.ts` | changed | `ave:work-board:decide-stage`, `decide-join`, `retry-stage`; `stageId` on steer. |
| `src/engine/subagent-runner.ts` | changed | `hostInputTaint` in, `endTrustOrigin` out (F4). |
| `src/engine/parent-directive.ts` | changed | `formatStageInputDirective`. |
| `src/boot/steps/workflow-engine-extensions.ts` | new | One object of optional engine deps; later items add one line each. |
| `src/i18n/messages/en.ts`, `src/i18n/messages/ko.ts` | changed | Messages for the run-authority refusal codes the board shows. The strings for `scope-changed`, `project-mismatch` and `scope-not-authorised` already shipped with WT-2 as `reasonCodes.<code>`; WT-3 adds only the codes that have none (§2.4). |

### 2.2 Types and functions

The engine imports these names from `src/shared/workflow-template-types.ts`; each is exported at `51d5d582f`: `TemplateVersionPin`, `RunAuthoritySource`, `RunWorkspace`, `StageJoin`, `RequestedOutput`, `RequestedOutputDecl`, `RequestedOutputKind`, `TemplateRunStart`, `WorkItemStageRun`, `TemplateScope`, `ScheduleAttachment`, `TemplateStage`, `TemplateGraph`, `TemplateVersion`, `WorkflowTemplate`, `StageEnvelope` and `EnvelopeRefusal`. It also imports `EnvelopeToolRef` and `UnattendedQualification` from that file; they are not shipped, and WT-3 adds them there as types only (below). From `src/shared/workflow-template-output.ts` it imports `outputHashOf` and, exported at `6942aca82`, `resultHashOf`. They are repeated below only where the text needs them.

Six shapes exist at `51d5d582f` but are private to that module: `RunPin`, `LaneBlockCode`, `OutputExecution`, `JoinConflict`, `OutputFile` and `StageGate`. The engine does not import them. It writes the pin as `TemplateVersionPin`, which is the same type, and takes the others from exported aggregates in one WT-3 file (`src/work-board/workflow/shipped-shapes.ts`, type aliases only). This needs no change in WT-2. If a later lane finds a shape that cannot be derived this way, adding its export to `workflow-template-types.ts` is a WT-3 task, with its consumer sweep; none is known today.

```ts
// WT-3 (work-board/workflow/shipped-shapes.ts): local aliases of shipped shapes; no new shape
type RunPin = TemplateVersionPin;                                              // { templateId: string; version: number; graphHash: string }
type LaneBlockCode = NonNullable<WorkItemStageRun["blocked"]>["code"];         // "envelope-missing" | "isolation-unproven" | "lane-unavailable"
type OutputExecution = NonNullable<WorkItemStageRun["outputExecutions"]>[number];
type JoinConflict = NonNullable<StageJoin["conflict"]>;
type OutputFile = NonNullable<RequestedOutput["files"]>[number];               // { path; sha256; size }
type StageGate = TemplateStage["gate"];

// shipped (shared/workflow-template-types.ts)
/** Who asked for the run. Both members shipped. WT-9 adds a member for a remote Create and run. */
type RunAuthoritySource =
  | { kind: "local-create-and-run"; pin: TemplateVersionPin; projectRoot?: string }   // IPC handler, after hasUserKeyboardIntent, from the tuple the user saw; projectRoot is the card's project (R21), absent when the card showed none
  | { kind: "schedule-attachment"; attachmentId: string; pin: TemplateVersionPin; firedAt: string };   // WT-8 fire handler, from the stored attachment

// WT-3 adds to shared/workflow-template-types.ts (types only; not shipped). One result for "may this version run unattended".
interface EnvelopeToolRef { stageId: string;         // the first failing entry: stages in graph order, then the collections in this order, then entry order
  collection: "tools" | "mcpReadOnlyTools" | "mcpGenerationTools" | "pluginGenerationTools"; name: string }
type UnattendedQualification =
  | { ok: true }
  | { ok: false; code: "unattended-not-read-only" }                                             // no tool to name. Before the lift: not all read-only (an envelope is not asked for). After it: a stage with no envelope
                                                                                                //   at attach the store throws it as the shipped "schedule-requires-read-only"; fire and spawn keep this code
  | { ok: false; code: "outward-effect-tool" | "tool-effect-unknown"; tool: EnvelopeToolRef };  // ruling P (§8); produced only by WT-15's function

// stage-run-engine.ts
type RunAuthorityVerdict =
  | { ok: true; source: RunAuthoritySource["kind"]; lane: RunLane }
  | { ok: false; code: "source-not-authorised" | "pin-mismatch" | "not-current-version" | "template-archived" | "version-missing"
      | "graph-mismatch" | "attachment-missing" | "attachment-detached" | "scope-changed" | "scope-not-authorised" | "project-mismatch" | "unattended-not-read-only" }
  | { ok: false; code: "outward-effect-tool" | "tool-effect-unknown"; tool: EnvelopeToolRef };   // the qualification's refusal, copied unchanged
type RunLane = "attended" | "unattended";            // decided by the source kind, never by whether a window is open
/** The ONE host function that says which sources may create a run's stage children. Called at start and before every spawn. */
type AuthoriseRunSource = (a: {
  source: RunAuthoritySource; runPin: RunPin;
  template: WorkflowTemplate | null;                  // currentVersion, archivedAt and the current scope; null when get() threw template-not-found
  stored: TemplateVersion | null;                     // resolveVersion(runPin); null when it threw unknown-version
  storedHashMatches: boolean;                         // false when resolveVersion threw graph-hash-mismatch
  attachment: ScheduleAttachment | null;              // getAttachment(attachmentId); a record with detachedAt set is refused attachment-detached
                                                      // its approvedScope (R21) must equal template.scope, else scope-changed; a record with no snapshot is scope-changed too, though none can be stored or loaded since 6942aca82
                                                      // the comparison is the shipped attachmentScopeMatches(attachment, template); the engine writes no second one
  runProjectRoot: string | undefined;                 // the project the run would use: the item's for Create and run, the snapshot's for a schedule
                                                      // Create and run: must equal the project root on the approved card (R21), else project-mismatch
  scopeAuthorised: (scope: TemplateScope) => boolean; // the project-access check the template handlers use (resolveAuthorizedWorkspaceProject); applied to the bound scope, never to template.scope; { kind: "all" } is always true
  unattendedAllowed: (v: TemplateVersion) => UnattendedQualification;   // WT-8: isAllReadOnlyVersion (a TemplateVersion is a TemplateGraph), false → unattended-not-read-only
                                                      // WT-16's limit-lifting commit swaps in WT-15's qualifyUnattended (§8, §9)
}) => RunAuthorityVerdict;

/** The shipped store, narrowed. Both methods throw WorkflowTemplateError; neither returns null. */
type TemplateReader = Pick<WorkflowTemplateStore, "get" | "resolveVersion">;
type AttachmentReader = Pick<WorkflowTemplateStore, "getAttachment" | "listByTemplate" | "listByRoutine">;

interface StageRunEngineDeps {
  store: WorkBoardStore;
  templates: TemplateReader;                        // WT-2, §13
  getRunner: () => SubAgentRunner | undefined;
  getAgentProfile?: (name: string) => Promise<LoadedAgentProfile | null>;
  emit: (e: Omit<WorkBoardRunEvent, "at">) => void;
  attachments: AttachmentReader;                    // WT-2, §13
  workspace: StageWorkspaceProvider;                // WT-3 default: unavailableWorkspaceProvider; WT-4 wires the real one
  authoriseRunSource: AuthoriseRunSource;           // run-authority.ts
  lane?: LaneHooks;                                 // WT-15/16/18; absent = an unattended stage is refused `lane-unavailable` unless all-read-only
  outputs?: RequestedOutputHooks;                   // WT-17; absent = a stage that declares requested outputs (§10) is refused `outputs-unavailable`
  runScope?: RunScopeHooks;                         // WT-5; absent = no-op
  passConditions: PassConditionRegistry;            // WT-7 registers one more kind
}
interface StageRunEngine {
  start(itemId: number, item: WorkItem, a: { source: RunAuthoritySource; approvalSurface: WebContents | null }): Promise<RunItemResult>;
  decideGate(itemId: number, i: StageGateDecideInput, o: { approvalSurface: WebContents | null }): Promise<StageGateDecideResult>;
  decideJoin(itemId: number, i: StageJoinDecideInput, o: { approvalSurface: WebContents | null }): Promise<StageJoinDecideResult>;
  retryStage(itemId: number, i: { runId: string; stageId: string }, o: { approvalSurface: WebContents | null }): Promise<StageRetryResult>;
  continueRun(itemId: number, i: { runId: string }, o: { approvalSurface: WebContents | null }): Promise<StageRetryResult>;   // §2.7
  projectRootRevoked(canonicalRoot: string): void;   // called beside the existing revocation fan-out (`ipc/domains/workspace.ts:497, 668`, `boot/steps/conversation-wiring.ts:255`); interrupts every live stage child of runs on that project and fails those stages `workspace-revoked` (F10)
  steer(itemId: number, stageId: string, text: string): WorkBoardSteerResult;
  stop(itemId: number): WorkBoardCancelResult;
  liveStageSessions(itemId: number): ReadonlyMap<string, string>;   // stageId → childSessionId
}
interface StageGateDecideInput { runId: string; stageId: string; attempt: number;
  resultHash: string;                               // binds the decision to the stage output
  outputHash?: string;                              // required when the stage run carries requested outputs; binds their approval (§10)
  decision: WorkPlanDecision; note?: string }
type StageGateRefusal = "not_found" | "not_pending" | "run_mismatch" | "run_end_unconfirmed" | "runs_not_adopted" | "attempt_mismatch" | "result_mismatch" | "output_mismatch" | "attempts_exhausted"
  | "note_required" | "note_too_long" | "note_invalid" | "version_missing" | "graph_mismatch";
interface RunScopeHooks { sessionLinked(runKey: string, sessionId: string): void; sessionEnded(sessionId: string): void; runEnded(runKey: string): void }
const runKeyOf = (itemId: number, runId: string) => `work-board:${itemId}#${runId}`;
interface LaneHooks {            // signatures fixed here so WT-15, WT-16 and WT-18 can build in parallel
  admit(a: { runKey: string; stageId: string; envelope: StageEnvelope | undefined; workspaceRoot: string }): Promise<{ ok: true } | { ok: false; code: LaneBlockCode }>;   // WT-16
  sessionLinked(a: { runKey: string; stageId: string; sessionId: string; envelope: StageEnvelope; workspaceRoot: string }): void;   // WT-15 registry
  sessionEnded(sessionId: string): void;
  onDenied(listener: (e: { sessionId: string; code: string }) => void): () => void;   // WT-15 emits, WT-18 counts
}
// LaneBlockCode: the derived alias above
// shipped (shared/workflow-template-output.ts): sha256 over canonical JSON of { output, requestedOutputs }. Used for the requested-output approval only (§10).
function outputHashOf(output: string, requestedOutputs: readonly RequestedOutput[]): string;

// stage-machine.ts
type RunEvent =
  | { type: "started" } | { type: "stage_linked"; stageId: string; childSessionId: string }
  | { type: "stage_ended"; stageId: string; attempt: number; ok: boolean; output?: string; taint?: StageTaint; reason?: string; interrupted?: boolean }
  | { type: "gate_evaluated"; stageId: string; attempt: number; passed: boolean; evidence: string; judgedBy: "host" | "model" }
  | { type: "gate_decided"; stageId: string; attempt: number; decision: WorkPlanDecision; note?: string }
  | { type: "retry_requested"; stageId: string } | { type: "continue_requested" } | { type: "stop_requested" }
  | { type: "join_integrated"; joinId: string } | { type: "join_conflict"; joinId: string; conflict: JoinConflict }
  | { type: "join_decided"; joinId: string; decision: "retry_merge" | "reject" };
type RunEffect =
  | { type: "spawn"; stageId: string; attempt: number } | { type: "evaluate_gate"; stageId: string; attempt: number }
  | { type: "interrupt"; stageId: string } | { type: "seal"; stageId: string } | { type: "integrate"; joinId: string; stageIds: string[] }
  | { type: "settle"; runStatus: "completed" | "denied" | "error" | "cancelled" } | { type: "release_workspace"; stageIds: string[] };

// stage-workspace.ts
interface RunWorkspace { kind: "git" | "folder"; runRoot: string; branch?: string; baseCommit?: string; outputDir?: string }   // shipped
interface StageWorkspace { root: string; kind: "git" | "folder"; baseCommit?: string }
interface StageWorkspaceProvider {
  open(run: RunRef, projectRoot: string | undefined): Promise<{ ok: true; workspace: RunWorkspace } | { ok: false; code: WorkspaceRefusal }>;   // once, at start
  prepare(run: RunRef, stage: TemplateStage, attempt: number): Promise<{ ok: true; workspace: StageWorkspace } | { ok: false; code: WorkspaceRefusal }>;
  seal(run: RunRef, stageId: string): Promise<{ ok: true; sealCommit?: string } | { ok: false; code: WorkspaceRefusal }>;   // after the stage passed
  integrate(run: RunRef, joinId: string, stageIds: readonly string[]): Promise<{ ok: true } | { ok: false; conflict: JoinConflict }>;
  release(run: RunRef, stageIds: readonly string[] | "all"): Promise<void>;       // stage folders only; the run branch and output folder stay
  discard(): Promise<void>;                                                       // runs with no record whose item is gone: everything, the output folder included
  sweep(activeRunIds: readonly string[]): Promise<void>;                          // boot
}
type WorkspaceRefusal = "workspace-unavailable" | "home-boundary-unverified" | "git-unavailable" | "inputs-need-project"
  | "seed-too-large" | "seed-unreadable" | "identity-missing";
```

The qualification result (rev7 review, approved by the lead). `unattendedAllowed` does not return a boolean, because a boolean cannot say which tool failed or why, and cannot tell the interim read-only refusal from the two effect refusals of ruling P. It returns `UnattendedQualification`, and one path carries that result everywhere:

- `authoriseRunSource` calls `unattendedAllowed(stored)` for a `schedule-attachment` source and copies a refusal into its verdict unchanged: the code, and for the two effect codes the tool. It adds no reading of its own.
- Start, and so fire: a refused `start` returns the verdict's code as `reasonCode` and, when the verdict has one, the tool as `reasonTool` on `RunItemResult`. The fire handler takes both from there (§7.2).
- Spawn: `spawnStageChild` throws `run-not-authorised` with the verdict, and the settle event and the audit entry carry the code and the tool (§2.4).
- Attach: the attach path asks the same function. For the two effect codes it returns the same code and tool. For `unattended-not-read-only` the store throws the shipped `schedule-requires-read-only`, as it does today: that is the one name mapping, it is made in `attachSchedule` only, and it adds no reading of the version (§7.2, §9).

No caller runs a second check of its own, and none reduces the result to a boolean. WT-3 lands the two types and the verdict members, so every lane builds against the final signature. Until the limit is lifted the only refusal the predicate can give is `unattended-not-read-only` (`schedule-requires-read-only` at attach). The two effect codes become reachable in WT-16's limit-lifting commit, which owns the coordinated change of the predicate and of every consumer, and its integration tests (§9).

Event handling: one promise chain per item. Each event does: read the item → check `runId` → reduce → one store write → run effects. A spawn effect is not awaited inside the chain; the child's end enqueues `stage_ended`. `inFlight` still holds the item from `start` to settle, so a second `runItem` is refused as today. The `spawn` effect calls `prepare` first; `seal` is emitted when a stage becomes `passed`. WT-3 lands both against the provider interface, so WT-4 does not edit `stage-machine.ts`. `integrate` runs after every step, one-stage steps included, because the next step's workspaces start from the collected result.

### 2.3 State machine

| Stage status | Event | Next | Notes |
| --- | --- | --- | --- |
| `waiting` | all `inputs` and incoming edges `passed` and integrated; a slot is free | `running` (attempt 1) | Slot cap: `MAX_PARALLEL_STAGES = 3`. `prepare` runs first; a refusal fails the stage before any spawn. |
| `running` | child `ok`, human gate | `awaiting_gate` (`gate.pending`, `output`, `resultHash`) | One store write, as `setPlanAwaitingApproval` does. |
| `running` | child `ok`, automatic gate passes / fails | `passed` / `failed` | Evidence stored. Unevaluable = fails. |
| `running` | child `ok:false` (not a requested stop) | `failed` | Siblings keep running; downstream stays `waiting`. |
| `running` | interrupted after `stop_requested` | `cancelled` | |
| `awaiting_gate` | approve / reject | `passed` / `rejected` | Reject settles the run `denied` once live siblings are interrupted and unwound. |
| `awaiting_gate` | request changes (note required) | `running`, attempt + 1 | Refused `attempts_exhausted` at attempt 3. Note and prior output go in as fenced data. |
| `failed` | `retry_requested` | `running`, attempt + 1 | Same inputs; refused at attempt 3. No automatic retry. |
| `waiting`, ready, run idle after a restart | `continue_requested` | `running`, attempt unchanged | Only legal when no child of the run is live (§2.7). |
| any non-terminal | `stop_requested` | `cancelled` | Pending gates become `cancelled`. |

Run (item `runStatus`, no new value):

| Condition | `runStatus` |
| --- | --- |
| The run is not settled: a child is live, a gate or join waits, or a stage is `failed` or blocked and waits for Retry / Stop | `executing` |
| (never for a template run) | `awaiting_approval` keeps meaning a pending `planApproval`. The item sits in Needs review when `isAwaitingStageReview(item)` is true. |
| Last stage `passed` | `completed` (`output` = last stage output; shipped result review follows) |
| A gate or join rejected | `denied` |
| Stop | `cancelled` |
| A spawn was refused because the run's source is no longer authorised (§2.4), and no child is live any more | `cancelled` |
| Version or hash missing, store or wiring fault | `error` |

### 2.4 D1 authority and pinning

Two sources can start a run. Both bind to an exact `(templateId, version, graphHash)`; they differ in which version they may name.

| Source | Built by | Version rule | Lane |
| --- | --- | --- | --- |
| `local-create-and-run` | The `ave:work-board:run` handler, only after a consumed keyboard gesture, from the tuple the user saw | At start, the tuple must be the template's **current** confirmed version; an older one refuses (`not-current-version`). This is a start-time rule only: a run that has started keeps its pinned version, and its later stages spawn from it after a newer version is confirmed. The run's project is the authorised project-registry root of the project the card showed; a card root the registry does not hold refuses `scope-not-authorised`, and a registry root or a board row that differs from it refuses `project-mismatch`. The board row's project is compared, never used. | attended |
| `schedule-attachment` | WT-8's fire handler, from the stored attachment record; never from a tool call or a renderer payload | The tuple must equal the attachment's. The template's current version is not consulted, so confirming v2 does not move the schedule to v2. A v2 that changes the template's scope does not move it either: it refuses the schedule (`scope-changed`). A detached or missing attachment refuses. The template's current scope must equal the scope the attachment was approved for (`scope-changed`). `unattendedAllowed(stored)` must return `ok`; its refusal becomes the verdict, with the tool it names (§2.2). | unattended |

For both sources an archived template refuses `template-archived`, at start and at every spawn. In both cases the stored version must exist and its stored hash must equal the tuple's hash and the hash recomputed now (`version-missing`, `graph-mismatch`). The shipped store does this in one call: `resolveVersion(pin)` throws `template-not-found` or `unknown-version` (mapped to `version-missing`) and `graph-hash-mismatch` (mapped to `graph-mismatch`), and every store read recomputes `graphHashOf(version)` for every stored version, so a file whose bytes no longer match its hash fails to load. A store error with any other code settles the run `error`. `get(id)` supplies `currentVersion` and `archivedAt`; a template with `archivedAt` set is archived. A refusal writes nothing. On `ok`, `start()` calls `beginRun(id, runId, startedAt, { ...pin, source, stageRuns })` (the shipped `TemplateRunStart`), which stores the tuple as the run pin and the whole source object as `runStartedBy`. `Run again` is a new `Create and run` with a new tuple.

Scope is not part of the pin. It lives on `WorkflowTemplate`, outside `graphHash`, and `confirmDraft` replaces it with the draft's scope, so a version pin says nothing about which project a run may read. Lead ruling R21 closes this with the simplest rule that fails closed:

- At attach, the attachment stores the scope it was approved for (OD-1): `{ kind: "all" }`, or `{ kind: "project", projectRoot }`. Lead ruling N8: `projectRoot` is the authorised project-registry root, canonicalised when the project was authorised. It is not a filesystem real path, and nothing resolves links for it. This shipped at `51d5d582f` as `ScheduleAttachment.approvedScope`: the attach handler authorises the project, replaces whatever alias the renderer sent with the registry root, and hands that scope to `attachSchedule`, which refuses `scope-changed` when it differs from the template's scope at that moment and stores a copy (§13.1).
- A scheduled run takes its project only from that snapshot, never from the live `WorkflowTemplate.scope` (§7.2).
- At fire and before every spawn, the template's current scope must equal the snapshot (same kind, and for a project exactly the same root string: a trailing slash, another letter case or a dot segment is a different root). Otherwise the verdict is `scope-changed`, in both directions: project A to project B, `all` to a project, a project to `all`. Since `6942aca82` `approvedScope` is required (N2): a record with no snapshot cannot be written, and a template file that holds one is refused `invalid-template-file` when it loads. The matcher still answers `scope-changed` for one, as the second line. The comparison is the shipped `attachmentScopeMatches(attachment, template)` (`work-board/template-graph.ts`), which returns `{ ok: false, code: "scope-changed" }` for each of these cases; WT-3 calls it inside `authoriseRunSource` and WT-8 calls it at fire. Nothing repairs it silently. The schedule list shows "needs reattach", and only a new attach approval, which makes a new attachment, starts runs again.
- The `Create and run` approval binds the project root with `(templateId, version, graphHash)`. The card shows the project; the source carries that root (or none), and the run's project must equal it, else `project-mismatch`. A run cannot start on a project other than the one on the card. This shipped at `51d5d582f`: the `local-create-and-run` source carries `projectRoot?`, and `beginRun` throws `project-mismatch` before it writes when the source's root differs from the item's project. WT-3's run handler must put the approved card's project root into `source.projectRoot`; no shipped code mints it. `authoriseRunSource` makes the same comparison, so a refused start is reported before `beginRun` and the store check stays as the second line.
- Scope access is revalidated at start and before every spawn, for both sources: `scopeAuthorised` must hold for the scope the approval bound, else `scope-not-authorised`. That is the project root on the card for `Create and run` and the snapshot for a schedule. The live `WorkflowTemplate.scope` is never the authority; it is only compared with the snapshot.

The function is called again before every spawn with the stored source, so a run whose source it no longer accepts spawns nothing. This covers a detached or missing attachment, a changed or no longer authorised scope, and a qualification that no longer passes. The last includes an envelope tool whose effect evidence is outward or unknown at that moment, a temporarily offline server included (ruling P as ruled in Q6, §8): the run settles `cancelled` with `outward-effect-tool` or `tool-effect-unknown`. The outcome is the same for every such refusal:

| Part of the run | What happens |
| --- | --- |
| A child that is already live | Not interrupted. It runs to its end and its output is stored. Until a spawn has been refused its stage is handled as usual (gate, seal); after that, see the gate row. Only Stop interrupts it. |
| The stage whose spawn was refused, and every later one | Never spawned. The spawn throws `run-not-authorised` with the verdict's code. |
| Human gates | Decidable only until the first refused spawn. At that moment every pending gate becomes `cancelled`, and a decision sent later is refused `not_pending`. A live child that ends afterwards opens no gate: its output is stored and its stage becomes `cancelled`. |
| The run | From the first refused spawn it starts nothing more and accepts no gate or join decision. When no child is live it settles `cancelled`: every stage that is not terminal becomes `cancelled`, as for Stop. If no child is live at the refusal, it settles at once. Finished outputs and the run branch or output folder stay. |
| The record | The verdict's code goes out on the settle event and in the audit log. For `outward-effect-tool` and `tool-effect-unknown` the verdict's tool (stage, collection, name) goes with it. No stored enum gains a value. |

The run does not park. Authority cannot come back to it: a new approval makes a new attachment with a new `id` (§7.2), and the run's stored source names the old one. The check is on the spawn path only, so a run that waits at a gate with no spawn due notices nothing until a decision would spawn: approving a gate that has a later stage leads to the refused spawn and the run settles `cancelled`; approving the gate of the last stage completes the run, because no spawn is needed. While such a run waits it is unsettled, so its schedule fires nothing, a new attachment on the same routine included, until someone decides the gate or stops the run (§7.2).

`project-mismatch` and `scope-not-authorised` are confirmed by the lead. A refused start returns the verdict's code as its `reasonCode`, and the settle event of a run that a later spawn refusal ended carries the same field. Each of the two, and `scope-changed`, is a `WorkflowTemplateErrorCode` at `51d5d582f` and has its en and ko message there as `reasonCodes.<code>` in `src/i18n/messages/en.ts` and `ko.ts`. WT-3 adds no strings for them. It owns the engine verdicts that return them and a test that reaches each from the engine (§2.9). `output-not-declared` has its strings too; emitting it is WT-17's (§10).

The lane is a property of the stored source. A scheduled run stays unattended for its whole life, whoever is at the desk; an attended run never enters the lane.

`spawnStageChild(run, stageId, attempt)` is the only `runner.spawn` call for a template run. It throws `WorkflowInvariantError` unless all hold:

| Code | Check |
| --- | --- |
| `run-not-authorised` | `authoriseRunSource` returns `ok` for the run's stored source and pin, the scope checks included. Nothing in a renderer or model payload can carry a source. |
| `workspace-missing` | `prepare` returned this stage's workspace and it lies under the run's `runRoot`. |
| `lane-blocked` | For an unattended run: `lane.admit` returned `ok` for this stage, or the version is all-read-only (WT-8 interim). |
| `version-missing` | `templates.resolveVersion({ templateId, version: runTemplateVersion, graphHash: runTemplateGraphHash })` does not throw `template-not-found` or `unknown-version`. |
| `graph-mismatch` | It does not throw `graph-hash-mismatch`: the stored `graphHash` equals `runTemplateGraphHash`, and the store read recomputed `graphHashOf(version)` (whole graph, template `setupCommands` included). |
| `stage-not-in-version` | `stageId` is a stage of that version. |
| `stage-not-ready` | The reducer emitted this spawn for this attempt. |
| `attempt-out-of-range` | `1 ≤ attempt ≤ 3`. |
| `run-stopped` | No stop is pending. |

Checked at start and again at every spawn, so confirming v2 or archiving the template never moves a run to another graph or another project, and a missing version fails the run instead of running another graph. One case ends a run instead of leaving it alone: a v2 that changes the template's scope refuses every later spawn of a scheduled run (`scope-changed`), and that run settles `cancelled` as above. The child is spawned with `projectRoot` = its stage workspace, `originSessionId = work-board:<id>`, the host-minted `unattendedStage: { runKey, stageId }` for an unattended run (a new host-only spawn input, like `hostInputTaint`), `toolScope` = `exactToolScope(read-tier names)` or `PARENT_ALL_TOOL_SCOPE`, the model of the stage's profile (`TemplateStage.agentName`, when set), and the 20-round budget for read stages. Nothing here touches permission evaluation: each tool call enters `CHILD → H` as today.

### 2.5 Input passing (D7)

```ts
type StageTaint = "file-content";
interface StageInput { stageId: string; name: string; output: string; gate: "human" | "auto" | "model"; taint?: StageTaint }
function buildStagePrompt(a: { item: WorkItem; stage: TemplateStage; inputs: StageInput[]; revision?: { priorOutput: string; note: string } }):
  { instructions: string; taint?: StageTaint; truncated: string[] };
const STAGE_INPUT_MAX_CHARS = 16_000; const STAGE_INPUTS_TOTAL_MAX_CHARS = 48_000;
```

- The instruction part is host text plus `stage.goal` and the item title and detail. Each input is one host fence (`formatStageInputDirective`, new tag `ave-stage-input`) labelled with the stage name and how it passed; the body goes through `neutralizeFenceClose`.
- Runner: `SubAgentSpawnInput.hostInputTaint?: "file-content"` sets the first turn's `inputOrigin` (replaces the constant at `:3011` for this case only); `SubAgentSpawnResult.endTrustOrigin` reports the child's last `toolTrustOrigin`. The engine stores `taint` on the stage run when it is `file-content` or `agent-message`.
- A stage is tainted from its first call when any selected input is tainted. That activates only what a child already gets after its first successful file read (`trust-origin.ts:66-80`, `query-loop.ts:362-366`). No new floor. See Q4.
- Setup commands (§3.4) are added as host text only when `stage.toolScope` is `"all"`. A read-scope stage's instructions never contain them or mention them.
- A stage never receives a sibling's transcript, and no output is written into a template.

### 2.6 Gates, retry, Stop

- Human gate: the host computes `resultHash` over the stored stage output when the stage enters `awaiting_gate` and stores it on the stage run. Lead ruling R16: `resultHash` is the sha256 of the stored stage output, as `planHashOf` is for a plan. The field `resultHash` and its board validation (a 64-character hex hash) shipped with WT-2. The helper shipped at `6942aca82` (N3): `resultHashOf(output: string): string` in `src/shared/workflow-template-output.ts`, sha256 over the UTF-8 bytes of the exact stored output, hex. WT-3 imports it and writes no second one. Calling it when the stage enters `awaiting_gate` is still WT-3's; no shipped code does. `decideStageGate` checks, inside the board lock, run, stage, attempt, pending status, stored `resultHash` = recomputed = sent (`result_mismatch`), then the pin (§2.4). When the stage run carries requested outputs, the same decision must also carry `outputHash` = `outputHashOf(output, requestedOutputs)` recomputed now (`output_mismatch`), so the gate also binds the requested outputs it shows (§10). A mismatch on either hash refuses the decision and changes nothing. With none, `outputHash` is not sent and not checked. The IPC handler is a copy of decide-plan's (`ipc/domains/work-board.ts:316`): validated sender, consumed keyboard intent, owner frame, note bound and redaction, audit event `work-approval:stage-decided` with origin `local-desktop`.
- Automatic gate: `PassConditionRegistry.evaluate(kind, facts)` where `facts = { result: SubAgentSpawnResult, stage }`. `stage_ok` = `result.ok && !result.incomplete`. `check_exit_zero` is refused when the template is written (`gate-check-unsupported`, with en/ko text): the host runs no command and a child's recorded steps carry no exit status (Q8), so such a gate could never pass. No evaluator is registered for it.
- A stage whose child ends `ok:false` never reaches its gate.
- Stop: mark, interrupt every live child (`interruptRun`), cancel pending gates, settle `cancelled` when the last child has unwound; with no live child it settles at once (this is how a run parked across a restart is stopped). Finished outputs stay. Stop does not need the graph: when the pinned version can no longer be read, the children are interrupted from the host's own record of them and the run still ends `cancelled`. Deleting the run's board row, by any path, is the same Stop; from then on the run file is written by run id.
- A run whose pin stops resolving, or whose run file cannot be written, ends `error` the same way: every live child is interrupted, and the run is over when the last one has unwound.
- Ending a run is one write of the run file: the final stage states and `settled: { status, at }` together. The board row is written after it and only shows it.
- Steer: `steerRun(itemId, text, stageId)`; the host resolves the child from `liveStageSessions`. Refuses `not-executing` for a stage with no live child.

### 2.7 Restart reconcile

The board's own `reconcileInterruptedRuns` fails every ordinary row it finds running and leaves a row that names a template run as it is. The scheduler's boot step (`adoptParkedRuns`, once, and awaited by every start and decision) then walks the rows that name a template run and reads each run from the run file, which is the truth. A run with `settled` is shown on its row as the record says (this repairs a crash between the two settle writes). An unsettled run is parked as below, its row is set back to `executing`, and the scheduler takes it over so that Stop reaches it. Until that has happened a board reader is told `templateRunState: "resuming"` and `runStatus: "executing"` for the row (never `error`), and a start is refused `already_running`. The host adds `templateRunState` (`running`, `awaiting_review`, `resuming`) on every list and get; a value a row carries is dropped. A stored run that no row names any more (the row was deleted while the app was down, or it names another run) is settled `cancelled` by its run id alone and goes with the settled-run prune; a run whose row is deleted while it is live is settled the same way and its row is never written. While the run file awaits review the boot step settles, sweeps and takes over nothing, and the next caller or reader that sees a `resuming` row tries it again.

| Stored | After boot |
| --- | --- |
| stage `running` | `failed`, `failure: "interrupted"` (attempt kept; Retry uses the next) |
| stage `awaiting_gate` with `output` and matching `resultHash` | kept |
| stage `awaiting_gate`, hash or output missing | `failed`, `failure: "interrupted"` |
| join `integrating` | `conflict` with `reason: "interrupted"` (decidable: retry merge / reject) |
| stage `waiting` whose inputs all passed | kept `waiting`; nothing starts at boot |
| item | stays `executing`; the Review lane is derived (`isAwaitingStageReview`); never `error` unless the pin is unreadable |
| stage workspace folder missing for a kept stage | the stage is `failed`, `failure: "workspace-lost"` |

Nothing spawns at boot. The run continues only on a user decision (gate, join, Retry) or Stop; each of those re-reads the store and starts whatever is ready. A run with only ready-but-unstarted stages is continued by `continueRun(itemId, { runId }, { approvalSurface })`, a separate user action that enqueues `continue_requested`; it is not a retry and does not consume an attempt. Its channel ships with its first renderer caller, which is not in this change. See Q6.

### 2.8 Invariants (each throws or refuses with the named code)

1. No spawn outside `spawnStageChild`; every §2.4 code.
2. At most one live child per `(run, stageId)`; `duplicate-stage-child`.
3. A decision that does not match run + stage + attempt + `resultHash` (and `outputHash` when the stage run has requested outputs) is refused and changes nothing.
4. An event whose `runId` is not the item's current run is dropped and logged; it never writes.
5. Total fenced input above the bound is truncated with a host marker, never passed whole; an input that still contains a fence close after sanitising throws.
6. A template run never writes `planApproval`; the shipped run never writes `stageRuns`.
7. `attempt` never exceeds 3.

### 2.9 Tests (red without the change, green with it)

| File | Test | Proves |
| --- | --- | --- |
| `work-board/workflow/__tests__/stage-machine.test.ts` | `starts every ready stage of a step together up to the cap` | parallel children |
| | `a failed stage keeps its siblings running and the join closed` | failure rule |
| | `request changes reruns the same stage with attempt + 1 and refuses a fourth` | retry ≤ 3 |
| | `reject settles the run denied and starts nothing later` | reject |
| | `stop cancels pending gates and settles cancelled after the last child unwinds` | Stop |
| `…/stage-graph.test.ts` | `refuses a version whose recomputed hash differs from the pin` | pinning |
| `…/stage-prompt.test.ts` | `passes an input only inside the host fence and neutralises a fence close` | D7 fence |
| | `unions input taint into the stage's first-turn origin` | D7 taint |
| | `bounds each input and the total` | size |
| | `an all-tools stage is told the setup commands in order and a read-scope stage's instructions do not contain them` | R17 |
| | `in a template with a read-scope plan stage and an all-tools stage, only the all-tools stage's instructions contain the setup commands` | C3 |
| `core/__tests__/work-board-stage-run.test.ts` | `spawns only the pinned version's stages with the stage's tool scope` | D1 |
| | `a run whose template gained v2 with the same scope mid-run still spawns v1 stages` | pinning |
| | `refuses to start when the pinned version is missing` | version skew |
| | `refuses to start when the Create and run tuple differs from the stored version or hash` | start binding |
| | `refuses Create and run for a version that is not current, and for an archived template` | current version only, at start |
| | `a schedule source starts its attachment pin while a newer version is current` | OD-1 pin |
| | `a schedule source with a detached attachment, or a version that is not all read-only, starts nothing` | OD-1, interim limit |
| | `a v1 schedule approved for project A is refused scope-changed after v2 moves the template to project B, and nothing is seeded from or read in B` | R21 |
| | `a schedule approved for scope all is refused scope-changed after the template gains a project scope` | R21 |
| | `a schedule whose snapshot matches the template's scope fires and runs on the snapshot's project` | R21 |
| | `Create and run on a project other than the one on the card is refused project-mismatch` | R21 |
| | `a run whose project is no longer an authorised workspace project is refused scope-not-authorised at start and at the next spawn` | scope access recheck |
| | `detaching between two stages lets the live stage child finish, refuses the next spawn attachment-detached and settles the run cancelled` | detach outcome |
| | `a replacement attach has the same effect on a run of the earlier attachment` | detach outcome |
| | `a run parked at its last stage's gate completes on approve after a detach; one with a later stage settles cancelled`, `after a refused spawn a sibling's pending gate is cancelled and its decision is refused not_pending`, `a child that ends after a refused spawn opens no gate` | detach outcome |
| | `a template run with a waiting gate keeps runStatus executing and isAwaitingStageReview is true` | Review lane derivation |
| | `two stages of one step are live at the same time with different project roots` | parallel in every project kind |
| `core/__tests__/work-board-stage-revoke.test.ts` | `removing the project interrupts every live stage child of its runs and fails those stages` (red today: F10) | Q13 |
| | `a run whose stored source the authority function refuses spawns nothing` | the check is on the spawn path |
| | `a stage whose tool ask has no approval surface fails and its gate never opens` | no-surface behaviour |
| `work-board/workflow/__tests__/run-authority.test.ts` | one table over both source kinds and every refusal code; `an unknown source kind is refused` | single authority function |
| | `a refusal of unattendedAllowed reaches the verdict, the refused start and the settle event with its code unchanged, and with its tool for outward-effect-tool and tool-effect-unknown` (a fake predicate; the real one arrives in §9) | qualification result |
| | `a start refused project-mismatch or scope-not-authorised returns that reasonCode, and each has an en and a ko message` | confirmed codes |
| | `accepts a gate decision while a sibling stage is running` | F6 |
| | `refuses a gate decision with another attempt or result hash` | binding |
| | `steer reaches the named stage's child only` | steer |
| `main/__tests__/work-board-stage-reconcile.test.ts` | `keeps a pending stage gate across restart and fails running stages as interrupted` | F5 |
| `engine/__tests__/subagent-runner.test.ts` (added cases) | `hostInputTaint sets the child's first-turn origin`, `reports endTrustOrigin` | F4 |
| `ipc/domains/__tests__/work-board-stage-decide.test.ts` | `refuses without a keyboard gesture or from a non-owner frame` | work-approval boundary |
| `core/__tests__/work-board-run-flow.test.ts` (existing) | unchanged and green | shipped flow untouched |

Commit: `feat(work-board): stage scheduler for template runs`.

## 3. WT-4 — per-stage workspaces and join collection (W1, W2)

Files: new `src/work-board/workflow/stage-workspaces.ts` (the provider), `workspace-layout.ts` (paths and slugs, pure), `workspace-seed.ts` (bounded no-follow copy), `folder-ignore.ts` (a plain folder's ignore matcher), `host-git.ts` (hardened git calls); new `src/permissions/stage-workspace-binding.ts`; changed `permissions/ave-home-read-boundary.ts`, `permissions/asrt-sandbox.ts`, the consumers of the protected-control path fact (see §3.5; `protectedControlEntryFor` itself is not changed), `shared/ave-home.ts` if the new child must be listed (R2); one line in `workflow-engine-extensions.ts`; en/ko for the conflict gate. The join state machine, `decideStageJoin`, the provider call sites and the boot sweep call already exist from WT-3; the `workspace` and `stageJoins` fields and their board-file validation shipped with WT-2 (`work-board/template-run-fields.ts`).

### 3.1 Layout

```
<aveHome>/worktrees/<project>/<run>/<stage>/     one per stage; the stage child's project root, read and write
<aveHome>/worktrees/<project>/<run>/_join/       git only: the host's integration worktree, branch ave/workflow/<run>
<aveHome>/worktrees/<project>/<run>/_out/        folder kind only: the run output folder
<aveHome>/worktrees/<project>/<run>/_run.json    the provider's record of the run folder
<aveHome>/worktrees/<project>/<run>/_ignore-<random>/   plain folder only, while one stage folder is seeded: an empty repository for the ignore matcher (§3.3)
```

`_run.json` is how the provider finds a run's folder again and repeats a step without redoing it. It holds the run id and item id, the kind, the project root, whether the project lies in a git work tree whose ignore rules apply to seeding, for git the run branch and base commit and a merge in progress, and per stage its attempt, whether its folder is ready, what was seeded into it and its seal (the seal commit, or the manifest of sealed files), plus the joins already collected and which stage put each file into `_out`. It holds no file content and no secret. `open` writes it, by write-then-rename with mode 0600; `prepare`, `seal` and `integrate` rewrite it; after a restart `locate` finds the run by its slug and accepts the folder only if the record names the same run id. A record counts only when it is a regular file with one name (no link, no second hard link) that holds every field: version, run id, integer item id, kind, the string fields as strings, for git the project root, branch and base commit, and `stages`, `joins` and `out` as objects with every stage key a stage id; anything else is no record, so the folder is neither used nor cleaned. A record also counts only in its own place: its folder must be the one `open` makes for the run id, item id and project root it names, and a git record must name the run's own branch `ave/workflow/<run>` and an object id as its base commit. A record copied or restored into another folder, or one that names another repository or branch, is therefore no record, and git cleanup addresses only the run's own ref name. Every call holds the run folder together with the device and file ids of four levels (the home, `worktrees`, the project folder, the run folder), each of which must be a real directory, no link and no junction; every removal, every creation (a stage folder, a worktree, the matcher's folder, a collected file) and every record write checks them again immediately before and refuses once a level is no longer the directory it was. The check and the operation are still two system calls on a path. Another process of the same user that swaps a level between them is not defended against: by the owner's decision of 2026-11-21 on cleanup, a swap during the operation is out of scope, since whoever can win it already acts as the same user. No native helper holds the directories open. Only the host reads or writes it: the name starts with `_`, so it is no stage folder, no binding covers it, and it stays behind the protected-path floor and the sandbox read boundary for every session. It is removed by `release(run, "all")` once the run's folders are gone, except for a folder run whose `_out` remains: there it stays beside `_out`, as its index, and goes when `_out` goes.

`_out` lives as long as the item. It is not removed when the run settles, nor when a delete of the item stores its intent: it is removed by `discard()`, which removes what is left of every run that has no record in the run store and whose item is no longer on the board. Both are read at that moment: the run store must hold no entry that could be the run, and the board on disk must be readable and hold no row with the item's id; anything else removes nothing. Retention also drops the record of a superseded run while its item is still listed, once the row's history no longer holds it; that run's `_out` stays, and goes with the item (R6). `discard` runs after each run-store write that removed a settled run's record (`WorkflowRunStore.onRunsRemoved`), which is the write that follows the item's deletion once its run is over, and after each committed removal of a row (`WorkBoardStore.onItemRemoved`, from `remove` and `removeUnreadable`), since a row whose runs have no record left goes without any such write; both are wired in `boot/steps/workflow-engine-extensions.ts`. A start that is refused after its workspace was opened asks once more after its release (`abandonStart`): its row may have been deleted while the workspace was being opened, before there was a folder for that removal's discard to find. The stores are read twice. A first read, before the run folders are listed, only selects candidates. For each candidate the stores are read again inside that run's queue, after its folder was listed, and only that read lets the output go; the folder and its record are then re-read (same directories, same run, item, kind and project) before anything is removed. An item's row is on the board before a start of it opens the workspace, and the start opens the workspace before it stores the run's record, so a read begun after the folder was listed always shows the row, and a starting run keeps its workspace whatever an earlier read said. `discard` removes the stage folders, `_join`, `_out`, `_run.json` and the then-empty run and project folders; a git run's branch `ave/workflow/<run>` stays, as the user's result. A stop between the record's removal and `discard` leaves `_out` and `_run.json` behind. The boot sweep removes them under the same test, read the same two times: for each run folder that no active run owns it releases the stage folders, and it drops `_out` and `_run.json` too only when the run has no record and its item is gone; every other run keeps them. From a run that is still active (a parked run) it removes only the `_ignore-*` folders a stop during a seeding left, and `_ignore`, the one name an earlier build used, inside that run's queue and under the same checks; its stages and output stay. Removal stays inside the run root and removes a link, never what it points to. The boot sweep leaves a run folder that has no valid `_run.json` alone, and one whose run or project folder is a link.

```ts
function projectSlug(projectRoot: string | undefined, itemId: number): string;   // "<name≤24, [a-z0-9-]>-<8 hex of sha256(canonical root)>", or "board-<itemId>" with no project
function runSlug(runId: string): string;                                          // 12 chars, [a-z0-9]
function stageDirName(stageId: string): string;                                   // the stage id; WT-2 bounds it to ^[a-z0-9][a-z0-9-]{0,31}$
```

No raw path, user name or title enters a segment. `_join`, `_out`, `_ignore-<random>` and `_run.json` cannot be stage ids. `Request changes` reruns in the same stage folder; `Retry` of a failed stage removes it and prepares again.

### 3.2 Git kind

Chosen by `open` when the project root is the top level of a git work tree with a commit at `HEAD`.

| Step | Behaviour |
| --- | --- |
| `open` | Record `baseCommit` = the user's `HEAD` commit. Create the branch `ave/workflow/<run>` at it and add `_join` as a worktree on that branch. Nothing is checked out, staged or changed in the user's folder. Uncommitted changes of the user are not part of the run (R4). |
| `prepare` | `git worktree add --detach <stage dir> <head of ave/workflow/<run>>`. Then remove from the stage folder every file the existing sensitive-path test names (`permissions/sensitive-paths.ts:755`), so a tracked secret file is not handed to a stage (R3). Ignored files are never present: a worktree holds tracked files only. |
| `seal` | Host commit of the whole stage folder on its detached `HEAD` (the removed secret paths excluded from the commit). Author and committer are the user's `user.name` / `user.email` as git resolves them for that repository; with none, `identity-missing` and nothing is committed. Trailers `Ave-Run: <runId>` and `Ave-Stage: <stageId>`. An empty diff is a no-op. |
| `integrate` | In `_join`, merge each sealed commit into `ave/workflow/<run>` in stage order. On any failure: `git merge --abort`, return `conflict`; later stages stay `waiting`. |
| Conflict gate | A join gate: a work approval bound to run + join + `conflictHash`. The user resolves in `_join` (the board opens the folder) and decides `retry_merge`, or `reject`, which settles the run `denied`. The host never resolves and never force-merges. |
| `release` | The host removes the stage folders itself, after the check of §3.1, then `_join` at settle; git is never asked to remove a folder, because a path handed to another process could be another folder by the time it is opened. Git then only forgets the registrations: `git worktree list --porcelain -z` names the worktrees whose folders are missing, and `git worktree prune` runs when every one of them lies in this run's folder. If the repository has another missing worktree (one of the user's on an unmounted volume, say), nothing is pruned and the run's registrations stay for a later prune. `open` refuses when `ave/workflow/<run>` is already there, and a refused `open` takes back only the branch it asked git to make, with `update-ref -d <ref> <baseCommit>`, so a branch that was there before or has moved since stays. The branch `ave/workflow/<run>` stays as the result; it is deleted only when it still equals `baseCommit` (R6). |

The user's repository does change in one place: its `.git` gains worktree metadata, objects and the branch ref. The checked-out branch, the index and the working files are never written.

`host-git.ts`: `execFile("git", buildHostGitArgs([...]))`, no shell, timeouts, bounded output, and it honours `isHostGitWorkspaceAvailable` (`shared/host-git.ts:31`). A call that timed out, wrote past the bound or ended without an exit code (ended from outside) rejects (`timeout`, `output-limit`, `terminated`); it is never read as an exit status. A call past its deadline or bound stops the whole process tree through the host's bounded tree kill (`forceKillManagedChildProcess`), and a process that was stopped or has exited gets five seconds to close its pipes; after that the pipes are destroyed and the call rejects (`terminated` when the process had exited by itself), so a process that never reports its end cannot hold a run's queue. A call may be made `isolated`: every inherited `GIT_*` variable is removed, `GIT_CONFIG_NOSYSTEM=1` and `GIT_CONFIG_GLOBAL=<null device>` are set, so it reads no configuration but the repository's own and its own `-c` entries. Only the plain folder's matcher (§3.3) is isolated; every call in a real repository keeps the user's configuration, as before. On top of `HOST_GIT_CONFIG` (F8) every call adds: no credential helper and no terminal prompt, no commit or tag signing, no textconv and no external diff, and filter drivers disabled for `add`, `commit`, `merge` and `worktree add`. If a repository requires a filter driver to check out, `open` refuses `git-unavailable` instead of running it. One call is an exception to "no credential helper": the push of a `host:git` requested output (WT-17, lead ruling R22) uses the credentials the user configured, inside the bounds of §10. It keeps every other hardening in this paragraph, and no other call in this module may reach a credential.

### 3.3 Folder kind

Chosen by `open` for every other case, a run with no project included.

| Step | Behaviour |
| --- | --- |
| `open` | Create `_out`. A stage that declares `{ from: "project" }` inputs in a run with no project refuses `inputs-need-project`. |
| `prepare` | Create the stage folder and seed it with the stage's declared inputs only: `{ from: "project"; paths }` from the project folder, `{ from: "stage"; stageId }` from that stage's collected files in `_out`. |
| `seal` | Record the manifest (relative path, size, sha256) of the files matching the stage's `outputs` globs (default `**`). |
| `integrate` | Copy each sealed stage's manifest files into `_out` at the same relative paths. The same path from two stages with different content is a `conflict`; nothing is copied for that join. |
| `release` | Remove stage folders. `_out` and `_run.json` stay. |
| `discard` | Remove everything under the run folder, `_out` and `_run.json` included, of each run that has no record and whose item is gone (§3.1, R6). A run whose item is still listed keeps `_out`. |

Seeding and collection (`workspace-seed.ts`) share one copier: it never follows a symbolic link, junction or other reparse point (the entry is skipped and listed); it skips every path the sensitive-path test names and, every path the project's ignore rules name. In a git work tree those are the work tree's rules (`git check-ignore`). A plain folder outside any git work tree honours its own `.gitignore` files, read by the same matcher (`folder-ignore.ts`): `check-ignore` runs only against a repository, so on first need the host makes an empty one in a folder of its own, `<run>/_ignore-<random>` (`mkdtemp`, then `git init --template=`), runs `git --git-dir=<run>/_ignore-<random>/.git --work-tree=<project> check-ignore --no-index -z --stdin` over the listed paths, and removes the folder when that stage's seeding ends, whether it succeeded or git failed; a removal that fails is logged and the next boot sweep takes the folder (§3.1). Each seeding has its own folder, so parallel stages and runs never share one. Both calls go through `host-git.ts` isolated (§3.2): no inherited `GIT_*` variable, no system and no user configuration file. The matcher adds `-c core.excludesFile=` so only the folder's own files are rules (the user's excludes file and the default one under the configuration home do not apply), and `-c core.ignoreCase=` set to the file-name rule of the project folder itself, so the answer is the same whatever configuration the host process inherited or the new repository recorded. Git finds that rule for a repository by writing into it; the host writes nothing into the project, so it asks for the folder's outermost `.gitignore` under its name in the other case (`namesFoldCase`): the same file answers where names fold, nothing where they do not, and two listed names that differ by case alone mean they do not. A folder that gives neither answer is not seeded (`seed-unreadable`); the host floor already carries `core.fsmonitor=false` and a hooks path where no hook can be found (the null device), and `--template=` copies no hook or exclude file. Paths go in and come out NUL-separated, so a name with a line break is one path. Nothing is written into the project, and the project's content is only data to these calls: `.gitignore` files are read as rules, and no configuration is read from the project. Before the repository is made the run root's physical path is compared with the project's: a run root inside the project (a home relocated beneath it) gets none, and the stage is refused. A plain folder with no `.gitignore` above a listed path seeds every declared file that is no secret and no link, and git is not run for it. Rules that cannot be read (a `.gitignore` is there and git is not, git exits with an error, runs past its deadline or output bound, or is ended from outside, or the run root lies inside the project) refuse the stage with `seed-unreadable`. It stops at `MAX_SEED_FILES = 5 000` or `MAX_SEED_BYTES = 512 MiB` with `seed-too-large` before any spawn (R14); it refuses a destination outside the run root.

### 3.4 Setup commands (W2)

Setup commands belong to the template, not to a stage: `TemplateGraph.setupCommands` (so also `TemplateVersion.setupCommands`), optional, at most 256 commands of at most 8192 characters, kept in order and byte for byte, and inside `graphHash`. One rule (lead ruling R17, validation wording replaced by C3), the same in the stage prompt (§2.5) and in validation:

- Setup commands are injected only into all-tools stages (`toolScope: "all"`). Each such stage starts in a fresh workspace and gets them as host text in its instructions ("run these first, in order").
- The stage child runs them through its ordinary shell tool. Each command asks on its own card (W2); in the unattended lane each must be inside the envelope of the all-tools stage that runs it.
- A read-scope stage never runs them. It has no shell, and its instructions never contain or mention them.
- A mixed template is valid: one with read-scope stages, a host-set `plan` stage included, and at least one all-tools stage may carry setup commands. They never run in its read-scope stages.
- Validation refuses setup commands for two causes, both with `setup-outside-commands`. The structural one (C3): the template has no all-tools stage, so nothing could run them. This shipped at `51d5d582f`: intake (`canonicalTemplateGraph`) and confirm (`validateStageForConfirm`) both refuse it. The coverage one (N1) is the next rule. Having read-scope stages is never a cause.
- Envelope coverage (lead ruling N1, shipped at `6942aca82`). For an all-tools stage that has an envelope, `validateStageForConfirm` refuses `setup-outside-commands` unless every setup command is covered by that stage's `envelope.commands`. Covered means the command equals a prefix, or starts with a prefix followed by a space or a tab. A read-scope stage's envelope is not compared, so a mixed template confirms when its all-tools envelopes cover the commands. An all-tools stage with no envelope is not compared either; it cannot run unattended. This check is at confirm only, not at intake.
- So the code has two causes: no all-tools stage, or an all-tools envelope that does not cover a setup command. The run-time denial stays as the second line: in the unattended lane a setup command outside the envelope of the stage that runs it is denied `outside-envelope` (§8 step 6).
- The engine does not depend on the validation: `buildStagePrompt` applies the first and third rule to every version it is given.
- The host never executes one.

### 3.5 The Ave-home boundary (F9, lead ruling T2)

A stage's own workspace is carved out of the protected-path floor for reads and writes, for that stage session and its D2 grandchildren, and for nothing else. The carve-out is a host-minted binding from a session id to one real path. It is never a path-prefix rule.

```ts
// src/permissions/stage-workspace-binding.ts — host-only, memory only
function bindStageWorkspace(sessionId: string, workspaceRoot: string): void;
// resolves the root once with no-follow physical resolution; throws unless the result is exactly
// <real aveHome>/worktrees/<project>/<run>/<stage> (four segments, stage not "_"-prefixed) and every component is a real directory
function boundStageWorkspace(sessionId: string): string | undefined;            // the stored real path
function unbindStageWorkspace(sessionId: string): void;
/** The permission-side check. True only when the session has a binding and the target's physical path lies inside it. */
function isOwnStageWorkspacePath(sessionId: string | undefined, path: string): boolean;
```

`isOwnStageWorkspacePath` does its own physical resolution (the floor's `protectedControlEntryFor` only normalises the spelling): the physical path of the deepest existing ancestor through `inspectPhysicalFilesystemPath`, with links and reparse points resolved to where they really point. It refuses any spelling with an uncollapsed `..`, and compares against the stored real path with the platform's case rule. A link inside the workspace that points outside it resolves outside and is not carved out. A nested `.ave` inside the workspace stays protected.

| File | Change |
| --- | --- |
| `permissions/stage-workspace-binding.ts` | The binding and the check above. The engine binds when a stage child is linked and binds each grandchild to its stage's root; it unbinds at session end. No other caller. |
| Floor consumers | `protectedControlEntryFor` has two callers, both for write effects and neither with a session id: the path facts built at `permissions/sensitive-paths.ts:631` and the rule matcher at `permissions/rules/scoped-rule-matcher.ts:51`. The carve-out goes where the `protectedControl` fact is turned into the floor for a known session (in `permission-manager.ts`; the exact line was not read and is the first task of WT-4): an `application-home` fact is dropped only if `isOwnStageWorkspacePath(sessionId, path)`. `protectedControlEntryFor` keeps its single `<home>/workspace` exception and gains no new prefix. A session with no binding is decided exactly as today. |
| Host-tool reads | No existing check stopped a host read beneath `worktrees` (a read of the home is otherwise the mode-dependent secret-read ask). `permission-manager.ts` therefore raises the same `application-home` protected-path floor for a read operand beneath `<home>/worktrees`, in either spelling, unless both spellings pass `isOwnStageWorkspacePath(sessionId, path)`. It covers the file tools' path operand (`read_file`, `list_files`, `glob_files`, `grep_files`, image and document reads) and the read operands of a shell command, host or sandboxed. A plugin or MCP call, a hook, and any call with no session id are floored for all of `worktrees`. A listing or a search that starts above `worktrees` passes over it (`tools/file-access-policy.ts: createStageWorkspacesSkip`); one that starts inside is decided by the floor on its root. No path outside `worktrees` is decided differently. |
| `permissions/ave-home-read-boundary.ts` | One ceiling row: `["worktrees", slug, slug, stageDir]`, `stageDir` not `_`-prefixed, so `_join`, `_out` and the levels above a stage folder can never be granted. |
| `permissions/asrt-sandbox.ts` | The home read boundary denies all of `worktrees` and re-opens, for read and write, only the folder bound to the session the wrap is composed for. The session id rides on the per-composition boundary snapshot (`ave-home-boundary-snapshot.ts`); the three sandboxed shell routes in `tools/shell-tools.ts` pass the calling session. A wrap composed with no session (a plugin child, an MCP server, a hook, the terminal) gets the full deny, so stage A's command cannot read stage B's folder even while both are bound. |

A sibling's folder, `_join`, `_out`, the run root and every other Ave-home path are not carved out, so for a stage session they remain a protected-path floor: a forced ask in an attended run, a deny in the unattended lane (§8, step 1).

Invariants: a stage child never reads or writes another stage's folder, `_join` or `_out`; `integrate` runs only for stages that are `passed` and sealed; every git call goes through `host-git.ts`; a path outside the run root is refused for create, copy and remove; removal touches only folders the provider created (recorded on the stage run), directly under a run root whose four levels are still the directories they were when the run's record was read, and git removes no folder; the user's checked-out branch, index and folder are never written.

### 3.6 Tests

`work-board/workflow/__tests__/stage-workspaces-git.test.ts` (real git in a temp repository under the lane's temp root): `each stage gets its own worktree from the run branch head`, `the join merges both stages onto ave/workflow/<run> and leaves the user's branch, index and files unchanged`, `a conflicting join returns the files and stages and leaves _join clean`, `retry merge succeeds after the conflict is resolved`, `the seal commit carries the user's identity and the run and stage trailers`, `seal refuses without a user identity`, `a repository hook, a clean filter and a textconv driver do not run during prepare, seal or integrate`, `a tracked secret file is absent from the stage folder and is not committed as a deletion`, `release removes worktrees and keeps the run branch`.

`…/stage-workspaces-folder.test.ts`: `a folder project runs two stages in parallel in two folders`, `seeds only the declared inputs`, `never follows a link out of the project and never copies a secret or ignored file`, `a plain folder outside any git work tree honours its own ignore files: an ignored declared input is not copied`, `a plain folder's ignore rules do not change with the git configuration and variables the host process inherited`, `each seeding makes the ignore matcher's repository in a folder of its own under its run, and it is gone afterwards`, `git failing after the matcher's repository was made refuses the stage as unreadable and leaves no repository behind`, `a home relocated beneath the project gets no matcher repository: the stage is refused and nothing is made in the project`, `the matcher takes each path whole: a name with a line break in it is one path`, `a plain folder's negation and nested-directory rules seed exactly what git leaves unignored in a repository of the same tree`, `a plain folder with no ignore file seeds every declared file and needs no git; with one and no git it refuses`, `the boot sweep takes what a stop left of the ignore matcher out of a run that goes on, and nothing else of that run`, `an output folder goes only when the stores still allow it once its run's queue is held, whatever an earlier read said`, `a run record that is a link, has a second name or lacks a field authorizes no cleanup`, `a run or project folder replaced by a link after it was listed is not cleaned through`, `refuses a seed above the bounds`, `collects outputs into _out and reports the same path from two stages as a conflict`, `a later stage is seeded from _out`.

`permissions/__tests__/stage-workspace-binding.test.ts` (each red before the change): `a read and a write inside the bound workspace are not a protected-path floor`, `the binding refuses a sibling stage's workspace`, `the binding refuses the run root, _join and _out`, `the binding refuses the Ave home settings file and the configuration folder`, `a symbolic link or junction inside the workspace that points at a sibling or at the Ave home is refused`, `a spelling with .. that leaves the workspace is refused`, `a grandchild is carved out for its stage's workspace only`, `a session with no binding gets no carve-out`, `bindStageWorkspace throws for a root that is not a real four-segment stage folder`, `the sandbox profile of a bound session re-opens its own folder and no sibling`.

`core/__tests__/work-board-stage-isolation.test.ts`: `request changes reruns in the same folder`, `retry prepares a fresh folder`, `boot sweep removes folders of runs that are no longer active only, and of a parked run only what its ignore matcher left`, `boot sweep removes the output folder and record of a run with no record whose item is gone, and follows no link out of it`, `a superseded run keeps its output folder when its record goes, until its item is removed`, `a discard whose first read of the stores is older than an item keeps the workspace of that item's starting run`, `deleting a row whose runs have no record left removes their output folders`, `a start refused because its row was deleted while its workspace was opened leaves no run folder`, `removing an unreadable row whose runs have no record left removes their output folders, and no other row's`.

`work-board/workflow/__tests__/stage-workspaces-git.test.ts`, added with the cleanup hardening: `a record copied into another folder, or naming another repository or branch, directs no cleanup`, `a run folder swapped for a link while its worktrees are released is not deleted through, by the host or by git`, `a refused open leaves a branch it did not make and takes back the one it made`. `stage-workspaces-folder.test.ts`: `a run folder swapped for a link before the ignore matcher is needed gets no repository made through the link`, `rules and names that differ by case alone seed what git leaves unignored in a repository in the same place, by the folder's own file name rule`, `the file name rule is read off the ignore file under its name in the other case, and is no rule at all when that cannot be told`.

`work-board/workflow/__tests__/host-git.test.ts`: `a git process that ends without an exit code rejects as terminated, whatever it wrote first`, `a git process that never reports its end still ends the call: stopped, or exited with its pipes held open`, `an isolated call reads no inherited git variable and no system or user configuration; any other call still does`.

Commit: `feat(work-board): per-stage workspaces and join collection`.

## 4. WT-5 — approval lanes, run grant, breaker

### 4.1 D4 lanes

No host change (F3). `use-board-approvals.ts` returns `byStage: ReadonlyMap<number, ReadonlyMap<string, readonly ApprovalRequest[]>>` next to `byItem`; the session → (item, stage) map comes from `item.stageRuns[].childSessionId` and from progress events (`stageId`, `runSessionId`). Each lane's head is decidable on its own through the window's one signed decision path; nothing batches. Test (`components/__tests__/WorkBoardStageLanes.test.tsx`): `two stage sessions' requests are drawn in two lanes and deciding one leaves the other pending`, `a request of a session the board does not list stays on the window lane`.

### 4.2 D5 run-scoped grant at `R`

Files: new `src/permissions/run-grants.ts`; changed `user-approval-store.ts`, `permission-manager.ts`, `approval-gate.ts`, `approval-rule-save.ts`, `shared/permissions-events.ts`, `ipc/domains/permissions.ts`; card option text in en/ko.

```ts
// run-grants.ts — memory only
function registerRunSession(runKey: string, sessionId: string): void;   // throws if the session belongs to another run
function runKeyOfSession(sessionId: string): string | undefined;
function endRunSession(sessionId: string): void;
function endRun(runKey: string): { sessions: number; grants: number };
export type UserApprovalScope = "session" | "run" | "persistent" | "global";   // permissions-events.ts:11
export type ApprovalChoice = "allow-once" | "allow-session" | "allow-run" | "allow-always" | "deny-once" | "deny-always";
```

| Rule | Where |
| --- | --- |
| `allow-run` is offered only when the requesting session is a registered run member and `allow-session` would be offered for the same request | choice list built next to `canRememberRequest` (`approval-gate.ts:1155`); forced floors (`forceExplicit`, `durableApprovalRecordAllowed === false`) therefore never offer it |
| Stored under a `run/v1` key = hash(key, runKey), in the in-memory store only; `recordApproval` refuses to write scope `run` to the approvals file | `user-approval-store.ts` beside `conversationEntryKey` (`:202`) |
| Looked up after the conversation row and before project and global rows; a deny at any scope still wins | `lookupUserDecision` (`:379-456`); run rules beside `sessionRulesInScope` (`permission-manager.ts:1004`) |
| Ends with the run: `StageRunEngine` calls `runEnded(runKey)` on every settle; nothing survives a restart | `RunScopeHooks` |
| Withheld session authority reads only run denies, like conversation rows | `user-approval-store.ts:455` pattern |

Invariants: a session that is not a registered member never reads a run row; a run row is never serialised; `endRun` leaves no row or rule for that key; one session, one run.

Tests (`permissions/__tests__/run-grants.test.ts`, `user-approval-run-scope.test.ts`, `approval-gate-run-choice.test.ts`): `a sibling stage session reuses an allow-run grant`, `a session of another run of the same item does not`, `the grant is gone after the run ends`, `a forced-floor card does not offer allow-run`, `a persistent deny beats a run allow`, `scope run is never written to disk`.

### 4.3 D6 breaker per stage session

`JudgeRequest` gains `breakerSessionId`; `permission-manager` computes it as the session itself when `runKeyOfSession(sessionId)` is set, else the root as today. `judge-engine.ts:171, 460, 501` and `permission-manager.ts:1734, 2019` use it. `sessionLinked` calls `beginTurn(sessionId)`; `sessionEnded` calls `forget(sessionId)`. Each stage session and each grandchild is its own key. Sessions outside a template run keep today's keying, as the owner decided.

Tests (`permissions/judge/__tests__/judge-breaker-run-sessions.test.ts`): `three blocks in one stage session pause that session only`, `a sibling stage session keeps its own count`, `a non-run child still counts on its root`.

Commit: `feat(permissions): per-stage approval lanes, run-scoped grant, per-session breaker for run members`.

## 5. WT-6 — sub-agents at depth 1 (D2)

Uses the shipped `TemplateStage.allowSubAgents: boolean`, part of the graph hash (§13). The stored canonical field is always present and is `false` unless the draft set it.

| File | Change |
| --- | --- |
| `engine/subagent-runner.ts` | `SubAgentSpawnInput.stageSubAgents?: { stageName: string; runKey: string; max: number }` (host-only). `buildChildDeps` (`:2315`) keeps `agent_spawn`, `agent_status`, `agent_interrupt` for such a child. Its tool context carries `spawnDepth: 1` and `stageSubAgents: true`. A spawn made by that child runs with `spawnDepth: 2`, never `stageSubAgents`, `approvalProvenance: null`, title `<stage name> › <sub-agent title>`. |
| `tools/agent-spawn.ts` | `:162-165`: allow depth 1 only when the host metadata says `stageSubAgents`; depth ≥ 2 always refuses. |
| `work-board/workflow/stage-run-engine.ts` | Pass `stageSubAgents` when the pinned stage opted in; register grandchild sessions through `RunScopeHooks`; forward `subAgentSessionId` on progress events so the board claims their cards. |

Rules: the grandchild inherits the stage's workspace (same workspace binding, same project root), envelope and budget, and cannot widen any of them; it inherits the approval surface through the registry chain (stage child → `work-board:<id>`); its cards go to the user, never to the stage model (F7); it is a run member (run grant, own breaker count); Stop on the stage interrupts its grandchildren first; a stage that ends with grandchildren still live has them interrupted before its gate is evaluated; `max` is a host constant (Q9). Unverified: that the existing result delivery to a spawning loop works unchanged when that loop is itself a depth-1 child (Q18).

Invariants: `agent_spawn` at depth 2 is refused with the existing error; a stage without the opt-in never sees `agent_spawn`; a grandchild with non-null approval provenance throws at spawn.

Tests (`engine/__tests__/subagent-stage-subagents.test.ts`): `an opted-in stage child can spawn one level`, `the grandchild cannot spawn`, `a stage without the opt-in has no agent_spawn tool`, `the grandchild's approval is labelled with stage and sub-agent and has no parent adjudication`, `the grandchild resolves the stage's approval surface`, `interrupting the stage interrupts its grandchildren`; `permissions/__tests__/run-grants.test.ts`: `a grandchild shares the run grant and has its own breaker count`.

Commit: `feat(work-board): per-stage sub-agent opt-in at depth 1`.

## 6. WT-7 — model-judged pass conditions (D9)

Uses the shipped pass kind `{ kind: "model_verdict" }` of `StageGate` (§13). File: new `src/work-board/workflow/stage-verdict.ts`, registered in `stage-gates.ts`.

```ts
function evaluateModelVerdict(output: string): { passed: boolean; evidence: string; judgedBy: "model" };
// passes only when the stage's final message ends with exactly one fenced JSON object {"verdict":"pass"|"fail","reason":string≤400}
```

The host tells the stage, in its instructions, to end with that block: a gate registry entry may carry `promptSuffix`, which `stage-prompt.ts` appends as host text. WT-3 lands that field, so WT-7 only fills it in `stage-verdict.ts`. Unparseable, missing, duplicated or oversized = failed gate with evidence `verdict-unreadable`. The stored gate carries `judgedBy: "model"`, and the event and the gate row are labelled as a model judgement. The module imports nothing from `src/permissions`.

Invariants: a verdict never creates, answers or removes an approval request; a `model_verdict` gate cannot be the answer to a human gate; a failed verdict follows the ordinary failed-stage path.

Tests (`work-board/workflow/__tests__/stage-verdict.test.ts`): `passes on a single pass verdict`, `fails on fail, on no block, on two blocks, on prose claiming OK`, `records judgedBy model`; its own `core/__tests__/work-board-stage-verdict-run.test.ts`: `a pass verdict leaves a pending tool approval of a sibling untouched`, `the stage prompt carries the verdict instruction only for a model_verdict gate`; an import test `stage-verdict has no permissions import`.

Commit: `feat(work-board): model-judged stage pass condition`.

## 7. WT-8 — schedule start (D8, OD-1) with the read-only interim limit

### 7.1 Files

| File | Change |
| --- | --- |
| `shared/routines-types.ts` | `RoutineExecution` gains `"template-run"` (`:11`); `RoutineRecord.attachmentId?: string`. |
| `main/routines-store.ts` | `isRoutineExecution` (`:74`) admits the new kind; `add` (`:416`) and `edit` (`:707`) refuse it unless called through the attach path with a `HostDecisionProof` that passes `assertHostDecisionProof` (`main/workflow-template-decision.ts`, shipped). Lead choice C1: plain removal of a `template-run` routine that has an active attachment is refused, and the refusal names detach as the way ("detach the schedule from its template first"). The check sits where every removal passes: `remove` and `removeRoutineWithRuns`, which the schedule panel's delete and the `routine_schedule` tool share. It reads the active attachment through `listByRoutine`. No caller is exempt: the detach handler sets `detachedAt` first, so its own removal meets a routine with no active attachment (§7.2). A routine with no active attachment (an orphan, or one already detached) can be removed by the ordinary path. |
| Schedule list (routine list reader and its row state; file not read, first task of WT-8) | A `template-run` routine with no active attachment is listed as "needs reattach or delete". One whose attachment refuses `scope-changed` is listed as "needs reattach". After the limit is lifted, one whose attachment's version has a stage with no envelope is listed as "needs a new version: add envelopes and confirm" (R27, §7.2); "needs reattach" is not used for that state, because attaching the same version again is refused. Neither is repaired by the host. A routine whose last firing was skipped for an envelope tool shows that firing's status, "skipped: `<tool>` unavailable" (§7.2); it is not listed as "needs reattach", and its attachment stays as it is. |
| `tools/routine-schedule.ts` | `:139, 262`: the tool refuses `template-run` for create and edit, whatever approval it holds. |
| `main/routines-scheduler.ts` | A third handler set in `dispatch` (`:183`). |
| `boot/steps/routines-wiring.ts` | The handler: load the attachment, pass the per-schedule admission of §7.2 (WT-8's own; WT-18 adds only the pause to it), create the item, call `StageRunEngine.start` with the schedule source and `approvalSurface: null`, record the outcome with `recordRunOutcome` (`routines-store.ts:665`). |
| `src/ipc/workflow-template-handlers.ts` (shipped with WT-2; WT-8 changes it) | The channels exist: `ave:work-board:template-attach-schedule` and `ave:work-board:template-detach-schedule`. Each validates the sender and requires a keyboard gesture from the owner frame. The attach handler also checks project access through the template's scope (`scope-not-authorised` when the project is not an authorised workspace project). The detach handler does not: since `6942aca82` it looks up no project (N7), so a schedule can be detached after its project's authorisation was withdrawn; it keeps the sender, gesture, owner-frame, shape, attachment and proof checks. Each mints the proof with `mintHostDecisionProof("local-desktop")`, calls `attachSchedule` / `detachSchedule`, and writes the audit events `template_schedule_attached` / `template_schedule_detached` with the proof's `auditId`. No new IPC file. WT-8 adds to the attach handler the current-version check and the routine creation and cleanup of §7.2 (R18), and to the detach handler the routine removal of §7.2. The shipped attach handler already hands the store the scope it checked, with the authorised project-registry root (N8), as the R21 snapshot (`51d5d582f`); WT-8 keeps that call as it is. WT-9 adds the remote path; until then the store refuses a proof whose origin is not `local-desktop`. |
| `permissions/permission-manager.ts` | The interim rule of §7.4 for sessions spawned with `unattendedStage`. |

### 7.2 Attach and fire

```ts
// shipped store input and writer (shared/workflow-template-types.ts, main/workflow-template-store.ts)
interface ScheduleAttachmentInput { templateId: string; version: number; graphHash: string; scheduleId: string }   // scheduleId is the routine id
attachSchedule(input: ScheduleAttachmentInput, proof: HostDecisionProof, approvedScope: TemplateScope): Promise<ScheduleAttachment>;   // stores a copy as attachment.approvedScope
detachSchedule(id: string, proof: HostDecisionProof): Promise<boolean>;
// store refusals (WorkflowTemplateErrorCode): "template-not-found" | "template-archived" | "unknown-version" | "graph-hash-mismatch" | "schedule-requires-read-only"
//   | "scope-changed" (approvedScope differs from the template's scope at that moment; nothing is written)
// shipped handler refusal: "scope-not-authorised". WT-8 adds one handler refusal: "not-current-version"

// shipped (work-board/template-graph.ts)
function attachmentScopeMatches(attachment: { approvedScope?: TemplateScope }, template: { scope: TemplateScope }): { ok: true } | { ok: false; code: "scope-changed" };
function isAllReadOnlyVersion(graph: TemplateGraph): boolean;
// no template setupCommands; every stage: toolScope "read", allowSubAgents false, no requestedOutputs; envelope absent, or with
// writePaths, commands, network, outputs, mcpReadOnlyTools, mcpGenerationTools and pluginGenerationTools all empty
```

- Attach binds to the tuple the user saw, which must be the current version at that moment. The shipped store does not check "current"; WT-8's handler does, before it calls the store.
- The shipped attach takes the id of a routine that already exists. WT-8's handler keeps "neither exists without the other" by creating the `template-run` routine first (same proof), then calling `attachSchedule` with its id. A reattach ("needs reattach", after `scope-changed` or on an orphan) names a `template-run` routine that already exists; that path creates no routine and only calls `attachSchedule`. The two stores are not one transaction. Lead ruling R18 makes the gap fail closed:
  - If the attachment write fails or is refused after the routine was created, the same handler deletes the routine and returns the error. It deletes only a routine it created in that call; a failed reattach leaves the existing routine as it was.
  - A crash between the two writes, or a failed cleanup, leaves a `template-run` routine with no active attachment (an orphan). Its fire refuses `attachment-missing` and starts nothing. The schedule list shows it as "needs reattach or delete". The host never repairs it: it does not attach it, delete it or guess a version for it.
- A scheduled run's project comes only from the scope snapshot on its attachment (R21, §2.4), never from the live `WorkflowTemplate.scope`: `{ kind: "project", projectRoot }` gives the project root; `{ kind: "all" }` runs with no project (folder kind, §3.3). The fire handler calls the shipped `attachmentScopeMatches(attachment, template)` before it creates anything. When the template's current scope no longer equals the snapshot, the fire refuses `scope-changed`, starts nothing, and the schedule list shows "needs reattach". The schedule list uses the same function for its row state. A record with no snapshot does not reach the fire: since `6942aca82` the template file that holds it fails to load (`invalid-template-file`, §13).
- An envelope on a read-only stage qualifies only if it says `writePaths: []` and `outputs: []` explicitly, because the defaults are `["**"]` and `["branch"]`.
- One active attachment per `scheduleId`. Attaching the same routine again sets `detachedAt` on the prior record and adds a new one with a new `id`; detached records keep their pins.
- A fire creates a new board item for that run (R7) and starts it. The source is built from the stored attachment only.
- One run at a time per schedule, not per attachment. The schedule is the routine: `scheduleId` is stable, while every attach makes a new attachment `id`. WT-8 owns this admission:
  - The fire handler takes every attachment id of the routine from `listByRoutine(scheduleId)`, the current record and all detached ones. It then looks on the board for an item whose `runStartedBy` is a `schedule-attachment` source with one of those ids and whose run is not settled (`runStatus: "executing"`, §2.3: a live child, a parked gate or join, a failed stage that waits). If there is one, the fire is skipped `run-unsettled` and creates nothing.
  - The check and the start are one serialized step per `scheduleId`: one promise chain per routine holds from the scan until `beginRun` has stored the new run or the start was refused. Two fires of one routine, or a fire that races a reattach, cannot both pass.
  - A reattach is not an exception. After a replacement attach, the new attachment fires nothing while a run of an earlier attachment is unsettled: its live child still running, or its gate still parked (§2.4). When that run settles, the new attachment may fire.
  - Admission interrupts nothing and restores nothing. The old run's live child ends on its own or by Stop, and the old run's spawn authority stays revoked.
  - An orphan routine is covered the same way: its detached records still list the earlier runs.
- `isAllReadOnlyVersion` is checked at attach, at fire and before every spawn (through `unattendedAllowed`, §2.4). After the limit is lifted the same three places ask WT-15's qualification through the same predicate (§8, §9).
- A fire whose start is refused creates no item and no child; the refusal code is recorded as the routine's failure. The fire handler takes the code, and the tool when there is one, from the verdict of the one authority function (§2.2); it runs no check of its own.
- One refusal has its own outcome (lead ruling Q6): `outward-effect-tool` or `tool-effect-unknown` at fire. That firing is skipped with the status "skipped: `<tool>` unavailable", where `<tool>` is the verdict's tool, and the code is recorded with it. Nothing is created. The attachment is not touched and the schedule is not listed as "needs reattach": a server that is offline for one firing asks for no new version and no new approval, and the next firing asks again. The skip counts toward the schedule breaker as a bad outcome, so two in a row pause the schedule (§11). A firing skipped `run-unsettled` or `paused` is not counted, as before.
- The same refusal at attach (after the limit is lifted, §9): the attach is refused with that code and names the tool; no routine and no attachment are written, and a routine the handler created in that call is deleted as for any failed attach (R18).
- A stage with no envelope, before and after the lift (rev9 review, P3-1):
  - While the interim limit stands, `isAllReadOnlyVersion` is the predicate, and it does not ask for an envelope. An all-read-only version qualifies with or without one, as the shipped function says above: it attaches, fires and spawns. A version that is not all read-only is refused, with or without envelopes: `schedule-requires-read-only` at attach, `unattended-not-read-only` at fire and at spawn. Neither names a tool.
  - After the limit is lifted (§9), every stage needs an envelope. A version with a stage that has no envelope and no failing tool is refused at attach with the shipped store code `schedule-requires-read-only`, and at fire and at spawn with `unattended-not-read-only` (§2.2); it names no tool. This holds for an all-read-only version too, which is the one intended structural change of the lift for such a version. An attachment made before the lift for such a version is ruled (R27): the template file that holds it still loads, and only that attachment is refused. Its fire is refused `unattended-not-read-only`, starts nothing and is recorded as the routine's failure; that failure counts toward the schedule breaker as a `failed` outcome, so two in a row pause the schedule (§11). The schedule list shows the state as "needs a new version: add envelopes and confirm" (ko: "새 버전 필요: 무인 실행 허용 범위를 추가하고 확정"); the limit-lifting commit adds both texts. It is not shown as "needs reattach": an attach of the same version is refused `schedule-requires-read-only`, and the label names the way that works. The host migrates and repairs nothing: the user confirms a version with an envelope on every stage and attaches that one. Every other template in the file stays usable, and so do this template's attended runs.
- Detach has one outcome for a run that already started, whichever way the record was detached (the rule and the table are in §2.4): a child that is already live is not interrupted; the next spawn is refused `attachment-detached`; when no child is live the run settles `cancelled`. Only Stop interrupts a live child. The three ways:
  - Explicit detach (lead choice C1): sets `detachedAt`, then the same handler removes the routine. This changes the shipped detach handler, which only calls `detachSchedule`. WT-8 keeps what `6942aca82` fixed there: the handler looks up no project, so the detach and the routine removal also work for a project that is no longer authorised (N7). If the removal fails, the routine is an orphan and is listed as "needs reattach or delete".
  - Replacement attach on the same routine: sets `detachedAt` on the earlier record. A run started from the earlier record is treated exactly as after an explicit detach; the new record authorises only runs fired after it, and only once the earlier run has settled (the admission above).
  - Plain removal of the routine (the schedule panel's delete, the `routine_schedule` tool, any other caller): refused while the routine has an active attachment, and the refusal names detach (§7.1). It is not turned into a detach. No path removes the routine and leaves its attachment active.
- Confirming a new version changes no attachment record. If the new version changes the template's scope, the unchanged attachment refuses `scope-changed` from then on. The editor's "schedules still on v1" list reads `listByTemplate`, which also returns detached records; the list shows only those with no `detachedAt`.

### 7.3 Parked gates

Already in WT-3: a human gate is a stored object with no timeout; the item sits in Needs review by derivation; a pending gate survives restart and nothing spawns at boot; a later local decision continues the run with the deciding window as the approval surface **for gate and join decisions only**. In an unattended run that surface is never given to a stage child: its tool calls are never turned into cards.

### 7.4 Interim tool-call rule (until WT-15)

A session spawned with `unattendedStage` has only read-tier tools (the version is all read-only). Its permission requests are built with `headless: true`, mode `default`, and withheld session authority (the existing `withholdSessionAuthority` path, `subagent-runner.ts:2623`), whatever the owner's ambient mode is. This closes F11 for the interim (R8). WT-15 replaces the rule with the lane.

### 7.5 Invariants and tests

Invariants: no tool call and no renderer payload can create, edit or move an attachment; a fire never decides a gate; a fire never starts a version other than its attachment's; a routine never has two unsettled runs, across all of its attachments; a `template-run` routine with an active attachment is never removed except by the detach handler after it set `detachedAt`; no stage child of a scheduled run ever raises a card.

Tests: `main/__tests__/routines-template-run.test.ts`: `the routine tool cannot create or edit a template-run routine`, `the store refuses the kind without the attach proof`, `a fire starts the attachment's version while a newer one is current`, `a fire is skipped while a run of the schedule is unsettled`, `a refused start records a failure and creates no item`. Per-schedule admission across a reattach, in the same file: `after a replacement attach a fire is skipped while the earlier attachment's run still has a live child, and that child is not interrupted`, `after a replacement attach a fire is skipped while the earlier attachment's run is parked at a gate`, `once the earlier attachment's run settles the new attachment fires`, `two fires of one routine that arrive together start one run`. The shipped handler tests already cover the gesture and the owner frame. The read-only refusal is tested at store level, in `src/main/__tests__/workflow-template-capabilities.test.ts`. WT-8 adds handler cases: `attach refuses a version that is not current`, `attach creates the routine and the attachment together`, `when the attachment write fails after the routine was created the handler deletes the routine and returns the error` (R18), `an explicit detach sets detachedAt and removes the routine` (C1), `plain removal of a template-run routine with an active attachment is refused from the schedule panel and from the routine tool, the refusal names detach, and the routine and its attachment are unchanged` (C1), `a template-run routine with no active attachment is removed by the ordinary path`. In `routines-template-run.test.ts`: `an orphan template-run routine refuses its fire attachment-missing, is listed as needs reattach or delete, and is not repaired at boot or at fire` (R18), `a fire whose template scope differs from the attachment's snapshot is refused scope-changed, creates no item and is listed as needs reattach` (R21), `a fire whose snapshot matches runs on the snapshot's project` (R21). `permissions/__tests__/unattended-interim.test.ts`: `a scheduled stage session in Allow mode is denied a secret-file read and never asks`. `core/__tests__/work-board-stage-run.test.ts` (added): `a scheduled run parks at its human gate and a local approve continues it`.

Commit: `feat(routines): schedule attachment starts a read-only template run`.

## 8. WT-15 — envelope evaluator: the unattended lane (OD-2, OD-3)

Files: new `src/permissions/unattended-lane.ts` (pure), new `src/permissions/unattended-lane-registry.ts`; changed `permissions/decision-pipeline.ts`, `permissions/permission-manager.ts`; one line in `workflow-engine-extensions.ts` (`LaneHooks.sessionLinked`, `sessionEnded`, `onDenied`). For ruling P (below): new `src/permissions/tool-effect-evidence.ts`; changed `ipc/workflow-template-handlers.ts` (the confirm handler), `main/workflow-template-store.ts` (`confirmDraft`), `work-board/template-graph.ts` (the new `qualifyUnattended`; `validateStageForConfirm` is not changed), `shared/workflow-template-types.ts` (two `WorkflowTemplateErrorCode` members), the tool base type and the MCP and plugin tool adapters with their manifest schema and public contract, and the en and ko catalogs.

```ts
// unattended-lane-registry.ts — host-only, memory only
interface UnattendedStageEntry { runKey: string; stageId: string; envelope: StageEnvelope; workspaceRoot: string; isolation: { proven: boolean; reason?: string } }
function registerUnattendedStage(sessionId: string, entry: UnattendedStageEntry): void;   // a grandchild registers its stage's entry
function unattendedStageOf(sessionId: string): UnattendedStageEntry | undefined;
function endUnattendedStage(sessionId: string): void;

// decision-pipeline.ts
interface PermissionDecisionRequest { /* … */ unattended?: UnattendedStageEntry }
type UnattendedDenyCode = "outside-envelope" | "forbidden-unattended" | "isolation-unproven" | "rule-ask" | "exfiltration-guardrail" | "reviewer-denied";
const UNATTENDED_DENY_MESSAGE = "This call is outside what this scheduled run was confirmed to do; do not retry.";

// unattended-lane.ts
function insideEnvelope(request: PermissionDecisionRequest, entry: UnattendedStageEntry): { inside: true } | { inside: false; why: string };
function decideUnattended(request: PermissionDecisionRequest): PermissionPipelineDecision;   // outcome is allow, sandbox-auto, deny, or the review-required intermediate
```

The lane is keyed on the registry entry, which exists only for a session the engine spawned for a run whose stored source is `schedule-attachment`. `headless` is not the key. Order inside `decidePermission`, after the existing admission denial, deny rule and unsupported-kind checks:

| # | Test | Result |
| --- | --- | --- |
| 1 | `request.floor` present (any code; the tree draws this as an explicit `F → DENY` edge for 질문† targets in schedule-started stage sessions). The stage's own workspace is not a floor (§3.5). | deny `forbidden-unattended` |
| 2 | isolation not proven | deny `isolation-unproven` |
| 3 | an ask rule matches | deny `rule-ask` |
| 4 | exfiltration signal | deny, before the envelope |
| 5 | user-owned surface, agent browser, secret read, a shell that is not sandboxed or is escalated, a manual rerun | deny `forbidden-unattended` |
| 6 | a builtin not in `envelope.tools`; an MCP tool in neither `mcpReadOnlyTools` nor `mcpGenerationTools`; a plugin tool not in `pluginGenerationTools`; a declared tool that the host registry flags as outward-effect, or about which it has no effect evidence at the call (ruling P: by registry metadata, never by name), whatever the envelope says and whatever confirmation accepted; a path outside the workspace and `readRoots` (read) or outside `writePaths` (write); a write with no checkpoint; a network target not in `envelope.network`; a shell command outside `envelope.commands` | deny `outside-envelope` |
| 7 | read inside; write inside; sandboxed shell with no unproven or destructive signal; a sandboxed connection to an envelope host | allow (`sandbox-auto` for the shell) |
| 8 | sandboxed shell with an unproven or destructive signal; a declared tool (`mcpReadOnlyTools`, `mcpGenerationTools`, `pluginGenerationTools`). For a generation tool the reviewer is given its declared `effect` and `dataSent`. | reviewer: low or medium and breaker closed → allow; anything else → deny `reviewer-denied` |

`permission-manager.ts` attaches `unattended` from the registry and, for such a request, does not look up allow rules, remembered grants, floor-session grants or run grants, and does not read the mode. Deny rules still apply. Step 8 uses the pipeline's existing review-required intermediate; for a lane session the manager never turns it into a card: with no reviewer evidence the final result is deny. Every deny is reported through `onDenied`. The envelope's forbidden contents are refused here whatever confirmation accepted. WT-2's shipped declaration check covers host shell tools, user-owned surfaces, floor and secret paths, tools broader than the stage's scope, and a generation `effect` other than `generate` or `fetch`. Publishing tools are handled by ruling P, described below: banned in the declaration by the closed effect enum, marked at confirm and refused at attach, at fire and at spawn by registry metadata, and denied again in step 6 by the same metadata. No step reads a tool's name for this. `dataSent` is not part of any of this: it is disclosed to the reviewer in step 8 and no step allows or denies on it (R19). An exfiltration signal still denies in step 4, whatever the flag says.

Outward-effect tools (lead ruling P, with the lead's rulings Q1–Q6 on it; deferred from WT-2 to this item). The ruling has three lines, and none of them reads a tool's name:

1. Declaration (shipped). A generation entry's `effect` is the closed enum `generate` | `fetch`, and intake refuses any other value. There is no name pattern anywhere.
2. Qualification for the unattended lane (this item; Q2, Q6). An envelope tool entry fails when the host registry flags it as outward-effect, or has no effect evidence for it at that moment: the tool is not registered, its server is offline, or it carries no annotation that settles the question. Unknown means refused, and a temporary unknown is refused like a permanent one. A version with a failing entry does not qualify for the unattended lane. The question is asked at confirm, to mark the version, and at attach, at fire and before every spawn, to refuse.
3. Run time (this item and WT-16). Step 6 above and the tool schema of §9 ask the same resolver again, because a registry entry can change between a spawn and a call.

What a refusal covers: the unattended lane only, and never the confirmation (lead ruling Q2, which replaces rev7's refused confirm). The envelope governs nothing else.

- Confirm succeeds. `confirmDraft` writes the version as it does today, with the envelope unchanged inside `graphHash`; the P check adds no `EnvelopeRefusal` and no `envelope-refused` cause, and `validateStageForConfirm` is not changed.
- The confirm screen marks the version "can't run unattended: `<tool>` `<reason>`", with the tool's name and the text of the code. The mark is the qualification result of that moment. It is returned beside the confirmed version and is not stored: it is not in `graphHash`, not in the version record and not in the template file, because the registry can change afterwards. Any later view that shows it asks the same function again.
- The marked version is the current confirmed version like any other. `Create and run` starts it attended, with the unchanged envelope, and each tool call goes through the normal permission tree and its cards. That path does not change, and the tool is not banned.
- Attach is refused with the code, naming the tool (§7.2). In an unattended run an outward action stays reachable only as a requested output behind its human gate (§10).

Where the check runs again (lead ruling Q6; the question came from WT-2 review 3, P3-3, which settled only that the plan must cover it). A version confirmed before this item landed never met the resolver, and a version that qualified can meet a changed registry later. So the same function, one function over the stored version's envelopes, runs at attach, at fire and before every spawn of an unattended run, as `unattendedAllowed` (§2.2, §2.4). Each place has its own outcome:

| Where | Outcome when an entry is outward or unknown |
| --- | --- |
| Attach | Refused with the code; the refusal names the tool. Nothing is written (§7.2). |
| Fire | That firing is skipped with the status "skipped: `<tool>` unavailable". No item and no child are created. The attachment and the schedule stay as they are; it is not "needs reattach". The skip counts toward the existing schedule breaker: two in a row pause the schedule (§7.2, §11). |
| Spawn | The spawn is refused and the run settles `cancelled` with the reason code and the tool, by the rule every refused spawn follows (§2.4). |

A temporary outage therefore asks for no new version, no new confirmation and no new attachment. When the tool has evidence again, the next firing runs; a paused schedule waits for its owner to resume it, as for any pause. Nothing re-confirms, re-attaches or repairs silently. All of this must hold before WT-16 lifts the read-only limit: WT-15 ships the function and the confirm mark, and WT-16's limit-lifting commit swaps the function into the predicate and changes the consumers in that one commit (§9). While the limit stands, the two effect codes cannot be reached at attach, fire or spawn, because a version with a failing entry is not all read-only and is refused by the interim limit first.

One result, one check (rev7 review; approved by the lead). The function returns `UnattendedQualification` (§2.2): `ok`, or a code, and for the two effect codes the failing tool. The effect check comes first, so a failing entry is named even when the version also has a stage with no envelope. The first failing entry is reported: stages in graph order, then `tools`, `mcpReadOnlyTools`, `mcpGenerationTools`, `pluginGenerationTools`, then entry order. The confirm mark, the attach refusal, the fire status and the settle event all show that one result. Nothing else decides the question, and nothing reduces it to a boolean on the way.

Why it is here and not in WT-2. The lead gave it to WT-2 if registry metadata could be reached on the confirm path, else to WT-15. The WT-2 investigation found the registry object reachable (the confirm handler has the tool registry in its dependencies, and its lookup by name is a synchronous map read), but no complete classification in it:

- A builtin's `arbitraryEgress` flag says the tool can reach a model-chosen URL. Read-only fetch and search set it too, so it is not "outward", and its absence proves nothing.
- The tool category is a risk class (read, write, shell, network, meta). It cannot tell local generation from an outward write.
- An external MCP tool keeps only its read-only and destructive hints, normalised to booleans. "No annotation" and "annotated false" look the same afterwards, no open-world hint is kept, and a publishing call need not be destructive. Discovered tools are also dropped when the server disconnects.
- A plugin tool keeps only the read-only hint.
- A template's own `effect` field is the template's claim. Trusting it would leave the hole open.

So the missing part is producing and keeping the metadata, not looking it up, and WT-2 changed no code for P. The work, as the investigation's follow-up list:

1. Define host-owned effect evidence with three states: outward, safe (generate or fetch) and unknown. Inventory the builtins. Keep the presence and the values of validated external annotations at ingestion. Nothing is inferred from a name, from the category alone or from a template's effect field, and there is no plugin-specific host branch. How a generation tool that is not read-only is proven safe is open (R24, §14.3). The lead accepted the default (Q4): until it is decided such a tool is unknown, and so refused for the unattended lane only.
2. Change the manifest schema, the public contract and the adapters together, in the same commit as their consumers. An entry that is offline, missing or not annotated enough stays unknown. No qualification, at confirm or later, starts or reconnects a server.
3. Inject a narrow read-only resolver from the main-process confirm handler into `confirmDraft`, which hands it to `qualifyUnattended`; `template-graph.ts` stays pure. The qualification runs at the queued draft and revision boundary, on the version that was just written, and its result is returned with that version. It never changes whether the version is written (Q2). It covers all four envelope tool collections (`tools`, `mcpReadOnlyTools`, `mcpGenerationTools`, `pluginGenerationTools`), each by exact host identity (lead ruling Q3, which accepts R25). Outward and unknown both fail closed, for the unattended lane. Attended permission evaluation is not touched.
4. Add the two codes with en and ko messages, and the en and ko text of the confirm mark; update consumers and fixtures, and sweep the contract in the same PR. Requested outputs stay behind their own human gate.

```ts
// WT-15 (not shipped). The two codes are decided (lead ruling Q1); the other names are this plan's
type ToolEffectEvidence = "outward" | "safe" | "unknown";
interface ToolEffectResolver {                       // permissions/tool-effect-evidence.ts; read-only, synchronous, never connects or discovers
  effectOf(tool: { collection: EnvelopeToolRef["collection"]; name: string }): ToolEffectEvidence }
// work-board/template-graph.ts, pure, beside isAllReadOnlyVersion; the ONE qualification, for the confirm mark, attach, fire and spawn
function everyStageHasEnvelope(graph: TemplateGraph): boolean;            // the structural half; template-file validation asks neither half (R27, §9)
function qualifyUnattended(graph: TemplateGraph, effects: ToolEffectResolver | null): UnattendedQualification;
// 1. an entry with outward evidence → outward-effect-tool, with the tool; unknown evidence → tool-effect-unknown, with the tool
// 2. else a stage with no envelope → unattended-not-read-only      3. else ok.    A null resolver answers unknown for every entry
//    attachSchedule throws case 2 as the shipped "schedule-requires-read-only"; no other caller renames a code
// confirmDraft(id, input, actor, effects: ToolEffectResolver): Promise<{ version: TemplateVersion; unattended: UnattendedQualification }>
//   the resolver is required: a call without one does not compile. The version is written whatever `unattended` says
type WorkflowTemplateErrorCode = /* the shipped members (§13) */ | "outward-effect-tool" | "tool-effect-unknown";   // thrown by attachSchedule after the limit is lifted (§9); the error carries the tool
```

- `outward-effect-tool`: the registry flags the entry as outward-effect. en: "This tool acts outside the run, so a scheduled run cannot use it by itself. Ask for it as a requested output instead." ko: "이 도구는 실행 바깥에 영향을 주므로 예약 실행이 스스로 사용할 수 없습니다. 대신 요청 출력으로 요청하세요."
- `tool-effect-unknown`: the registry has no effect evidence for the entry. en: "Ave cannot tell what this tool does right now, so a scheduled run cannot use it. It still works when you run the workflow yourself." ko: "지금은 이 도구가 무엇을 하는지 확인할 수 없어 예약 실행에서 사용할 수 없습니다. 직접 실행할 때는 그대로 사용할 수 있습니다."
- The two codes and this en and ko text are decided (lead ruling Q1). Each is a `WorkflowTemplateErrorCode` and a code of `UnattendedQualification`, shown through `reasonCodes.<code>` in `src/i18n/messages/en.ts` and `ko.ts`, like the shipped reason codes. They are not `EnvelopeRefusal` members, because they no longer refuse a confirmation (Q2).
- Two fixed texts take the tool's name and are added in en and ko by the lane that first shows them. The confirm mark, WT-15: en "can't run unattended: `<tool>` `<reason>`", ko "무인 실행 불가: `<tool>` `<reason>`", where `<reason>` is the message of the code. The fire status, the limit-lifting commit: en "skipped: `<tool>` unavailable", ko "건너뜀: `<tool>` 사용 불가". The en texts are the lead's; the ko texts were this plan's drafts and the lead accepted them (rev8 rulings, §14.1).

Tests for P in WT-15 (`main/__tests__/workflow-template-effect-evidence.test.ts`, red first by file backup, no stash):

- Flagged (Q2): `a version with an envelope tool the registry flags as outward-effect confirms, is written with its envelope and graphHash unchanged, and is returned marked can't run unattended with outward-effect-tool and that tool`.
- Unknown (Q2): `a version confirms and is marked tool-effect-unknown, with the tool, for an entry that is not registered, for one whose server is offline and for one with no annotations, and no server is started or reconnected`.
- Allowed: `a version whose envelope tools all have safe evidence confirms with no mark`.
- The mark is not stored: `the stored version, its graphHash and the template file are byte-equal for a marked and an unmarked confirm of the same draft`.
- `each of the four envelope collections is checked`, `an entry that declares effect generate for a tool the registry flags as outward-effect is marked` (a spoofed template claim), `the confirm handler passes the resolver to the store and returns the mark to the confirm screen`, `both codes and the mark text have an en and a ko message`.
- The one function, in `work-board/__tests__/template-graph-unattended.test.ts`: `qualifyUnattended names the first failing entry and its code for each collection`, `a failing entry is reported before a stage with no envelope`, `a null resolver answers tool-effect-unknown for every entry`, `a version with no envelope tool and an envelope on every stage is ok`.
- Attended use (Q2): `a marked version is started by Create and run as the current version, and a tool that fails the qualification still raises its card in the attended run`.
- Attach while the limit stands: `a marked version is refused at attach`. It is refused by the interim read-only limit; the refusal with the effect code and the tool is the limit-lifting commit's (§9).
- Lane, in `unattended-lane.test.ts`: `a declared tool whose registry entry turns outward-effect or unknown after the spawn is denied outside-envelope`.

The tests of the attach, fire and spawn outcomes need the swapped predicate and are in §9, with the limit-lifting commit.

Success criteria for P: the targeted tests fail before the change and pass after it; `bun run typecheck`; biome and knip with zero new findings; the i18n catalog check; WT-2's focused 16-file selection; `git diff --check`. No app, no E2E.

Invariants: no lane decision is `ask` or `ask-forced`; the mode never changes a lane outcome; the reviewer never allows what step 6 denies; a session without a registry entry is decided exactly as today; no check decides a tool's effect from its name; ruling P never refuses a confirmation and never changes a stored version or its `graphHash`; no version is attached, fired or spawned unattended with an envelope tool whose evidence is outward or unknown at that moment, whenever it was confirmed; the confirm mark, the attach refusal, the fire status and the settle reason come from one function and carry its code and its tool (the one renamed code is the no-envelope refusal at attach, `schedule-requires-read-only`, which has no tool); no qualification connects to a server.

Tests (`permissions/__tests__/unattended-lane.test.ts`): one row per table line; `every mode gives the same outcome`; `an allow rule, a remembered grant and a run grant are not consulted`; `a deny rule still denies`; `an exfiltration signal denies a call that is inside the envelope`; `a reviewer verdict of high, an error and an open breaker deny`; a generated-request property test `the lane never returns ask`; `permissions/__tests__/decision-pipeline.test.ts` (existing) unchanged and green.

Commit: `feat(permissions): unattended lane and envelope evaluator`.

## 9. WT-16 — unattended isolation profile

Files: new `src/permissions/unattended-isolation.ts`; changed `permissions/asrt-sandbox.ts`, `permissions/egress-runtime.ts`, `engine/turn/tool-scope.ts`, `permissions/host-shell-execution-plan.ts`, the shell environment builder and the project hook / skill / MCP loaders (anchors not read; first task of the item); one line in `workflow-engine-extensions.ts` (`LaneHooks.admit`).

```ts
type IsolationUnproven = "sandbox-unavailable" | "boundary-unverified" | "platform-not-qualified" | "read-narrowing-unavailable" | "local-network-required";
interface UnattendedIsolationProfile {
  readRoots: string[];            // the stage workspace, toolchain roots, envelope.readRoots; everything else in the user's home is read-denied
  writeRoots: string[];           // the stage workspace and its temp folder
  egress: { host: string; port?: number }[];   // exactly envelope.network, held for the stage session only; local and private destinations refused
  env: "scrubbed";                // no secret-bearing variable, no credential helper, no agent socket
}
function proveUnattendedIsolation(a: { workspaceRoot: string; envelope: StageEnvelope; platform: NodeJS.Platform; probes: SandboxProbeState }):
  { proven: true; profile: UnattendedIsolationProfile } | { proven: false; reason: IsolationUnproven };
```

| Part | Rule |
| --- | --- |
| Admission | `LaneHooks.admit` runs `proveUnattendedIsolation` before each spawn. Unproven: nothing spawns, the stage keeps `waiting` with `blocked: { code }`, and the item shows in Needs review with the reason. It never falls back to a host route. |
| Floors | A 질문† target is denied for a lane session (the `F → DENY` edge, evaluated in WT-15 step 1); this item makes sure the `sandbox-unavailable` floor is raised, not skipped, when the profile cannot be proven mid-run. |
| Shell | Only a plan with `sandboxed === true` (`host-shell-execution-plan.ts:38`). The host route, escalation and the unsandboxed retry are refused in the plan builder as well as in the lane. |
| Reads | Narrowed as in the profile. Per platform; Windows is not designed here (R12). |
| Network | The proxy list for the session is the profile's `egress`; released at stage end like `releaseEgressSessions` (`egress-runtime.ts:55`). Persistent egress grants are not consulted. The egress builtins stay removed. |
| Tools | `tool-scope.ts:119-121, 136`: for a lane session, MCP tools are those in `envelope.mcpReadOnlyTools` and `envelope.mcpGenerationTools`, plugin tools are those in `envelope.pluginGenerationTools`, and no others. A generation entry is `{ name, effect: "generate" \| "fetch", dataSent }`; a tool that the resolver of §8 reports as outward or unknown is never in scope, declared or not (ruling P: by registry metadata, never by name). Their results are external content and carry taint. Lead ruling R19: `dataSent` is a disclosure only. It is shown at confirmation and given to the reviewer (§8 step 8); it adds no rule of its own, and the exfiltration signal still denies first (§8 step 4). |
| Loaders | Hook commands, skills and MCP servers found in the stage workspace do not load. |
| Lifting the interim limit | The last commit of this item swaps WT-8's `unattendedAllowed` predicate from `isAllReadOnlyVersion` to WT-15's `qualifyUnattended` with the app's resolver: "every envelope tool has safe effect evidence now, and every stage has an envelope" (§8; this covers versions confirmed before WT-15 landed and their attachments, Q6). The shipped store enforces the same limit in two more places, which the same commit must change: `attachSchedule` and the template-file validation both refuse `schedule-requires-read-only` (`main/workflow-template-store.ts`). Left as they are, the store would refuse to attach, and then to load, any template file that holds a non-read-only attachment. Lead ruling: the one commit changes `attachSchedule` and the template-file validation together, and a test proves both lift together. This commit also owns the coordinated signature and consumer change for the qualification result (rev7 review, approved by the lead), all of it in the one commit: (1) `attachSchedule` takes the resolver as a fourth argument, calls `qualifyUnattended` inside its write queue and throws: for the two effect codes that code, with the tool on the error; for `unattended-not-read-only` the shipped `schedule-requires-read-only`, so a refusal at attach that names no tool keeps the one code the store has today. What that code refuses changes with this commit: before it, a version that is not all read-only, where an all-read-only stage with no envelope still qualifies; after it, a version with a stage that has no envelope (§7.2). The attach handler passes the resolver and returns the code and the tool. (2) Template-file validation stops refusing a file for an attachment's qualification, and asks neither half (lead ruling R27, which replaces the structural check that rev8 item 8 gave it). It never asks the resolver: effect evidence is a fact of the moment, and a server that is offline at boot must not make a template file fail to load. It does not refuse on `everyStageHasEnvelope` either: an attachment made under the interim limit for a version with a stage that has no envelope must not stop every template in the file from loading. The file loads, and that one attachment is refused where it is used: the schedule list reads `everyStageHasEnvelope` for the row state "needs a new version: add envelopes and confirm", and the one authority function refuses it at attach, at fire and before every spawn (§7.2). (3) The fire handler maps a start refused with an effect code to the skipped status and to the breaker outcome `skipped-unavailable` (§7.2, §11). (4) The start result, the settle event and the audit entry carry the tool (§2.2, §2.4). No consumer keeps a check of its own or a boolean. Lead ruling G1, a hard dependency: this item must not merge before WT-15's outward-effect resolver (§8) is on main. Until the limit is lifted, only all-read-only versions run unattended, and such a version has no MCP or plugin tool in any envelope (§7.2), so the gap P closes cannot be reached; lifting first would open it. The order is enforced by code, not only by this plan: the item adds a test that fails when `confirmDraft` has no resolver injected (below). |

Invariants: an unproven precondition never degrades to a weaker route; the profile's roots are never wider than the envelope plus the fixed toolchain roots; a lane session's egress list is never merged with another session's.

Tests (`permissions/__tests__/unattended-isolation.test.ts`): `builds the profile from the envelope and nothing else`, `each unproven reason blocks admission and spawns nothing`, `a host-route plan is refused for a lane session`, `an undeclared MCP tool is absent from the schema and a declared one is present`, `a declared tool that the resolver reports as outward or unknown is absent from the schema`, `the egress list is released at stage end`, `a private address is refused even when listed`. For the limit-lifting commit (`main/__tests__/workflow-template-capabilities.test.ts`, added case, red when only one of the two checks is changed): `a version with an envelope on every stage attaches, and the file that holds that attachment loads again; after the lift a version with a stage that has no envelope is refused at attach`. A template file that holds an attachment made before the lift for such a version still loads (R27); its tests are in the boundary item below. For G1, in the same file: `the confirm path the app wires hands confirmDraft an effect resolver, and with the resolver absent a version with an envelope tool still confirms, is marked tool-effect-unknown and is refused at attach with that code`. It is red on any tree where `confirmDraft` takes no resolver, so this item cannot go green before WT-15's resolver is on main.

Integration tests of the limit-lifting commit for the qualification result (`core/__tests__/work-board-unattended-qualification.test.ts`, a new file; each red before the commit, by file backup). They drive the real attach handler, fire handler and engine with a fake resolver whose answers the test changes:

- Attach (Q2): `attach of a version with an outward envelope tool is refused outward-effect-tool, the refusal names the tool, and no routine and no attachment are written`; the same for `tool-effect-unknown`.
- Fire (Q6): `a fire whose version has an envelope tool with unknown evidence is skipped with the status "skipped: <tool> unavailable" naming that tool, records tool-effect-unknown, creates no item and no child, and leaves the attachment active and not listed as needs reattach`; `two such firings in a row pause the schedule`; `when the tool has safe evidence again before the second firing, that firing runs and the count resets`.
- Spawn (Q6): `a run whose envelope tool turns unknown between two stages lets the live child finish, refuses the next spawn and settles cancelled with tool-effect-unknown and the tool on the settle event and in the audit entry`; the same for a tool that turns outward.
- Both the tool and the reason, at each place (lead ruling on the rev7 review): `for outward-effect-tool and for tool-effect-unknown, the attach refusal, the fire status record and the spawn settle event each carry the same code and the same stage, collection and tool name that qualifyUnattended returned`. One table test over the two codes and the three places; it fails if any of them drops the tool or replaces the code with `unattended-not-read-only`.
- The no-envelope case stays apart from the effect codes: `after the lift a version with a stage that has no envelope and no failing tool is refused schedule-requires-read-only at attach and unattended-not-read-only at fire and at spawn, each with no tool, and its fire is recorded as a failure, not as skipped`.
- The boundary of the lift (rev9 review, P3-1), one fixture on both sides: an all-read-only version with one stage that has no envelope. `with the interim predicate isAllReadOnlyVersion that version qualifies: it attaches, fires and spawns` (the test injects the interim predicate; it is green before the commit and stays green, so the interim contract is pinned). `with qualifyUnattended the same version is refused schedule-requires-read-only at attach and unattended-not-read-only at fire and at spawn, and the same version with an explicit empty envelope on every stage still qualifies` (red before the commit). For R27, with a template file that holds three templates, one of them with an attachment made under the interim limit for that version (the first and the last are pins: green before the commit and after it, and red only if file validation keeps the structural check; the others are red before the commit, and for the two that attach a version with envelopes that needs fixture versions that are not all read-only, which the interim limit refuses): `after the lift the file loads`; `that attachment is listed as needs a new version: add envelopes and confirm, in en and in ko, and never as needs reattach`; `its fire is refused unattended-not-read-only, creates no item and counts as a failed outcome toward the schedule breaker, and two such fires in a row pause the schedule`; `re-attaching the same version is refused schedule-requires-read-only, and the row's label names the new-version path`; `the other templates in the file stay usable: one with an envelope on every stage attaches and fires, and Create and run starts the other`; `a new version of the first template with an envelope on every stage attaches to the same routine and fires`; `the host changes no record of the refused attachment at load, at list or at fire`.
- Earlier versions (Q6): `a version confirmed before the resolver existed whose envelope names an outward or unknown tool is refused at attach, skipped at fire and cancelled at the next spawn, with the same codes, and is not re-confirmed or repaired`.
- File load: `a template file that holds an attachment of a version whose envelope tool is unknown at boot still loads`.

Real-sandbox checks (a home file is unreadable, an unlisted host is unreachable, no agent socket) are per-OS and belong to WT-13 with hostile fixtures.

Commit: `feat(permissions): unattended isolation profile`.

## 10. WT-17 — requested outputs (OD-4)

Files: new `src/work-board/workflow/requested-outputs.ts`, new `src/tools/stage-request-output.ts`; changed `stage-run-engine.ts` (the `RequestedOutputHooks` call sites exist from WT-3), `ipc/domains/work-board.ts` (`retry-output`); `shared/workflow-template-types.ts` (one member, `remote-not-configured`, added to `WorkflowTemplateErrorCode`); `src/i18n/messages/en.ts` and `ko.ts` (`reasonCodes.remote-not-configured`, the push failure texts and the push help text below).

```ts
// shipped at 51d5d582f (shared/workflow-template-types.ts, lead ruling R20); the first three are exported
type RequestedOutputKind = "upload" | "send-message" | "publish-post" | "external-write" | "other";   // the final closed list
interface RequestedOutputDecl {                                           // one template entry; every field is inside graphHash
  kind: RequestedOutputKind;                                              // labels and the gate card only; never used for matching
  toolName: string;                                                       // the exact tool name; no pattern, no prefix; ≤ 256 chars
  owner: "server" | "plugin" | "host"; ownerId: string }                  // server, plugin: the exact id of the MCP server or plugin that owns the tool; never starts with "host:"
                                                                          // host (C2): ownerId is exactly "host:git", toolName exactly "git_push", kind exactly "external-write"; no other host entry exists
// TemplateStage.requestedOutputs?: RequestedOutputDecl[]                 // ≤ 256 entries; stored sorted by owner, ownerId, toolName, kind; two entries with the same owner + ownerId + toolName refuse
interface RequestedOutput { id: string; decl: RequestedOutputDecl;       // a copy of the matched template entry
  args: string;                                                           // a canonical JSON string, ≤ 32 KiB UTF-8; hashed as these exact bytes
  files?: OutputFile[];                                                   // workspace-relative, hashed by the host at request time; ≤ 5 000 files, ≤ 512 MiB
  summary: string }                                                       // ≤ 400 chars, shown as untrusted text
// shipped but private to the module; the engine derives both (§2.2). Validated on the board by work-board/template-run-fields.ts
//   OutputFile      = { path: string; sha256: string; size: number }
//   OutputExecution = { id: string; status: "pending" | "done" | "failed" | "denied"; at?: string; detail?: string }   // detail ≤ 8192 chars
// shipped (work-board/template-graph.ts): the one strict parser of an entry, used by the graph and by the board
function parseRequestedOutputDecl(raw: unknown): RequestedOutputDecl;    // throws on a missing or unknown field, an old kind string, a bad host triple, a "host:" id under server or plugin

// WT-17
function declaredOutputOf(stage: TemplateStage, toolName: string, owner: "server" | "plugin" | "host", ownerId: string): RequestedOutputDecl | undefined;
// string equality on all three against the pinned stage's entries; the only matching there is
interface RequestedOutputHooks {
  accept(a: { stage: TemplateStage; workspaceRoot: string; raw: unknown }): { ok: true; output: RequestedOutput } | { ok: false; code: OutputRefusal };
  execute(a: { run: RunRef; stageId: string; output: RequestedOutput; approvalSurface: WebContents | null }): Promise<OutputExecution>;
}
type OutputRefusal = "output-not-declared" | "remote-not-configured" | "too-many" | "args-too-large" | "file-outside-workspace" | "file-unreadable" | "needs-human-gate";
const MAX_REQUESTED_OUTPUTS = 10;
```

The kind-only list, `OutputKindDecl` and the old kind values of the first WT-2 head are gone. A graph or a board record in an old shape refuses; there is no migration, because no released file holds one.

Four different things carry the word "outputs". They are kept apart:

| Name | Where | Meaning |
| --- | --- | --- |
| `TemplateStage.outputs?: string[]` | graph | Folder-kind collection globs (§3.3). Nothing to do with this item. |
| `StageEnvelope.outputs` | graph, default `["branch"]` | `"branch"` is the stage's result on the run branch or in the run output folder (§3); it is not a requested output and needs no approval of its own. The shipped type also lets it hold `RequestedOutputKind` labels. At `51d5d582f` they stay as metadata with no authority: a kind here grants nothing and no check reads it, so the engine reads only the entries below. One shipped side effect remains: `isAllReadOnlyVersion` needs this list to be empty (§7.2). |
| `TemplateStage.requestedOutputs?: RequestedOutputDecl[]` | graph | What the stage may request: one entry per exact tool, with its kind and owner id. With or without an envelope, this is the only list the engine matches against. |
| `WorkItemStageRun.requestedOutputs?: RequestedOutput[]` | board | What the stage actually requested in this attempt. At most 10. |

Declaration and matching (lead ruling R20):

- There is no host table from tool names to kinds, and no plugin-specific branch (an `AGENTS.md` invariant). The template says what each output is: every `requestedOutputs` entry declares `kind`, the exact `toolName` and the owner id of its server or plugin.
- All three are inside `graphHash`, so the target tool is confirmed with the version and a changed entry is a new version. Arguments and files are not in the graph. They are bound at the gate by `outputHash`.
- The engine matches by exact `toolName` + owner id only, never by pattern, prefix, kind or name similarity. `accept` refuses `output-not-declared` unless `declaredOutputOf` finds an entry of the pinned stage. Two tools with the same name under different owners are different targets.
- `kind` drives labels and the gate card only. It never widens or narrows what matches.
- A call to a tool that is not declared as a requested output and is not in the envelope is denied when the run is unattended (§8 step 6, `outside-envelope`). With a person present it goes to the normal permission tree (R13).
- "A stage that declares outputs" means its `requestedOutputs` is not empty.
- `output-not-declared` is confirmed by the lead. The code and its en and ko message (`reasonCodes.output-not-declared`) shipped at `51d5d582f`, but nothing there can produce it: no store operation matches a request. WT-17 must emit it: `accept` returns it as the request's `reasonCode`, the execution-time match returns it again, and a test reaches it (below).
- What WT-17 must call or keep, from the WT-2 handoff: match by exact `toolName` + `owner` + `ownerId` at request and at execution; use `kind` for labels only; keep the `resultHash` and `outputHash` approval binding; copy the matched entry into `RequestedOutput.decl`, which the board validates with `parseRequestedOutputDecl`.

The git push target (lead choice C2, lead ruling R22):

- A push is declared like any other requested output, as one exact entry: owner `host`, owner id `host:git`, tool name `git_push`, kind `external-write`. The entry is inside `graphHash` with the rest of the stage. This is the shipped shape at `51d5d582f`; the earlier `{ kind: "git-push" }` declaration is gone.
- `host:git` is an engine-owned owner id. It is not a server and not a plugin, and nothing can register under it. Matching is the same string equality as for every other entry, so this is one declared target and not a host table from tool names to kinds: the rules above and the invariant below hold unchanged.
- `git_push` is not a tool. It is in no tool registry and in no model tool schema, for any session, attended or unattended. A stage asks for a push only by recording a request with `stage_request_output`, which executes nothing.
- The engine performs the push itself, after the human gate was approved with matching `resultHash` and `outputHash`, and never before. It is a host git call through `host-git.ts` (§3.2). No model turn is involved and no tool call is created, so the gate approval is its approval.
- The `host:` owner prefix is reserved, as a namespace of its own with no alias:
  - All three refusals shipped at `51d5d582f`, each with its test; none is left for the engine.
  - Plugin: the manifest name grammar (`schemas/plugin-manifest.schema.json`) admits no `:`, so a manifest named `host:git` fails shape validation. The spoofing test goes through the real validator (`src/plugins/__tests__/agent-plugin-manifest.test.ts`).
  - MCP server: `validateServer` (`src/mcp/mcp-governance.ts`) refuses a server id that starts with `host:` before any other check, with an en and a ko message (`be_mcpGovernance.reservedHostOwner`).
  - Template: `parseRequestedOutputDecl` refuses a `server` or `plugin` entry whose owner id starts with `host:`, and a `host` entry that is not exactly the entry above.
  - A refused id is refused. It is never renamed, mapped or treated as another owner.
- Lanes: the entry shape, the template validation and the three refusals are WT-2's and shipped (§13.1). The engine push after the gate is WT-17's.

Which remote, which ref and whose credentials (lead ruling R22). The ruling allows the engine push to use the git credentials the user already configured, inside these bounds. It replaces the rev5 default, which used no credential helper.

- Remote. The stage asks with exactly `{ "remote": "<name>" }`, and `<name>` is a remote that is already configured in the project repository. Any other key, a `url` included, is refused `remote-not-configured`. The engine never adds or edits a remote. The only URL it ever hands git is the one it resolved from that configured remote and compared with the approved one (below).
- URL binding (lead ruling, push detail 2; execution as ruled in Q5). At request, `accept` resolves the push URL of that remote with `git remote get-url --push <remote>`, strips the secrets from it (next item), and stores `args` as the canonical JSON `{ "remote": "<name>", "url": "<resolved URL without secrets>" }`. Before it stores anything, `accept` runs the rewrite guard below on that URL, and a request that does not pass is refused `remote-not-configured` (lead ruling on rev10). `args` is inside `outputHash` as its exact bytes, so the approval binds the remote name and the URL the card showed. It uses the shipped `args` field and `outputHashOf` as they are, and no shape changes. Storing the URL in `args` is this plan's mechanism for the ruled binding; it is not a separate lead acceptance (§14.1). At execution the host resolves the URL the same way and strips it again. If it differs from the approved `url`, the execution ends `failed` with "push failed: remote URL changed" and nothing is sent. If it is equal, the rewrite guard below runs, and only then the engine pushes to that compared URL itself: `git push <url> <refspec>`, with the one refspec below, and not to the remote name (lead ruling Q5). Git therefore does not look the remote up again, and a change to the remote's own URL after the compare cannot move the push. That alone does not bind the endpoint, because git also applies rewrite rules to a URL it is given; the guard covers that. The remote name is still required and still checked: it is how the URL is found, and a remote that is not configured is refused before any of this.
- One push URL (lead ruling on rev9). The host reads every push URL of the remote, with `git remote get-url --push --all <remote>`, at request and again at execution. A remote with more than one push URL is refused `remote-not-configured`: at request nothing reaches the gate, and at execution the push ends `failed` with that code and nothing is sent. The engine never picks one of several URLs.
- What is stripped (lead ruling R26). Only secrets are removed from the resolved URL, and one function does it for the stored value, the card, the compare and the git call:
  - `http` and `https`: the whole user-info part is removed. A password is a secret, and a lone name there can be a token, so it is not kept.
  - `ssh://` and the scp form (`git@example.com:team/repo.git`): the user name is kept. It is not a secret: it selects the account on the server, and the key stays in the user's agent. A password part of an `ssh://` URL is removed.
  - Any other scheme: the whole user-info part is removed.
  - So the bound URL, the displayed URL and the URL git is given are one string, and an SSH remote is contacted with the user its configuration names.
- URL rewrite rules (lead ruling on rev8; it replaces the rev8 caveat). The bound and displayed URL is the post-rewrite push URL: `git remote get-url --push <remote>` reports the remote's push URL with the configured `insteadOf` and `pushInsteadOf` rules already applied. At execution the host resolves it with the same command, strips it the same way and compares it with the approved `url`. A rule that changes what the remote resolves to after the approval gives another resolved URL, so the execution ends `failed` with "push failed: remote URL changed". WT-17 proves both with a rewrite rule in the repository's configuration (tests below). Equal URLs are not enough by themselves, which is what the guard is for.
- Rewrite guard (lead ruling on the rev9 review; it replaces the fixed-point probe of the rev9 ruling). Git applies `insteadOf` and `pushInsteadOf` rules to a URL given on the command line as well. When U is reached through an earlier rule, or through an explicit `pushurl` for a `pushInsteadOf` rule, a rule on U that was added after the approval leaves the remote's resolved URL equal to the bound one and would still send the push elsewhere. So would a second rule that U already matches. When the remote's configured URL is U itself, such a rule changes the resolved URL and the compare refuses first. So the compare alone does not bind the endpoint. The guard runs twice (lead ruling on rev10): at request, and again at execution whatever the request found, because a rule can appear after the approval. With U the bound URL, the execution runs these steps in this order, and nothing else runs between them:
  1. Resolve the remote's push URL again, strip it, and compare it with U (above).
  2. Read the effective rewrite rules: `git config --includes --get-regexp '^url\..*\.(insteadof|pushinsteadof)$'`. It runs in the same working directory, with the same environment and the same `HOME`, as the push, and immediately before it. It therefore sees exactly the configuration the push will see: system, global, repository and worktree files, command-scope entries from the environment, and every include, a conditional include that applies only inside the project directory among them.
  3. Refuse when any value that the read returns is a literal prefix of U. The comparison is case-sensitive and byte for byte, with no normalisation. Any match refuses, not only the longest one that git would pick, and a rule of either kind refuses.
  4. `git push <U> <refspec>`.
  - At request, `accept` runs steps 2 and 3 on the URL it has just resolved and stripped, in the working directory, the environment and the `HOME` that the push will use. A value that is a prefix of that URL refuses the request `remote-not-configured`, and nothing reaches the gate. So a request that reaches a gate had no matching rule when it was made.
  - The read has three results and no others (lead ruling on rev10). Exit 0: the output is parsed as lines of key and value, and those are the rules. Exit 1 with empty output: git's answer when no key matches, so there are no rules. Everything else is a read failure: exit 128 (git could not read its configuration), any other exit code, exit 1 with output, output that cannot be parsed as key and value, a timeout, or a read that could not be started. A read failure is never taken as "no rules".
  - A resolve of step 1 that fails is told apart the same way. A name that is not in the repository's remote list is an unknown remote (`remote-not-configured`, below). Any other failure of the resolve, a configuration file that git cannot parse among them, is a configuration read failure. The lead accepted this classification (R28, §14.1).
  - What each failure shows at execution (lead ruling on rev10). A compare mismatch in step 1 ends the execution `failed` with "push failed: remote URL changed". A guard refusal in step 3 and a configuration read failure end it `failed` with "push failed: push URL could not be verified". The first text is used for a compare mismatch only. In every case nothing is pushed, and it is not retried (push detail 1).
  - What each shows at request: a guard refusal is `remote-not-configured` (ruled). A read failure at request is refused with the same code, so that it fails closed with no new code (R28, accepted by the lead, §14.1).
  - The guard does not use `git ls-remote --get-url`: that applies `insteadOf` only and misses a `pushInsteadOf` rule (rev9 review, P2-1).
  - Nothing is disabled. The push runs with the user's configuration as it is, so the credential helper and the SSH setup keep working (R22). The engine passes no configuration override to turn rewriting off.
  - Two refusals follow from the rule and are intended. Stripping can make U match a rule that the unstripped URL did not match. A rule whose value is a prefix of its own result is matched by U every time. Both are now met at request and refused `remote-not-configured`, so such a remote cannot be pushed by the engine. Either is refused at execution too, when the rule appears only after the approval.
  - Accepted residual, recorded narrowly (lead ruling): the user's own edit of the git configuration between step 2 and step 4. The window is the time between two consecutive host calls in one function. A rule that exists when step 2 runs, wherever it comes from, is caught. No other gap is accepted.
- `remote-not-configured`. A request whose `remote` is a URL, a path, or a name the repository does not have is refused with this code. It is checked twice (push detail 3: refused at request, and failed at execution):
  - At request: `accept` refuses it, so nothing reaches the gate. A run whose workspace is not the git kind has no repository and no remote, so this refusal covers a folder-kind run too.
  - At execution: the host looks the remote up again, because the repository can change after the request. A remote that is no longer configured ends the execution `failed` with the same code, and nothing is sent.
  - A remote with more than one push URL is refused with the same code at both places (above).
  - A request whose bound URL matches a rewrite rule is refused with the same code at request, and so is a request whose rule read failed (the guard above). At execution the same two findings are not this code: they end the push `failed` with "push failed: push URL could not be verified".
- The card. The gate shows the remote name, the push URL the host resolved for it from the repository's configuration, and the branch. The URL is the `url` of the stored `args`, the one `outputHash` binds: the post-rewrite push URL, with no secret in it. An ssh or scp-form user name is shown as part of it.
- Ref. Only the run branch is pushed, to the branch of the same name on the remote: the one refspec `refs/heads/ave/workflow/<run>:refs/heads/ave/workflow/<run>`. No force in any form (no force flag, no lease, no `+` refspec), no tags (tag following is off for the call), no other ref, no deletion and no mirror.
- Who pushes. The host engine, through the one push function in `host-git.ts` (§3.2). A stage, a grandchild and the model never run it and never see it (C2 above).
- Credentials. The push uses the user's own credential helper or SSH agent, as the user's git would. Because git is given the URL, the helper and the agent resolve the credential by that URL (Q5). The URL carries no secret; an ssh or scp-form URL still carries its user name, so the agent is asked for the same account as a push by remote name (R26). It runs with `GIT_TERMINAL_PROMPT=0` and with `GIT_ASKPASS` unset, and nothing may prompt: a push that would have to ask for a user name, a password or a passphrase fails instead. The engine supplies no credential, reads none and stores none.
- Not supported: https configuration that depends on the user name in the URL (rev9 review, P3-2; lead ruling). The whole https user-info part is stripped (R26), so git and the helper are asked with a URL that has no user name. A credential setting scoped to a URL with a user name, a helper that tells two accounts on one host apart by that name, and a rewrite rule whose prefix contains a user name do not apply to the engine push as they do to the user's own push by remote name. The plan does not claim that the two reach the same account over https. The outcome is bounded instead: the push uses the credential the configuration gives for the URL without a user name, or it ends `failed` with "push failed: authentication". It does not prompt, it is not retried, and no credential is disclosed. A user who needs one of several https accounts on a host uses an SSH remote, whose user name is kept, or a helper keyed by path. The engine offers no way to put the name back.
  - The limitation, stated plainly (lead ruling on rev10): with several https accounts on one host, the engine push cannot choose between them. Use an SSH remote, or a credential helper keyed by path (`credential.useHttpPath`).
  - User-facing help must say so. WT-17 adds one help string in en and ko, and shows it on the gate card of a push whose bound URL is `http` or `https`, and beside "push failed: authentication". The template editor shows the same string where a push output is declared (UI lane; it adds no second wording). The lead accepted the three places (R29, §14.1):
    - en: "With several HTTPS accounts on one host, use an SSH remote or a credential helper keyed by path."
    - ko: "한 호스트에서 HTTPS 계정을 여러 개 쓰는 경우 SSH 원격이나 경로별 자격 증명 도우미를 사용하세요."
- Where credentials never appear: in a stage session or its environment (§9 keeps the stage's own environment scrubbed, with no credential helper and no agent socket), in anything given to the model, in a log line, in the audit log, and in the run record.
- The record (push detail 4). The execution stores only the remote name, the host part of the URL, the branch, the pushed commit SHA and the exit result. They go into the shipped `OutputExecution.detail` as one canonical JSON string (≤ 8192 characters); no field is added. The record holds no credential. It repeats only the URL's host; the approved URL, its secrets already stripped, is in the request's `args`, where an ssh or scp-form user name may appear because it is not a secret (R26).
- Failures. Each of these ends the execution `failed`, sends nothing more and is not retried:
  - Authentication: the card shows "push failed: authentication" with git's own message, sanitized (user-info parts of URLs and credential-shaped values removed by the existing redaction, bounded by `detail`).
  - A run whose workspace is not the git kind.
  - An unknown remote (`remote-not-configured`, above).
  - A remote whose resolved URL no longer equals the approved one (push detail 2): "push failed: remote URL changed". Nothing else shows this text.
  - A rewrite rule whose value is a prefix of the approved URL, or a configuration read that failed (the guard above): "push failed: push URL could not be verified".
  - A remote with more than one push URL (`remote-not-configured`).
  - A non-fast-forward: the remote branch exists and does not contain the run branch's history. Nothing is forced.
- No retry (lead ruling, push detail 1). One approval pushes at most once. The engine never repeats a push by itself, and `retry-output` refuses a `host:git` output. A new push needs a new request and a new gate.
- Strings. `remote-not-configured` is a new code: WT-17 adds it to `WorkflowTemplateErrorCode` and adds `reasonCodes.remote-not-configured` in en and ko, in the same commit as the check and its test. WT-17 also adds the en and ko text of "push failed: authentication", the help string above, and the two push URL failure texts (lead ruling on rev10; the ko texts are accepted, R29):

  | Shown for | en | ko |
  | --- | --- | --- |
  | A guard refusal, or a configuration read failure, at execution | "push failed: push URL could not be verified" | "푸시 실패: 푸시 URL을 확인할 수 없음" |
  | A compare mismatch at execution, and nothing else | "push failed: remote URL changed" | "푸시 실패: 원격 URL이 변경됨" |

Behaviour:

- `stage_request_output` is a builtin given only to a stage child whose pinned stage declares outputs. It records data and executes nothing, so it is read-tier and never asks.
- The requested outputs are part of the stage run. `outputHash = outputHashOf(output, requestedOutputs)` (shipped, §2.2) binds their approval: it changes when the output text, any request, or the order of the list changes; `args` enters as its exact stored bytes. The stage gate itself is bound by `resultHash` (§2.6). Lead ruling R16: a gate on a stage with requested outputs carries both hashes, and a mismatch on either refuses, so approving the gate is the requested-output approval. The gate shows each one in full: kind, tool name, owner id, arguments, files.
- `outputHash` is recomputed by the host from the stored stage run whenever it is checked. It is not a stored field: at `51d5d582f` the stage run stores `resultHash` only.
- A stage that declares outputs must have a human gate. At `51d5d582f` WT-2 refuses the version at confirm when `stage.requestedOutputs` is not empty and the gate is not human (`outputs-need-human-gate`), with or without an envelope. The engine's own refusal (`needs-human-gate`) stays as the second check.
- On approve, the stage is `passed` and the host executes each output as a new host call to exactly the declared tool of the declared owner, through the ordinary tree, with the deciding window as the approver, so each can still ask. It is not a replay: no tool call was parked. Files are hashed again first; a mismatch is `failed` and nothing is sent. The `host:git` entry is the one exception to "a host call to a tool": the engine runs the push itself, as described above.
- An execution that fails or is denied does not change the stage. `retry-output` reruns one output under the same approved `outputHash`. It refuses a `host:git` output: a failed push is not retried (push detail 1, above).
- The lane session never executes an output. In an attended run a stage may still call an outward tool directly through cards; requested outputs are optional there (R13).

Invariants: nothing executes before an approve whose `outputHash` matches; executed arguments are byte-equal to the hashed ones; a target whose tool name and owner id do not equal an entry of the pinned stage is refused at request and again at execution; no code path maps a tool name to a kind; `git_push` is in no tool schema and no model call reaches the engine push; no plugin or MCP server holds an id that starts with `host:`; an output is executed at most once per approval unless the user retries it, and a push at most once per approval with no retry; a push request names a remote the repository already has and never a URL; a push request names a remote with exactly one push URL; a push goes out only while that remote's post-rewrite push URL, secrets stripped, equals the one `outputHash` bound, and only when the rewrite rules read immediately before it, in the push's own working directory and environment, hold no value that is a prefix of that URL; a failed read of those rules never counts as no rules, and exit 1 with empty output is the only result read as no rules; no push request reaches a gate while a rule read at request holds a value that is a prefix of its bound URL, or while that read failed; "push failed: remote URL changed" is shown for a compare mismatch only, and a guard refusal or a configuration read failure never shows it; git is given exactly that compared URL, never a remote name that it resolves again; the one accepted exception to "the push reaches the bound URL" is the user's own configuration edit between that read and the push; a push moves only `ave/workflow/<run>` to the same-named remote branch and never forces; no credential, and no password or token from a URL, reaches a stage, the model, a log or the run record; an ssh or scp-form user name is never treated as a secret and never stripped.

Tests (`work-board/workflow/__tests__/requested-outputs.test.ts`): `records an output and executes nothing`, `refuses a tool the stage does not declare with reasonCode output-not-declared, which has an en and a ko message`, `refuses a declared tool name under another owner id`, `refuses a name that only starts with or contains a declared tool name`, `the kind of an entry does not change what matches`, `changing an entry's kind, tool name, owner or owner id changes graphHash` (already proven for the shipped shape in `src/main/__tests__/workflow-template-authority.test.ts`; WT-17 does not repeat it), `outputHash changes when an output changes and resultHash does not`, `an approve with the right resultHash and a stale outputHash is refused`, `approve executes each output once through the permission check`, `a file changed after the request is not sent`, `a rejected gate executes nothing`, `a failed output leaves the stage passed and can be retried under the same hash`; `core/__tests__/work-board-stage-outputs.test.ts`: `a scheduled run ends at the gate with outputs pending and nothing sent`, `an undeclared outward call is denied in a scheduled run and raises a card in an attended one`. For the push (C2), in `requested-outputs.test.ts`: `a declared host:git git_push entry is pushed by the engine once, after an approve with matching hashes, and not before`, `a rejected gate pushes nothing`, `git_push is in no tool schema of a stage child or a grandchild`, `a call to a plugin tool named git_push does not match the host:git entry`. The spoofing tests shipped with WT-2 (§13.1).

For the push bounds (R22), the five tests of the ruling, in `work-board/workflow/__tests__/requested-outputs-push.test.ts`, against a local bare repository as the remote:

1. `a push to a configured remote sends only ave/workflow/<run> to the same-named remote branch, with no tag and no other ref`.
2. `a request that names an unknown remote, or a URL, is refused remote-not-configured, which has an en and a ko message, and nothing is sent`.
3. `a push whose remote branch has diverged is not forced: it ends failed as a non-fast-forward and the remote branch is unchanged`.
4. `a push that would need a credential prompt fails with "push failed: authentication" and does not hang` (the call runs with `GIT_TERMINAL_PROMPT=0` and no `GIT_ASKPASS`, under a timeout that fails the test).
5. `after a push through a credential helper, and after a failed one, the run record, the audit log and the logs hold no credential and no password or token from a URL; the record holds only the remote name, the URL host, the branch, the pushed SHA and the exit result`.

With them, for the cases the ruling lists as failures: `a push request in a folder-kind run is refused at request, and an execution of one ends failed and sends nothing`, `a remote removed after the approval ends the execution failed remote-not-configured`, `retry-output refuses a failed push`. For the push details: `one approval pushes at most once: a second execution and retry-output both send nothing` (1), `the stored args hold the resolved URL without its secrets, and another URL gives another outputHash` (2), `an https remote URL that carries a token is bound, shown and pushed without it, and the token is in no record and no log` (R26), `an ssh:// remote and an scp-form remote keep their user name in the bound URL, on the card and in the git call` (R26), `a remote whose URL was changed in the repository after the approval ends the execution failed with "push failed: remote URL changed" and sends nothing` (2), `a request that carries its own url is refused` (2), `the git call of a push is given the compared URL and the one refspec, and no remote name` (Q5), `a remote whose URL is changed in the repository after the compare and before git runs still pushes to the approved URL and nothing reaches the new one` (Q5; the push function takes an injected step after its guard and before its git call, a test seam only, the test uses it to change the configuration, and two local bare repositories are the two endpoints), `the push record is canonical JSON in OutputExecution.detail and holds no credential` (4). Detail 3 is the first two tests of this paragraph. For the rewrite rules (rev8 ruling), with an `insteadOf` rule and with a `pushInsteadOf` rule in the repository's configuration, two local bare repositories as the endpoints: `with a rewrite rule the bound and displayed URL is the rewritten push URL, and the push reaches exactly that endpoint`, `a rewrite rule added, removed or changed after the approval ends the execution failed with "push failed: remote URL changed" and nothing is sent`. In these two kept tests the endpoint paths are chosen so that no rule's value is a prefix of the bound URL; otherwise the guard would refuse the request of the first one. Each rule of the second test is a prefix of the remote's configured URL, so it changes what the remote resolves to: that test is about the compare, and it asserts that the text is not the guard's.

For the rewrite guard (lead rulings on the rev9 review and on rev10), in the same file. Two local bare repositories are the endpoints: E1, which U names, and E2, which a rewrite of U would reach. U is the bound URL.

Rev10's fixtures for cases 1, 2 and 5 were wrong. The remote's configured URL was U itself, so a rule on U that was added after the approval also changed what the remote resolves to. The compare of step 1 refused, and the guard was never reached. The fixtures below make the guard the step that refuses. They hold for the execution-time refusals whose U is reached this way: cases 1, 2 and 5 and the first half of 6. The letter-case half of 6 is a pass-through: it asserts only that the push reaches U and that E2 has no ref. The second half of 8 reaches U by stripping, not through rule A or a `pushurl`; it makes the five assertions on its own fixture.

- How U is reached. For `insteadOf`: the remote's configured URL is an alias (`alias:e1.git`), and a rule A that exists at approval rewrites the alias to U. For `pushInsteadOf`: the remote has an explicit `pushurl` equal to U. Git does not apply `pushInsteadOf` to a remote that has an explicit push URL, and does apply it to a URL given on the command line.
- The new rule B is added after the approval. Its value is U and its base is E2's path, so a rewrite of U is exactly E2. Its value is not a prefix of the remote's configured URL, and git rewrites a URL once, so B does not change what the remote resolves to.
- When the request is made, no value is a prefix of U, so the request passes the guard and reaches the gate.
- Each of these cases asserts five things. (a) The compare passed: after the fixture change the test itself runs `git remote get-url --push <remote>`, strips the result and gets U. (b) The execution ends `failed` with "push failed: push URL could not be verified", and not with "push failed: remote URL changed". (c) E1 has no new ref. (d) E2 has no ref at all. (e) The fixture is live: with the execution guard removed (file backup, no stash) the same setup delivers the ref to E2.
- These three fixtures were run against git 2.56 before this revision: in each the remote still resolved to U and a push to U arrived at E2.

1. `an insteadOf rule whose value is a prefix of U, added after the approval, leaves the remote's resolved URL equal to U, is refused by the guard, and no repository receives a ref` (U through rule A).
2. `a pushInsteadOf rule whose value is a prefix of U, added after the approval, leaves the remote's resolved URL equal to U, is refused by the guard, and no repository receives a ref` (U from an explicit `pushurl`).
3. `when U is the result of an insteadOf rule and matches a second insteadOf rule at request, the request is refused remote-not-configured and nothing reaches the gate`.
4. `when U is the result of a pushInsteadOf rule and matches a second pushInsteadOf rule at request, the request is refused remote-not-configured and nothing reaches the gate`. Cases 3 and 4 are request-time cases since the guard runs at request: both rules exist when the request is made. Each proves its fixture with the request guard removed: the request is then accepted with U bound, and its execution is refused by the guard as in case 1 or 2.
5. `a rule that comes from a conditional include which applies only inside the project directory, added after the approval, leaves the remote's resolved URL equal to U, is refused by the guard, and the same read from another directory does not see it` (U through rule A in the repository's configuration; after the approval the fixture global file selected by the test's `HOME` gains the include, and the included file holds rule B; the last part runs the same read outside the project directory, gets exit 1 with empty output, and so proves that the read must run in the push's working directory).
6. `a rule that matches U but is not the longest match still refuses` (two rules added after the approval), and `a rule whose value differs from the start of U only in letter case does not refuse, and the push reaches U`.
7. The rule read (lead ruling on rev10). The push function and `accept` take their git runner as a parameter, a test seam only; production passes the real one. A configuration file that git cannot parse cannot be the fixture for a failed read, because it makes the resolve of step 1 exit 128 first, and the read is never reached. So the read-failure cases wrap the real runner and replace only the result of the rule read; the resolve and the push stay real, and each case asserts that the resolve returned U.
   - `with no rewrite rule at all the read exits 1 with empty output, is read as no rules, and the push reaches U` (the real runner).
   - `a rule read that exits 128 ends the execution failed with "push failed: push URL could not be verified" and pushes nothing`.
   - The same, as one table test, for `another exit code`, `exit 1 with output`, `output that cannot be parsed`, `a timeout` and `a read that could not be started`.
   - At request: `a rule read that exits 1 with empty output lets the request through`, and `a rule read that exits 128, or fails in any other way, refuses the request remote-not-configured and nothing reaches the gate`.
   - With the real runner: `a configuration file that git cannot parse, written after the approval, ends the execution failed with "push failed: push URL could not be verified" and pushes nothing` (the resolve is what fails here; R28, §14.1).
8. `an https remote whose URL has a user name, with a rule on the URL without it at request, is refused remote-not-configured: the rule does not match at resolution and matches the stripped U` (the post-strip case of the rev9 review, P3-2), and `the same rule added after the approval leaves the remote's resolved URL unchanged and is refused by the guard`.

For the two texts and the help string (lead ruling on rev10), in the same file: `"push failed: push URL could not be verified" and "push failed: remote URL changed" each have an en and a ko message`, `a compare mismatch never shows the guard's text, and a guard refusal and a read failure never show "push failed: remote URL changed"` (one table over the cases above), `the https accounts help text has an en and a ko message`, `the gate card of a push to an https remote shows the help text, and the card of a push to an ssh remote does not`.

For more than one push URL (lead ruling on rev9): `a remote with two push URLs is refused remote-not-configured at request and nothing reaches the gate`, and `a second push URL added after the approval ends the execution failed remote-not-configured and neither bare repository receives a ref`.

For https user names (rev9 review, P3-2), `requested-outputs-push-accounts.test.ts`. The fixture holds no real credential and reads none: a local http endpoint that the test starts on a loopback address, two synthetic account contexts `alice` and `bob` with made-up secrets, a fixture credential helper script that logs every request it gets, and a fixture `HOME` whose configuration scopes one credential setting to the URL with `alice@`. The remote's URL carries `alice@`. `the push of a remote whose https URL names alice asks the helper with the URL without a user name, and ends in one of two ways: it uses the credential the fixture configures for that URL, or it ends failed with "push failed: authentication"`; in both, `git never prompts and the call ends inside the timeout`, `the helper is asked for one push attempt and nothing is retried`, `bob's secret is never sent to the endpoint`, and `neither secret is in the run record, the audit log, the logs or the card text`. With them: `the authentication failure shows the https accounts help text`.

Commit: `feat(work-board): requested outputs executed after the human gate`.

## 11. WT-18 — budgets and schedule breakers

Files: new `src/work-board/workflow/run-budget.ts` (pure), new `src/work-board/workflow/schedule-breaker.ts` (pure); changed `stage-run-engine.ts` (timer and counters behind `LaneHooks.onDenied`), `boot/steps/routines-wiring.ts` (`mayFire` in WT-8's handler), `main/routines-store.ts` (breaker state on the routine record).

```ts
interface StageUsage { rounds: number; startedAt: number; costUsd?: number; denials: number }   // stored as WorkItemStageRun.usage, where startedAt is an ISO string
type BudgetVerdict = { ok: true } | { ok: false; code: "rounds" | "minutes" | "cost" | "denials" };
// budget is the shipped { rounds: number; minutes: number; costUsd: number }: all three required, costUsd finite and ≥ 0
function checkStageBudget(usage: StageUsage, budget: StageEnvelope["budget"], now: number): BudgetVerdict;
const MAX_LANE_DENIALS_PER_STAGE = 3;
interface ScheduleBreakerState { consecutiveBad: number; pausedAt?: string }
function nextScheduleState(prev: ScheduleBreakerState, outcome: "completed" | "failed" | "parked-on-denials" | "skipped-unavailable"): ScheduleBreakerState;   // pauses at 2
// skipped-unavailable (Q6): a firing skipped because an envelope tool was outward or unknown at fire (§7.2). Bad, like the two before it
function mayFire(a: { unsettledRun: boolean; paused: boolean }): { fire: true } | { fire: false; reason: "run-unsettled" | "paused" };
```

| Limit | Enforcement |
| --- | --- |
| Rounds | `maxRounds` on the spawn (`subagent-runner.ts:197`) = `budget.rounds`. |
| Minutes | An engine timer per stage; on expiry `interruptRun` and the stage is `failed`, `failure: "budget"`. |
| Cost | `budget.costUsd` is always declared (required in the envelope). It is enforced only when `usage.costUsd` is known, which needs a per-child cost source that does not exist yet (F13, R11). Until then the declared limit is shown but not enforced, and the confirm screen must say so. |
| Denials | The third lane denial in a stage ends it `failed` and the run waits with the denied calls listed (tool name and reason code only). |
| One run at a time | Per schedule. A fire is skipped while any run of the routine is unsettled, whichever of its attachments started it, a run that only waits at a gate included. The scan and its serialized path are WT-8's (§7.2); `mayFire` takes that result as `unsettledRun` and is called inside the same serialized step. |
| Pause | After two consecutive bad outcomes the routine is paused (`routines-store.ts:775`) until the owner resumes it. Bad is a `failed` run, a `parked-on-denials` run, or a firing skipped "skipped: `<tool>` unavailable" (`skipped-unavailable`, lead ruling Q6); they share the one counter, so one of each in a row also pauses. A run that waits at a human gate is not "bad". A firing skipped `run-unsettled` or `paused` is not an outcome and leaves the count as it is. This item lands the outcome member; the fire handler produces it from WT-16's limit-lifting commit on, which merges after this item (§12). |

Budgets apply to unattended runs only; attended runs keep today's round budget. Retry stays manual.

Tests (`work-board/workflow/__tests__/run-budget.test.ts`, `schedule-breaker.test.ts`): `each limit fails the stage with its code`, `the third lane denial ends the stage and lists the calls`, `a grandchild's rounds and denials count against its stage`, `mayFire refuses run-unsettled when the schedule-wide scan reports an unsettled run`, `two bad runs pause the schedule and a completed run resets the count`, `a run waiting at a gate does not count as bad`, `two skipped-unavailable firings in a row pause the schedule, one followed by a completed run does not, and a run-unsettled skip between them changes nothing` (Q6).

Commit: `feat(work-board): stage budgets and schedule breakers`.

## 12. Order and parallelism

PR-B, in build order: WT-3 → (WT-4, WT-5, WT-7 together) → (WT-6, WT-8 together). PR-E after PR-B: WT-15, WT-16 and WT-17 are built together. WT-15 merges first, with its outward-effect resolver (ruling P, §8). WT-16 merges only after that resolver is on main (lead ruling G1). Then WT-18, and the limit-lifting commit of WT-16 last.

| Item | PR | After | Parallel with | Files it owns alone | Shared files it touches |
| --- | --- | --- | --- | --- | --- |
| WT-3 | B | PR-A (WT-1, and WT-2 at `6942aca82`, which includes the finished follow-up and the review-2 fixes of §13.1) | — | `src/work-board/workflow/*` except the files named below; `workflow-engine-extensions.ts`; `work-board-stage-run.test.ts`, `work-board-stage-revoke.test.ts` | `work-board-engine.ts`, `work-board-store.ts`, `work-board-types.ts`, `work-board-lifecycle.ts`, `ipc/domains/work-board.ts`, `ipc-channels.ts`, preload, `subagent-runner.ts`, `parent-directive.ts`, `conversation-wiring.ts`; two new types in `shared/workflow-template-types.ts` (`EnvelopeToolRef`, `UnattendedQualification`); en/ko |
| WT-4 | B | WT-3 | WT-5, WT-7 | `stage-workspaces.ts`, `workspace-layout.ts`, `workspace-seed.ts`, `host-git.ts`, `permissions/stage-workspace-binding.ts`, their tests, `work-board-stage-isolation.test.ts` | `ave-home-read-boundary.ts`, `asrt-sandbox.ts`, the floor consumer in `permission-manager.ts` (one guarded call; agree the order with WT-5) and the host-tool read check (§3.5); `shared/ave-home.ts` (R2); one line in `workflow-engine-extensions.ts`; en/ko |
| WT-5 | B | WT-3 | WT-4, WT-7 | `permissions/run-grants.ts`, the permission files of §4, `use-board-approvals.ts` | `permission-manager.ts`; one line in `workflow-engine-extensions.ts`; en/ko |
| WT-7 | B | WT-3 | WT-4, WT-5 | `stage-verdict.ts`, its tests, `work-board-stage-verdict-run.test.ts` | one line in `stage-gates.ts`; en/ko |
| WT-6 | B | WT-3, WT-4, WT-5 | WT-8 | — | `subagent-runner.ts`, `tools/agent-spawn.ts`, `stage-run-engine.ts` |
| WT-8 | B | WT-3, WT-4, WT-5 | WT-6 | the routine files of §7.1, its tests | `ipc/workflow-template-handlers.ts` (the attach handler; channels and preload already exist); `permission-manager.ts` (after WT-5); en/ko |
| WT-15 | E | PR-B | WT-16, WT-17 | `unattended-lane.ts`, `unattended-lane-registry.ts`, `tool-effect-evidence.ts`, their tests | `decision-pipeline.ts`, `permission-manager.ts`; one line in `workflow-engine-extensions.ts`; for ruling P: `ipc/workflow-template-handlers.ts` (confirm handler), `main/workflow-template-store.ts` (`confirmDraft`), `work-board/template-graph.ts` (`qualifyUnattended`), two `WorkflowTemplateErrorCode` members in `shared/workflow-template-types.ts` (`outward-effect-tool`, `tool-effect-unknown`), the tool base type, the MCP and plugin tool adapters with their schema and public contract; en/ko: PR-B already ships the `reasonCodes.outward-effect-tool` and `reasonCodes.tool-effect-unknown` texts (§8), and this lane is the first to send those codes |
| WT-16 | E | PR-B to build; WT-15's outward-effect resolver on main to merge (G1) | WT-15, WT-17 (build only; it merges after WT-15) | `unattended-isolation.ts`, its tests | `asrt-sandbox.ts`, `egress-runtime.ts`, `tool-scope.ts`, `host-shell-execution-plan.ts`, the shell environment builder, the loaders; one line in `workflow-engine-extensions.ts`; last commit edits WT-8's predicate, the two read-only checks in `main/workflow-template-store.ts` (`attachSchedule` gains the resolver argument), the attach and fire handlers and the start and settle results, after WT-15 and WT-18 merged; its own test file `work-board-unattended-qualification.test.ts` (§9) |
| WT-17 | E | PR-B | WT-15, WT-16 | `requested-outputs.ts`, `tools/stage-request-output.ts`, their tests | `stage-run-engine.ts` (hook bodies only), `ipc/domains/work-board.ts`, tool registration; one push function in WT-4's `host-git.ts` for the `host:git` output (C2), the only call there that may use the user's credentials (R22); one code in `shared/workflow-template-types.ts` (`remote-not-configured`); en/ko |
| WT-18 | E | WT-15 (denial events), WT-8 | WT-16, WT-17 | `run-budget.ts`, `schedule-breaker.ts`, their tests | `stage-run-engine.ts` (timer), `routines-wiring.ts`, `routines-store.ts` |

One owner per hot permission file within a wave: `permission-manager.ts` is WT-5's (WT-4 adds one guarded call at the floor site in the same wave), then WT-8's, then WT-15's; `asrt-sandbox.ts` is WT-4's, then WT-16's; `decision-pipeline.ts` and `tool-scope.ts` have one editor each. `stage-run-engine.ts` in PR-E: WT-17 edits the output hook bodies, WT-18 the budget timer; different functions, but the two lanes should agree the order before merging. Ruling P adds two shared files to PR-E. `shared/workflow-template-types.ts`: WT-3 adds the two qualification types, `EnvelopeToolRef` and `UnattendedQualification`, in PR-B, and WT-15 two error codes and WT-17 one, as separate members of `WorkflowTemplateErrorCode`; the two lanes agree the order. `main/workflow-template-store.ts`: WT-15 changes `confirmDraft`, and WT-16's limit-lifting commit changes the two read-only checks and the signature of `attachSchedule`; G1 already puts that commit after WT-15. The limit-lifting commit is the one place that edits several lanes' files at once (the store, the attach handler in `ipc/workflow-template-handlers.ts`, the fire handler in `routines-wiring.ts`, the engine's start and settle results); it is last, so no lane is open on them.

The WT-15 follow-up for ruling P (deferred from WT-2; the reasons, the work list and the success criteria are in §8). Two new codes, each with a reasonCode in en and ko, decided by the lead (Q1): `outward-effect-tool` (the registry flags the envelope tool as outward-effect) and `tool-effect-unknown` (the registry has no effect evidence for it). Neither refuses a confirmation (Q2). Tests: a version with a flagged tool confirms and is marked, one with an unknown tool (not registered, server offline, no annotations) confirms and is marked, an allowed one confirms with no mark; with them all four envelope collections, a spoofed template effect claim, a mark that is not stored, the handler-to-store resolver, and unchanged attended use. The attach, fire and spawn outcomes and their tests are the limit-lifting commit's (§9). Success: those tests red before and green after, typecheck, biome and knip with zero new findings, the i18n catalog check, WT-2's focused 16-file selection and `git diff --check`.

G1 is a merge order, not a build order. WT-16 can be written beside WT-15, but it does not merge until WT-15's resolver is on main, and its own test (§9) is red until `confirmDraft` takes a resolver. The limit-lifting commit also needs WT-18's breaker outcome `skipped-unavailable` on main (§11); the build order above already puts it after WT-18. Any map of parallel lanes drawn from the table above must show the edge WT-15 → WT-16.

The parallel claims hold only because every seam the later lanes need lands before them. Shipped with WT-2 (`6942aca82`): the `workspace`, `blocked`, `requestedOutputs`, `outputExecutions`, `usage`, `runStartedBy`, `runWorkspace`, `stageJoins` and `resultHash` fields with board-file validation; `outputHashOf` and `resultHashOf`; `beginRun(…, pin?)` with its `project-mismatch` check, and `updateStageRun`; both authority source members as data, `projectRoot` included; `approvedScope` and `attachmentScopeMatches`; the declared-output entry and `parseRequestedOutputDecl`; the four reason codes with their en and ko strings. WT-3 pre-lands the rest: the derived aliases of §2.2; the two types it adds to `shared/workflow-template-types.ts`, `EnvelopeToolRef` and `UnattendedQualification`, with the verdict members that carry them; the provider interface with `open` / `prepare` / `seal` / `integrate` / `release` / `sweep` and their call sites; the gate registry's `promptSuffix`; `RunScopeHooks`, `LaneHooks` and `RequestedOutputHooks` with the signatures of §2.2 and §10; the host-minted `unattendedStage` spawn input; the authority function; the `resultHash` and `outputHash` checks in `decideStageGate`. If WT-3 ships without one, the lane that needs it adds it and is no longer parallel-safe on that file. No two lanes add cases to the same test file, except WT-8's one added case in `work-board-stage-run.test.ts`, which lands after WT-3.

## 13. Types WT-2 shipped (PR-A, `6942aca82`)

This section records what shipped at `6942aca82` (branch `wt/2-store-b`); it is not a request. That head is the first WT-2 head `bf73b8a6e`, plus the review fixes of `9ead78a61`, plus the follow-up for the lead rulings at `51d5d582f`, plus the review-2 fixes in one commit (§13.1). All of it is finished. Where the text below says a thing shipped at `51d5d582f`, it is unchanged in `6942aca82`. Files: `src/shared/workflow-template-types.ts` (data shapes), `src/shared/workflow-template-output.ts` (`outputHashOf`, `resultHashOf`, `canonicalWorkflowJson`), `src/work-board/template-graph.ts` (intake, `graphHashOf`, `validateStageForConfirm`, `isAllReadOnlyVersion`, `parseRequestedOutputDecl`, `attachmentScopeMatches`), `src/work-board/template-run-fields.ts` (board-field validation), `src/main/workflow-template-store.ts` (store), `src/main/workflow-template-decision.ts` (decision proof), `src/ipc/workflow-template-handlers.ts` (IPC). Everything in the first block is inside `graphHash`; a field added to the hash later would invalidate confirmed versions. The R20 entry fields were such a change. They shipped before PR-A merges, while no confirmed version exists outside development data, and a graph in the older kind-only shape refuses with no migration. A graph with no declared outputs hashes as before.

In the blocks below, a name the engine imports is exported at `51d5d582f`, with these exceptions, which are private to `workflow-template-types.ts` and shown only for their shape: `StageGate`, `TemplateEdge`, `TemplateConfirmation`, `WorkflowTemplateDraft`, `RunPin`, `LaneBlockCode`, `OutputFile`, `OutputExecution` and `JoinConflict`. The engine derives the ones it needs (§2.2).

```ts
// ---- inside graphHash (shared/workflow-template-types.ts) ----
interface TemplateGraph { stages: TemplateStage[]; edges: TemplateEdge[];
  setupCommands?: string[] }                // W2; template-level; ≤ 256, each ≤ 8192 chars; ordered, byte-preserved; omitted when absent
interface TemplateStage {
  id: string;                               // ^[a-z0-9][a-z0-9-]{0,31}$ (it is a folder name); refusal "bad-stage-id"
  name: string; goal: string;               // ≤ 40, ≤ 400 chars
  kind?: "plan";                            // set by the host for a single read-scope root with a human gate
  inputs: string[];                         // upstream stage ids; each must be an ancestor in the graph
  toolScope: "read" | "all";
  agentName?: string;                       // the stage profile; ≤ 128 chars
  allowSubAgents: boolean;                  // D2; always stored; false unless set
  gate: StageGate;
  envelope?: StageEnvelope;                 // OD-2; absent = the stage cannot run unattended unless the version is all read-only
  requestedOutputs?: RequestedOutputDecl[]; // §10 (R20); ≤ 256; sorted by owner, ownerId, toolName, kind; a duplicate owner + ownerId + toolName refuses; omitted when empty
  inputFiles?: StageInputDecl[];            // W1 folder kind; ≤ 64; default: every upstream stage's collected files
  outputs?: string[];                       // W1 folder kind: globs relative to the stage workspace; default ["**"]; ≤ 32 entries
}
type StageInputDecl = { from: "project"; paths: string[] } | { from: "stage"; stageId: string };   // paths: project-relative globs, ≤ 64; stageId: an ancestor
type StageGate = { type: "human" } | { type: "auto";
  pass: { kind: "stage_ok" } | { kind: "check_exit_zero"; command: string } | { kind: "model_verdict" } };   // D9

type RequestedOutputKind = "upload" | "send-message" | "publish-post" | "external-write" | "other";
interface RequestedOutputDecl { kind: RequestedOutputKind; toolName: string; owner: "server" | "plugin" | "host"; ownerId: string }   // §10; the host entry is exactly host:git / git_push / external-write
interface StageGenerationTool { name: string; effect: "generate" | "fetch"; dataSent: boolean }   // dataSent is required: does the tool send stage data out
interface StageEnvelope {
  tools: string[];                          // exact builtin names; never broader than toolScope
  writePaths: string[];                     // globs relative to the stage workspace; default ["**"]
  readRoots: string[];                      // absolute read-only roots outside the workspace; default []
  network: { host: string; port?: number }[];          // default []
  commands: string[];                       // command prefixes; a ceiling, not a boundary; on an all-tools stage, confirm requires them to cover the template's setupCommands (§3.4)
  mcpReadOnlyTools: string[];               // "server.tool" names that declare readOnlyHint; default []
  mcpGenerationTools: StageGenerationTool[];      // default []; never on a read-scope stage
  pluginGenerationTools: StageGenerationTool[];   // default []; never on a read-scope stage
  outputs: ("branch" | RequestedOutputKind)[];    // default ["branch"]; a kind here is a label with no authority (§10)
  budget: { rounds: number; minutes: number; costUsd: number };   // all required; rounds a positive integer, minutes > 0, costUsd ≥ 0
}
```

There is no `declaredTools` and no `sendsInputsTo`. A tool an envelope declares is a read-only MCP tool, or a generation or fetch tool with its data-sent flag. A publishing tool is never usable through an envelope (lead ruling P): a version that names one confirms, but does not run unattended (Q2). The declaration-time ban is the closed effect enum, and it shipped: intake refuses a generation `effect` other than `generate` or `fetch`. There are no name patterns: the check that refused a tool by what its name reads as, and its codes (`forbidden-envelope-tool`, `outward-tool-declared`), were removed together with the name-pattern inference that R20 forbids. The second part of P is not in `6942aca82`: a version with an envelope tool that the host registry flags as outward-effect, or about which it has no metadata, does not qualify for the unattended lane, judged by registry metadata and never by name. It still confirms, marked; attach, fire and spawn refuse it (Q2, Q6). That part is WT-15's (§8); the same resolver denies at run time (§8 step 6) and keeps the tool out of the schema (§9). WT-16 does not lift the read-only limit before it is on main (G1, §9), and until then an unattended version has no MCP or plugin tool in any envelope (§7.2). An outward action is reachable only as a requested output (§10).

```ts
// ---- not in graphHash: stored records (shared/workflow-template-types.ts) ----
interface WorkflowTemplate { id: string; name: string; scope: TemplateScope; description?: string;
  currentVersion: number; createdAt: string; updatedAt: string;
  archivedAt?: string }                                         // archived = archivedAt is set; there is no boolean
type TemplateScope = { kind: "all" } | { kind: "project"; projectRoot: string };
interface TemplateVersionPin { templateId: string; version: number; graphHash: string }
interface TemplateVersion extends TemplateGraph, TemplateVersionPin { confirmedAt: string; confirmation: TemplateConfirmation; basedOn?: number }
interface WorkflowTemplateRecord { template: WorkflowTemplate; versions: TemplateVersion[]; scheduleAttachments?: ScheduleAttachment[]; draft?: WorkflowTemplateDraft }

interface ScheduleAttachmentInput extends TemplateVersionPin { scheduleId: string }   // scheduleId is the routine id
interface ScheduleAttachment extends ScheduleAttachmentInput {
  id: string;                                                   // stable UUID, new for every approval
  approvedScope: TemplateScope;                                 // R21; required since 6942aca82 (N2). The scope the attach approval was checked for; for a project, the authorised
                                                                // project-registry root, compared exactly (N8). File validation refuses a record without it (invalid-template-file); no migration
  who: string; at: string;                                      // at = the proof's decidedAt
  origin: "local-desktop" | "tailnet-surface";
  detachedAt?: string;                                          // history is kept; one active record per scheduleId
}

// ---- main only (main/workflow-template-decision.ts) ----
/** Opaque: a private symbol brand plus WeakSet membership. An object with the same public fields is refused. */
interface HostDecisionProof { readonly origin: "local-desktop" | "tailnet-surface"; readonly auditId: string; readonly decidedAt: string }
function mintHostDecisionProof(origin): HostDecisionProof;      // called only by the IPC decision handlers, after sender, gesture, owner-frame and project checks
function assertHostDecisionProof(proof: HostDecisionProof): void;   // today also refuses any origin but "local-desktop"

// ---- store (main/workflow-template-store.ts); every method throws WorkflowTemplateError with a code ----
class WorkflowTemplateStore {
  get(id: string): Promise<WorkflowTemplateRecord>;             // throws "template-not-found"
  resolveVersion(pin: TemplateVersionPin): Promise<TemplateVersion>;   // throws "template-not-found" | "unknown-version" | "graph-hash-mismatch"
  confirmDraft(id, input: { expectedGraphHash: string; expectedDraftRevision: string }, actor: { who: string; origin }): Promise<TemplateVersion>;   // "envelope-refused" carries refusals
  attachSchedule(input: ScheduleAttachmentInput, proof: HostDecisionProof, approvedScope: TemplateScope): Promise<ScheduleAttachment>;   // throws "scope-changed" when approvedScope differs from the template's scope; writes nothing then
  detachSchedule(id: string, proof: HostDecisionProof): Promise<boolean>;
  getAttachment(id: string): Promise<ScheduleAttachment | null>;
  listByTemplate(templateId: string): Promise<ScheduleAttachment[]>;   // includes detached records
  listByRoutine(scheduleId: string): Promise<ScheduleAttachment[]>;    // includes detached records
  archive(id: string): Promise<void>;
}

// ---- functions (work-board/template-graph.ts, shared/workflow-template-output.ts) ----
function graphHashOf(graph: unknown): string;                   // sha256 of the canonical whole graph: stages, edges, setupCommands
function validateStageForConfirm(stage: TemplateStage, template: TemplateGraph): EnvelopeRefusal[];   // declaration checks only
type EnvelopeRefusal = "tools-broader-than-scope" | "host-shell" | "floor-target" | "secret-path" | "user-owned-surface"
  | "outputs-need-human-gate" | "setup-outside-commands" | "bad-stage-id" | "too-many-entries";
// outputs-need-human-gate: stage.requestedOutputs is not empty and the gate is not human. setup-outside-commands: setup commands with no all-tools stage (C3),
// or an all-tools stage whose envelope commands do not cover them (N1). Ruling P adds no member here: it never refuses a confirmation (Q2, §8)
function isAllReadOnlyVersion(graph: TemplateGraph): boolean;   // §7.2
function parseRequestedOutputDecl(raw: unknown): RequestedOutputDecl;   // §10; the one strict parser, for graph and board
function attachmentScopeMatches(attachment: { approvedScope?: TemplateScope }, template: { scope: TemplateScope }): { ok: true } | { ok: false; code: "scope-changed" };   // §2.4; no snapshot, another kind or another root string all refuse; the roots are compared as exact strings
type WorkflowTemplateErrorCode = /* … */ | "scope-changed" | "project-mismatch" | "scope-not-authorised" | "output-not-declared" | /* … */;   // each has reasonCodes.<code> in en and ko
function outputHashOf(output: string, requestedOutputs: readonly RequestedOutput[]): string;   // §10
function resultHashOf(output: string): string;                  // §2.6 (N3, 6942aca82); sha256 hex of the exact stored output as UTF-8
```

How the engine uses these names (the adapter the WT-2 report asked for is this mapping, not new store code):

| Engine need | Shipped call | Mapping |
| --- | --- | --- |
| Template's current version and archive state | `get(id)` → `.template.currentVersion`, `.template.archivedAt` | A thrown `template-not-found` is `version-missing`. |
| The pinned version, verified | `resolveVersion(pin)` | `unknown-version` → `version-missing`; `graph-hash-mismatch` → `graph-mismatch`. |
| Attachment by id | `getAttachment(id)` | `null` → `attachment-missing`; `detachedAt` set → `attachment-detached`. |
| Schedules of a template, of a routine | `listByTemplate`, `listByRoutine` | Filter on `detachedAt` for the active ones. |
| Attach, detach | `attachSchedule`, `detachSchedule` | Only from the IPC handlers, with a minted proof. Attach also takes the scope the handler authorised. |
| Is the attachment still approved for the template's scope | `attachmentScopeMatches(attachment, record.template)` | `{ ok: false }` → `scope-changed`. Called at fire (WT-8) and at start and before every spawn (WT-3). |
| The project a `Create and run` approval was given for | `source.projectRoot` on the `local-create-and-run` source; `beginRun` compares it with the item's project | A thrown `project-mismatch` is the verdict of the same name. WT-3 mints the field from the card. |
| A declared-output entry, parsed | `parseRequestedOutputDecl(raw)` | WT-17 uses it for the copy it stores in `RequestedOutput.decl`; matching is WT-17's own string equality (§10). |

Confirmation keeps its `actor` parameter and takes no proof; the attachment writer is the boundary that takes one. Static confirmation is not run-time qualification: `validateStageForConfirm` checks declarations against a conservative known-read set and the existing floor and secret classifiers. Tool-registry resolution and effect classification are not in WT-2: ruling P was deferred to WT-15, which injects a resolver into `confirmDraft` to mark the version and, from the limit-lifting commit on, into `attachSchedule` to refuse (§8, §9). The signatures above are the shipped ones. The isolation proof and run-time target checks belong to WT-15 and WT-16 (§8, §9).

Board fields (`board.json`, engine-written, each optional), shipped in `shared/work-board-types.ts` and validated by `assertTemplateRunFields`. A present malformed field raises `invalid-template-run`; older rows without them still read. Since `6942aca82` `work-board/board.json` is in `COVERED_FILES` of the home trust manifest (`src/shared/ave-home-trust.ts`), like `templates.json` (lead ruling B). A board file edited outside the app is withheld as a whole: a fresh board store reads it as empty, refuses to overwrite it and leaves the untrusted bytes in place. Nothing renames or repairs it. So a gate status forged in the file never reaches `decideStageGate`, and the engine reports the store's refusal and repairs nothing. The fields:

```ts
WorkItem.templateId?: string
WorkItem.runTemplateVersion?: number; WorkItem.runTemplateGraphHash?: string
WorkItem.runStartedBy?: RunAuthoritySource                       // the whole accepted source (§2.2); its pin must equal the three item pin fields
WorkItem.runWorkspace?: RunWorkspace                             // §2.2
WorkItem.stageRuns?: WorkItemStageRun[]                          // ≤ 12
WorkItem.stageJoins?: StageJoin[]                                // ≤ 12; { joinId; stageIds; status: "integrating" | "integrated" | "conflict" | "rejected"; conflict?; decidedAt? }
WorkItemRunHistoryEntry.templateVersion?, .templateGraphHash?, .stageRuns? (summary)

WorkItemStageRun:
  stageId; attempt (1..3); status: "waiting" | "running" | "awaiting_gate" | "passed" | "failed" | "cancelled" | "rejected"
  failure?: "error" | "gate" | "interrupted" | "denied-tool" | "workspace-lost" | "workspace-revoked" | "budget" | "seed"
  taint?: "file-content" | "agent-message"
  workspace?: { root: string; kind: "git" | "folder"; baseCommit?: string; sealCommit?: string; manifest?: OutputFile[] }
  blocked?: { code: LaneBlockCode; at: string }
  requestedOutputs?: RequestedOutput[]; outputExecutions?: OutputExecution[]      // ≤ 10 each
  usage?: { rounds: number; startedAt: string; denials: number; costUsd?: number }
  childSessionId?; startedAt?; endedAt?
  output?: string                                                // ≤ 48 000 characters; the engine truncates before storing
  resultHash?: string                                            // the gate binding; a 64-character hex hash; computed with the shipped resultHashOf (§2.6)
  gate?: { type: "human"; status: "pending" | "approved" | "changes_requested" | "rejected"; note?; decidedAt?; revision: number; judgedBy?: "host" | "model" }
       | { type: "auto"; passed: boolean; evidence: string; evaluatedAt: string; judgedBy?: "host" | "model" }

interface JoinConflict { conflictHash: string; reason: "merge-conflict" | "same-path" | "identity-missing" | "interrupted";
  files: { path: string; stageIds: string[] }[];                 // ≤ 50, relative paths
  excerpt?: string }                                             // ≤ 8192 chars, shown as untrusted text

interface TemplateRunStart extends RunPin { source: RunAuthoritySource; stageRuns: WorkItemStageRun[] }
store.beginRun(id, runId, startedAt, pin?: TemplateRunStart)             // a template item with no pin is refused "template-run-unavailable"
store.updateStageRun(id, runId, mutate: (item) => WorkItem | null)      // one locked read-check-write; refuses on another runId
```

`beginRun` takes the pin it is given and never reads "current version" itself: for an attended run the caller already checked that the tuple is current, and for a scheduled run the pin is the attachment's. The run-history summary (`WorkItemStageRunSummary`) picks the gate hash field too, so the rename covers it.

Compatibility noted by WT-2: attachment records written by an earlier development snapshot without `id`, or failing the read-only rule, fail closed; no migration exists. Since `6942aca82` a record with no `approvedScope` fails closed the same way.

### 13.1 WT-2 follow-up and review-2 fixes: shipped at `6942aca82`

The changes the lead rulings needed from WT-2 are finished: the follow-up is `51d5d582f`, and the review-2 fixes (rulings N1–N9 and B) are `6942aca82`, one commit on top of it. Nothing in this section is left for WT-2. Ruling P is not in either: it was deferred to WT-15 (§8). The follow-up and the fixes changed no fire code and no engine code, so the last column says what the engine items must call or add.

| Ruling | What shipped in WT-2 | What WT-3, WT-8 or WT-17 must do |
| --- | --- | --- |
| R16 | `resultHash` on `WorkItemStageRun` and in the run-history summary, validated as a 64-character hex hash. `resultHashOf` in `shared/workflow-template-output.ts` computes it (N3, `6942aca82`); `outputHash` is not a stored field. | WT-3 calls the shipped `resultHashOf`, stores the hash at `awaiting_gate`, and `decideStageGate` recomputes both hashes (§2.6). |
| R17, as refined by C3 | Intake (`canonicalTemplateGraph`) and confirm (`validateStageForConfirm`) refuse `setup-outside-commands` only when the template has setup commands and no stage with `toolScope: "all"`. A mixed template confirms. N1 (`6942aca82`) restores coverage at confirm: for an all-tools stage with an envelope, every setup command must be covered by that stage's `envelope.commands`, else `setup-outside-commands`; a read-scope stage's envelope is not compared. | WT-3: `buildStagePrompt` gives setup commands to all-tools stages only (§2.5, §3.4). WT-15: a setup command outside the envelope of the stage that runs it is denied at run time (§8 step 6), as the second line behind the confirm check. |
| R20 | The declared-output entry is `{ kind, toolName, owner, ownerId }`, exported as `RequestedOutputDecl`, with `kind` the closed `RequestedOutputKind` and `owner` one of `server`, `plugin`, `host`. All four fields are inside `graphHash`. Entries are stored sorted by owner, owner id, tool name, kind; a duplicate owner + owner id + tool name refuses; a missing or unknown field and an old kind string refuse. Graph and board share one parser, `parseRequestedOutputDecl`. `outputs-need-human-gate` is decided from the entries, with or without an envelope. The inference of a tool's effect from its name is removed, with its refusal codes. `StageEnvelope.outputs` keeps kind labels as metadata with no authority. | WT-17: match by exact `toolName` + `owner` + `ownerId` at request and again at execution; use `kind` for labels only; keep the `resultHash` and `outputHash` approval binding; emit `output-not-declared` (§10). WT-15: ruling P, the unattended qualification of an outward-effect or unknown envelope tool by registry metadata (a mark at confirm; a refusal at attach, fire and spawn), and the run-time denial (§8). WT-16: the tool schema, and no limit lift before WT-15's resolver is on main (§9, G1). |
| C2 | The `host:` owner prefix is refused in three places, each tested. Template: `parseRequestedOutputDecl` accepts exactly one host entry, `host:git` / `git_push` / `external-write`, and refuses a `server` or `plugin` entry whose owner id starts with `host:`. MCP: `validateServer` (`src/mcp/mcp-governance.ts`) refuses such a server id, with an en and a ko message. Plugin: the manifest name grammar admits no `:`, proven through the real shape validator. | WT-17 implements the engine push and its bounds (§10, R22). Nothing about the reservation is left. |
| R21, schedule | `ScheduleAttachment.approvedScope`. The attach handler authorises the project (`scope-not-authorised` otherwise), takes its project-registry root, which is compared exactly and is not a filesystem real path (N8), and passes that scope as the third argument of `attachSchedule`. The store compares it with the template's scope inside its write queue, refuses `scope-changed` without writing on a difference, and stores a copy. Since `6942aca82` the field is required in the type (N2): file validation refuses a record with no snapshot, and a malformed one, with `invalid-template-file`, and there is no migration. `attachmentScopeMatches`, exported from `work-board/template-graph.ts`, returns `scope-changed` for a missing snapshot, another kind and another root string (a trailing slash, another case or a dot segment included), in both directions. | WT-3 and WT-8 must call `attachmentScopeMatches` at fire and before every spawn, take the run's project only from `approvedScope`, and require a new attach for a missing or different snapshot; nothing repairs one (§2.4, §7.2). |
| R21, `Create and run` | The `local-create-and-run` source carries `projectRoot?`, absent when the approval is for no project. The board validates its shape. `beginRun` throws `project-mismatch` before it writes when it differs from the item's project. | WT-3 must put the approved card's project root into `source.projectRoot` and check scope authorisation again at start and before every spawn. No shipped code builds the source or the card (§2.4). |
| Reason codes | `scope-changed`, `project-mismatch`, `scope-not-authorised` and `output-not-declared` are members of `WorkflowTemplateErrorCode` and have `reasonCodes.<code>` in the en and ko catalogs. Shipped tests reach `scope-changed` (helper and attach), `project-mismatch` (`beginRun`) and `scope-not-authorised` (the draft, confirm and attach handlers). `output-not-declared` has no producer in WT-2. | WT-3: return the first three from `authoriseRunSource`, each with a test that reaches it from the engine (§2.9). WT-17: produce `output-not-declared` in `requested-outputs.ts`, and add `remote-not-configured` as a new code with en and ko strings and its test (§10). |

Exports. The rev5 review found that four types the plan told the engine to import are private at the WT-2 head. At `51d5d582f` the private ones are `RunPin`, `LaneBlockCode`, `OutputExecution`, `JoinConflict`, `OutputFile` and `StageGate`. The plan no longer imports any of them: the pin is `TemplateVersionPin`, and the others are aliases derived from the exported `WorkItemStageRun`, `StageJoin`, `RequestedOutput` and `TemplateStage` (§2.2). Every shipped name §2.2 imports is exported at `51d5d582f`. WT-2 needs no export change.

WT-3 additions to `shared/workflow-template-types.ts`. Two types are not shipped and are added by WT-3, as exported types only: `EnvelopeToolRef` (the stage, the collection and the name of one envelope tool entry) and `UnattendedQualification` (the one result of "may this version run unattended", §2.2). They change no shipped shape, no validator and no stored record, and add no `WorkflowTemplateErrorCode` member; the two effect codes are WT-15's and `remote-not-configured` is WT-17's (§12). They are the only additions WT-3 makes to that file. Should a later item need a shape that cannot be derived, adding that export, and sweeping its consumers, is a WT-3 task and is not assumed here.

Rev6 listed three shipped facts that differed from what rev5 expected. After `6942aca82` and ruling P they stand like this:

- No snapshot (N2, reversed). `approvedScope` is required. A template file with an attachment that has none is refused `invalid-template-file` when it loads. `attachmentScopeMatches` still returns `scope-changed` for a missing snapshot, as the second line.
- Setup coverage (N1, restored). `setup-outside-commands` again covers envelope `commands`, for all-tools stages with an envelope (§3.4). WT-15's run-time denial is the second line.
- Publishing tools (ruling P). The declaration-time ban is the closed effect enum `generate` | `fetch`. An envelope tool the host registry flags as outward-effect, and one with no registry metadata, keep the version out of the unattended lane; both are judged by metadata, never by name. The version still confirms and is marked; attach, fire and spawn refuse it (Q2, Q6). The run-time denial of §8 and §9 uses the same metadata. This part is not shipped: it is WT-15's (§8), and G1 keeps the read-only limit in place until it is on main (§9).

The other review-2 fixes need nothing from the engine: a golden vector that pins the envelope defaults (N4), a stage `outputs` that is not an array refused at intake (N5), validation errors other than `too-many-entries` rethrown instead of swallowed (N6), and regression tests for writes on a quarantined row (N9).

The shipped detach handler only detaches, and since `6942aca82` it does so without looking the project up (N7); WT-8 changes it for C1 (§7.2). Graphs and board records in the older kind-only shapes refuse on purpose; there is no migration and no compatibility path.

WT-3 starts on `6942aca82`. WT-17 uses the R20 and C2 rows; WT-8 uses the R21 rows.

## 14. Open questions

### 14.1 Answered by the owner or ruled by the lead (2026-11-16) and applied

| Was | Answer | Where |
| --- | --- | --- |
| Q1 | Breaker per stage session and per grandchild for template runs; shipped flow unchanged. | §4.3 |
| Q5 | `Create and run` starts only the current confirmed version; schedules use their attachment pin. | §2.4 |
| Q10, Q11 | Workspaces under `<aveHome>/worktrees/<project>/<run>/<stage>/`; git joins onto the new branch `ave/workflow/<run>`; the user's branch and folder are never touched. | §3 |
| Q12 | User's git identity plus a run/stage trailer; ignored and secret files never copied; setup commands ask like any tool call. | §3.2, §3.4 |
| Q13 | Must be proven by a test. Code reading says revocation does not stop a stage child (F10); the engine interrupts and `work-board-stage-revoke.test.ts` proves it. | §2.9 |
| Q14 | A schedule follows its attachment pin; an unattended run never raises tool cards, open window or not. | §2.4, §7.3 |
| Q16 | Review lane derived from `stageRuns`; `awaiting_approval` never without `planApproval`. | §2.3 |
| R1 (floor carve-out) | Lead ruling T2: the stage's own workspace is carved out of the protected-path floor for reads and writes, by a host-minted session binding, for the stage session and its grandchildren. | §3.5 |
| R16 (two hashes) | Lead ruling, accepted: `resultHash` is the sha256 of the stored stage output, computed at `awaiting_gate`. A gate on a stage with requested outputs carries `resultHash` and `outputHash`; a mismatch on either refuses. | §2.6, §10; field and `resultHashOf` shipped (§13.1) |
| R17 (setup commands and read-scope stages) | Lead ruling, accepted: setup commands run only in all-tools stages, and each command asks on its own card (W2). A read-only stage never runs them. The ruling's validation wording is replaced by C3 below. | §2.5, §3.4 |
| R18 (attach writes two stores) | Lead ruling, accepted with fail-closed cleanup: when the attachment write fails after the routine was created, the same handler deletes the routine and returns the error. An orphan routine found later refuses its fire with `attachment-missing`, the schedule list shows "needs reattach or delete", and it is never silently repaired. Both paths are tested in WT-8. | §7.1, §7.2, §7.5 |
| R19 (`dataSent: true` after tainted content) | Lead ruling, accepted: `dataSent` is a disclosure only. No extra rule. | §8 step 8, §9 |
| R20 (requested-output binding) | Lead ruling: no host table (it would be a plugin-specific branch, against the `AGENTS.md` invariant). Each template `requestedOutputs` entry declares `kind`, a closed enum chosen in the envelope editor, plus the exact `toolName` and the owner id of its server or plugin, all inside `graphHash`. The engine matches calls by exact `toolName` + owner id only, never by pattern. An undeclared call that is not in the envelope is denied when unattended; with a person present it goes to the normal tree. `kind` drives labels and the gate card only. WT-17 is unblocked. | §10; entry shape shipped at `51d5d582f` (§13.1) |
| R21 (scope is not pinned) | Lead ruling, accepted and tightened: the attachment stores the approved scope (OD-1). For a project that is the authorised project-registry root, canonicalised at authorisation and compared exactly; the ruling's word "realpath" meant this (N8). A scheduled run resolves its project only from that snapshot, never from the live `WorkflowTemplate.scope`. Fire and every spawn refuse `scope-changed` when the template's current scope no longer matches; the schedule list shows "needs reattach" and nothing is repaired silently. The `Create and run` approval also binds the project root with `(templateId, version, graphHash)`, so a run cannot start on a project other than the card's. Tests: a v1 schedule for A refused after v2 changes the scope to B; a matching scope fires; `Create and run` on a project that differs from the card refused. | §2.4, §2.9, §7.2, §7.5; shapes shipped at `51d5d582f` (§13.1) |
| WT-16 limit lift | Lead ruling: the limit-lifting commit changes `attachSchedule` and the template-file validation together, and a test proves both lift together. | §9 |
| C1 (detach and routine removal) | Lead choice, confirmed: an explicit detach removes the routine. Plain removal of a `template-run` routine with an active attachment is refused, and the refusal names detach. Changing the shipped detach handler is allowed. Tests cover both paths. | §7.1, §7.2, §7.5; WT-8 |
| C2 (git push) | Lead choice: a push is declared with the reserved engine-owned owner id `host:git`, tool name `git_push` and kind `external-write`. The engine performs it after the human gate; it is never a model tool call. The `host:` owner prefix is reserved: manifest validation refuses any plugin or MCP server id that starts with it, as a distinct namespace with no alias. Test: a plugin that claims `host:git` is refused. | §10; reservation, validation and spoofing test shipped at `51d5d582f` (§13.1); the push in WT-17 |
| R22 (push remote, ref and credentials) | Lead ruling: the engine push may use the git credentials the user already configured, bounded. The remote must already be configured in the project repository, is named in `args` and is bound by `outputHash`; an arbitrary URL is refused `remote-not-configured`; the card shows the resolved URL. Only `ave/workflow/<run>` is pushed, to the same-named remote branch, with no force, no tags and no other ref. The host engine pushes, never a stage or the model, with the user's credential helper or SSH agent, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS` unset and no prompt. Credentials never reach a stage, the model, logs or the run record; the record holds only the remote name, the URL host, the branch, the pushed SHA and the exit result. An authentication failure ("push failed: authentication" with git's sanitized message), a folder-kind run, an unknown remote and a non-fast-forward each end `failed` with no retry. Five tests. It replaces the rev5 default, which used no credential helper. | §10 (the git push target, tests), §3.2; `remote-not-configured` with en and ko strings in WT-17 |
| C3 (R17 refined) | Lead choice, replaces the R17 validation wording: setup commands stay template-level and are injected only into all-tools stages. A template with read-scope stages, a host-set plan stage included, may still carry them; they never run there. Validation refuses setup commands when the template has no all-tools stage; read-scope stages are never a cause. That is C3's structural refusal. Lead ruling N1 adds a second cause, below: an all-tools stage whose envelope `commands` do not cover a setup command. A mixed template confirms when its all-tools envelopes cover the commands. | §2.5, §2.9, §3.4; C3 shipped at `51d5d582f`, N1 at `6942aca82` (§13.1) |
| Reason codes | Lead choice: `project-mismatch`, `scope-not-authorised` and `output-not-declared` are confirmed. Each gets a reasonCode with en and ko strings and a test that reaches it. The codes and strings shipped at `51d5d582f`; the engine verdicts and their tests are WT-3's and WT-17's. | §2.4, §2.9 (WT-3); §10 (WT-17); §13.1 |
| C4 (port rule) | Lead clarification: no external product name in committed prose. The only allowed mentions are the licence header and the notices entry. The candidate list of rev4's §15 moves to the PR body. The diff against `origin/main` is swept before PR-A. | §15 |
| Review-2 rulings on WT-2 (N1–N3, N7, N8, B) | Lead rulings, shipped at `6942aca82`. N1: setup coverage is restored for all-tools stages with an envelope (setup commands inside that stage's `envelope.commands`); mixed templates confirm. N2: `approvedScope` is required in the type, a missing one is refused in file validation, no migration. N3: `resultHashOf` is the sha256 of the stored stage output. N7: detach does not require the project to be authorised still. N8: the snapshot is the authorised project-registry root, compared exactly, not a real path. B: `board.json` is in `COVERED_FILES`, and a hand-edited one is withheld like `templates.json`. | §2.4, §2.6, §3.4, §7.1, §7.2, §13, §13.1 |
| P (publishing tools in an envelope) | Lead ruling, accepted and tightened: the declaration-time ban is the closed effect enum `generate` \| `fetch`, with no name patterns. Any envelope tool the host registry flags as outward-effect is refused for the unattended envelope, by registry metadata and never by name. Unknown is refused: a tool with no registry metadata (not found, server offline, no annotations) is refused for the unattended envelope with an en and ko reasonCode, and is still usable attended under the normal tree. Tests: flagged, unknown, allowed. WT-2 review 3 (P3-3) asked the plan to cover versions confirmed before WT-15 landed. How the refusal lands is ruled in Q1–Q6, below. Owner: WT-15, because the WT-2 investigation found the registry holds no complete effect metadata. | §8 (design, codes, tests, success criteria), §9, §12, §13; not shipped |
| Q1–Q6 (rev7 rulings on P and the push) | Lead rulings. Q1: the codes `outward-effect-tool` and `tool-effect-unknown`, with the draft en and ko text, are accepted. Q2: a P refusal never blocks confirm, because the envelope governs only the unattended lane. Confirm succeeds; the confirm screen marks the version "can't run unattended: `<tool>` `<reason>`"; attach is refused with that code; the envelope stays in `graphHash` unchanged. Tests: confirm succeeds and is marked; attach refused. Q3: R25 is accepted, so all four envelope tool collections are checked. Q4: R24 is accepted as stated and stays open (§14.3): a generation tool that is not read-only is unknown, refused for the unattended lane only. Q5: after the compare, the push goes to the resolved URL itself, user-info stripped (`git push <url> <refspec>`), not to the remote name; credential helpers and the SSH agent resolve by URL. Kept: the remote must be configured, a request that carries its own url is refused, and the failure text is "push failed: remote URL changed". Q6: the check is asked again at attach, at fire and before every spawn, and a temporary unknown is refused like a permanent one. At fire that firing is skipped with the status "skipped: `<tool>` unavailable", not "needs reattach", and counts toward the existing schedule breaker (two in a row pause). At spawn the run settles `cancelled` with the reason code. Tests for both. | §2.2, §2.4, §7.2, §8, §9, §10, §11 |
| Qualification result (rev7 review) | Lead ruling: one qualification result carries the failing tool and the reason; `unattendedAllowed` returns it and the authority verdict carries it. A test shows that attach, fire and spawn each surface both the tool and the reason. The coordinated signature and consumer change is the limit-lifting commit's. | §2.2, §8, §9 |
| Push details 1–4 (were R23) | Lead rulings. 1: no retry, one approval pushes at most once. 2: the resolved remote URL, user-info stripped, is bound into `outputHash`; a mismatch at execution ends `failed`; the card shows the URL; after the compare the push goes to that URL itself (Q5). 3: a folder-kind run and an unknown remote are refused at request and fail at execution. 4: the push record is canonical JSON in `OutputExecution.detail`, with no credentials. What "stripped" means is ruled in R26 and which URL is resolved in the rewrite ruling, both below. | §10; WT-17 |
| R26 (what is stripped from the push URL) | Lead ruling on rev8: strip only secrets, a password or a token in the user-info part of an https URL. The user name of an ssh or scp-form URL (`git@example.com:…`) is kept and is recorded as not a secret, so the git call reaches the same account as a push by remote name. Tests: an https token is stripped; an ssh user is kept. It replaces "user-info stripped" in push detail 2 and in Q5. Rev9 rulings 1 and 2, below, settle the https case as the whole user-info part. | §10; WT-17 |
| URL rewrite rules | Lead ruling on rev8, decided and not deferred: the bound and displayed URL is the post-rewrite push URL as resolved by `git remote get-url --push <remote>`, with `insteadOf` and `pushInsteadOf` applied. At execution the host resolves it the same way, compares, and pushes to that literal URL. WT-17 tests with a rewrite rule in the repository's configuration: the pushed target equals the bound URL; a rule changed after the approval ends the push `failed` ("remote URL changed"). The tests replace the rev8 caveat. The compare does not cover a rule that rewrites the literal URL itself; the push URL guard below does. | §10; WT-17 |
| Rev8 items 3–10 (were R25) | Lead ruling on rev8: items 3–10 accepted as proposed. (3) The attach test for the effect codes belongs to the limit-lifting commit. (4) The confirm mark is transient, and `confirmDraft` returns `{ version, unattended }`. (5) The two codes are `WorkflowTemplateErrorCode` members, not `EnvelopeRefusal` members. (6) One fire status, "skipped: `<tool>` unavailable", serves both codes, and the code is recorded beside it. (7) A run cancelled at spawn is not a breaker outcome. (8) Template-file validation calls only `everyStageHasEnvelope`, never the resolver. (9) WT-3 lands the qualification types and the verdict members early; the lift changes the predicate, `attachSchedule`, the handlers and the breaker. (10) The ko texts "무인 실행 불가: …" and "건너뜀: … 사용 불가" are accepted. Nothing else is accepted by this row. | §2.2, §8, §9, §11, §12 |
| `args` as `{ remote, url }` | A mechanism of this plan, not a lead acceptance: the resolved URL is stored in the shipped `args` field so that the shipped `outputHashOf` binds it, as push detail 2 and the rewrite ruling require. It adds no shape. The lead has not ruled on it separately. | §10; WT-17 |
| Rev9 rulings 1–3 | Lead rulings on rev9. 1: the whole user-info part of an https URL is stripped. 2: an `ssh://` URL loses its password and keeps its user name; any other scheme loses the whole user-info part. 3: `schedule-requires-read-only` is the attach code only, mapped inside `attachSchedule`; fire and spawn keep `unattended-not-read-only`. | §2.2, §7.2, §10 |
| Push URL guard | Lead ruling on the rev9 review; it replaces the fixed-point probe of rev9 ruling 5, which missed `pushInsteadOf`. U is the stripped push URL of the remote, bound at approval. Before the push the host resolves U again and compares it; then, in the same working directory, environment and `HOME` as the push and immediately before it, it reads the effective `insteadOf` and `pushInsteadOf` values with the one `git config` read of §10 and refuses when any value is a literal, case-sensitive prefix of U. A failed read fails the push and is never read as no rules. Then `git push <U> <refspec>`. Any failure ends `failed` and nothing is pushed; which text each failure shows is ruled on rev10, below. No configuration is disabled, so the credential helper and SSH keep working. Tests: for each of the two rule kinds, a rule on U added after the approval and U matching a second rule; a rule from a conditional include that applies only inside the project directory; in each, a bare-repository fixture receives no ref. The fixtures of three of these tests are corrected by the rev10 rulings, below. Accepted residual, recorded: the user's own configuration edit between the read and the push. | §10; WT-17 |
| More than one push URL | Lead ruling on rev9 (6): a remote with more than one push URL is refused `remote-not-configured`, with a test. | §10; WT-17 |
| https user names (rev9 review P3-2) | Lead ruling: whole user-info stripping stays. User-name-specific https credential or rewrite configuration is not supported by the engine push, and the plan says so. A fixture with two synthetic account contexts and no real credential shows the bound: the push uses the intended configured credential or ends in an authentication failure, with no prompt, no retry and no credential disclosure. | §10; WT-17 |
| No-envelope refusal (rev9 review P3-1) | Lead ruling: the refusal of a stage with no envelope applies only after the limit is lifted. Before it `isAllReadOnlyVersion` stays the predicate, and an all-read-only stage with no envelope still qualifies. The lift tests carry the boundary case. | §7.2, §9 |
| Guard fixtures (rev10 defect) | Lead ruling on rev10. In guard cases 1, 2 and 5, U is reached through a rule that exists at approval, or for `pushInsteadOf` through an explicit `pushurl`. The new rule matches U and leaves the remote's resolved URL unchanged, so the guard is what refuses. Each of these tests also asserts that the compare step passed. | §10 (guard tests); WT-17 |
| Guard at request | Lead ruling on rev10: the guard also runs at request and refuses `remote-not-configured`; it is checked again at execution. Guard cases 3 and 4 and the first half of case 8 become request-time cases by consequence. | §10; WT-17 |
| Rule read results | Lead ruling on rev10: `git config --get-regexp` exit 1 with empty output means no rules. Exit 128 or any other error is a read failure. A test for each. | §10; WT-17 |
| Push URL failure texts | Lead ruling on rev10: "push failed: push URL could not be verified" for a guard refusal and for a configuration read failure; "push failed: remote URL changed" for a compare mismatch only. Both in en and ko. It replaces the one text of the push URL guard row above. | §10 (failures, strings, invariants, tests); WT-17 |
| Several https accounts on one host | Lead ruling on rev10: the limitation is stated in the plan and in user-facing help text. With several https accounts on one host, use SSH or a credential helper keyed by path. | §10; WT-17 |
| R27 (an attachment made before the lift) | Lead ruling, accepted: the template file loads. Only that attachment is refused, at attach and at fire. A test shows that the other templates in the file stay usable. Lead ruling on rev11: the state is labelled "needs a new version: add envelopes and confirm", with en and ko text, and "needs reattach" is not used for it; a refused fire counts as a failure toward the schedule breaker; a test shows that re-attaching the same version is refused and that the label names the new-version path. | §7.1, §7.2, §9 |
| Template-file validation after the lift | The plan's consequence of R27, accepted by the lead; it is not ruling text. It replaces rev8 item 8: template-file validation refuses no file for an attachment's qualification and asks neither `everyStageHasEnvelope` nor the resolver. The structural half is asked per attachment, by the schedule list and by the one authority function. | §8, §9 |
| R28 (two classifications) | Lead ruling on rev11, accepted as the plan chose. (a) A failed rule read at request is refused `remote-not-configured`: fail closed with no new code. (b) A resolve that fails for a reason other than an unknown remote is a configuration read failure: `remote-not-configured` at request, "push failed: push URL could not be verified" at execution. An unknown remote is told by the name being absent from the repository's remote list, not by an exit code. | §10; WT-17 |
| R29 (ko texts and help placement) | Lead ruling on rev11, accepted: the ko texts "푸시 실패: 푸시 URL을 확인할 수 없음" and "푸시 실패: 원격 URL이 변경됨"; the https accounts help text is shown in three places: on the gate card of an http or https push, beside "push failed: authentication", and in the template editor where a push output is declared. | §10; WT-17 |
| G1 (WT-16 after WT-15's resolver) | Lead ruling: WT-16, which lifts `schedule-requires-read-only`, must not merge before WT-15's outward-effect resolver is on main. WT-16 adds a test that fails when `confirmDraft` has no resolver injected, so code enforces the order. Since Q2 the test expects a marked confirm and a refused attach, not a refused confirm. | §9, §12 |
| One run per schedule across a reattach | Rev4 review fix under `unattended-review.md` (one run at a time per schedule): admission looks for unsettled runs across every attachment id of the routine, current and detached, through one serialized path. | §2.4, §7.2, §7.5, §11; WT-8 |

### 14.2 Standing defaults (confirmed: "keep the plan defaults")

Q2 one attempt counter, cap 3. Q3 a template's plan stage uses the generic stage gate. Q4 taint carries as the existing other-principal treatment from the first turn. Q6 after a restart nothing starts without a user action. Q7 48 000-character output bound. Q9 three parallel stages, three sub-agents per stage, `MAX_TRACKED_RUNS` unchanged. Q15 the verdict is the stage's own structured ending. Q17 `Request changes` keeps the stage folder; `Retry` starts fresh. Q18 a stage's end interrupts its live grandchildren.

Two of them still need a code check by the implementing lane before they are relied on: Q8 (whether a child's final entries carry a shell exit status; if not, `check_exit_zero` always fails) and Q18 (how a grandchild's result reaches a depth-1 parent loop).

### 14.3 Remaining

R16–R22 and C1–C4 are decided and listed in §14.1. Two points rev5 left open are closed by the shipped code: the `kind` list is final (§10), and `outputHash` is not stored (§10). R22 is decided, and the two points rev6 raised as R23 are ruled as push details 1 and 2 (§14.1). Of the two points ruling P left, the collections question of R25 is decided (Q3, §14.1) and R24 stays open below with its default accepted (Q4). The rest of R25 is closed by the lead's acceptance of items 3–10 of the rev8 proposal, exactly as §14.1 lists them; storing the push URL in `args` is this plan's mechanism and not one of them. R26, which Q5 left, is ruled. The rev9 rulings and the rulings on the rev9 review (the push URL guard, more than one push URL, https user names, the no-envelope refusal) are in §14.1 too. R27 is ruled, and so are the rev10 points on the guard, the rule read, the failure texts and the https help text (§14.1). The two points that rev11 had to choose, R28 and R29, are accepted and ruled there too.

| # | Question | What the plan does meanwhile |
| --- | --- | --- |
| R2 | Does a new `worktrees` child of the Ave home need a row in the home's boundary and Windows inheritance checks (`shared/ave-home.ts:675, 1015-1027`)? Not read. | First task of WT-4; the run refuses `home-boundary-unverified` rather than run in an unchecked folder. |
| R3 | A secret file that is tracked in the repository would be checked out into a git workspace. | Removed from the stage folder after checkout and kept out of the seal commit. |
| R4 | A git run starts from the user's `HEAD` commit, so uncommitted changes are not in it. | Accepted; `Create and run` should say so when the tree is dirty (UI, WT-11). |
| R5 | Host commits are unsigned (the host has no access to the user's signing key), and a repository with no user identity cannot be sealed. | Unsigned; `identity-missing` becomes a join gate that shows the reason. |
| R6 | How long do `ave/workflow/<run>` and `_out` live? | Until the user removes the branch or the item; an untouched branch is deleted at settle. |
| R7 | A scheduled fire creates a new board item per run. Title, lane and whether old items are pruned are not decided. | New item per fire, titled with the template name and the fire time; no pruning. |
| R8 | Interim WT-8 rule: scheduled read-only stage sessions are forced to the default mode with withheld session authority, so the Allow mode cannot allow a secret-file read with nobody present (F11). Whether the existing withhold path covers a board child was not verified. | As described in §7.4; the interim test must be red first. |
| R9 | A requested-output gate approved over the Tailnet has no desktop window to approve the execution's own tool cards. | Execution waits as `pending` until a local window continues it, unless WT-9 supplies a surface. |
| R10 | Approve all requested outputs of a stage together, or a subset? | All together; the hash covers the list. |
| R11 | Cost budgets have no verified per-child cost source (F13). | The envelope's `budget.costUsd` is required (shipped); the stage run's `usage.costUsd` is optional. Rounds and minutes are always enforced; cost is not enforced until a source exists, and a run is not refused for that. |
| R12 | Windows unattended isolation: read narrowing against the ACL cost, and the local-network requirement of the container route against the lane's refusal of local destinations. Not designed. | Windows reports `platform-not-qualified` for stages with an envelope until its own design lands; all-read-only templates still run. |
| R13 | Do requested outputs and budgets apply to attended runs? | Outputs are optional there; budgets are unattended only. |
| R14 | Seed and collection bounds (5 000 files, 512 MiB). | As stated. |
| R15 | A filter driver the repository needs for checkout is not run, so such a repository cannot use git workspaces. Fall back to the folder kind, or refuse? | Refuses `git-unavailable`; no silent fallback. |
| R24 | Ruling P: how is a generation tool that is not read-only proven safe, when its annotations only prove that it is not destructive? A publishing call need not be destructive. | Not designed here. The lead accepted the default (Q4): such a tool is unknown, so a version that names it in an envelope is refused for the unattended lane only. It still confirms, marked, and runs attended (§8). WT-15 settles the rule with the lead before it ships the resolver. |

## 15. Ported code (owner rule, 2026-11-16; lead clarification C4)

The upstream source of this rule is one repository: the one identified in the attribution literal below. This plan names no upstream product in its prose and lists no candidates; the candidates considered for each item are in the PR body.

- Reuse is required, not optional. Where that repository already implements what an item needs, the item ports that source and adapts it to this repository's contracts, instead of writing it again.
- The eligible source is that repository's own code and those of its dependencies that are under the MIT or the Apache licence. Nothing from another upstream is ported under this rule.
- The upstream's dependency-injection and service layer is not taken. A port carries the logic and is wired to this repository's own modules.
- Ported code carries the upstream licence header `Portions adapted from microsoft/vscode <path> @ <commit>, Copyright (c) Microsoft Corporation, MIT License.` and a THIRD-PARTY-NOTICES.md entry under `## microsoft/vscode (Code - OSS)` with the MIT text and the file list, in the same commit.
- The header goes on each ported file, and on each ported block inside a file that is otherwise this repository's own, with the upstream path and commit filled in.
- The first port commit adds the notices section and the licence text. Every later commit that adds or changes a port updates the file list in that same commit.
- A port commit without both the header and the notices entry does not meet this rule. This design change ports nothing and does not edit the notices file.
- The licence header and the notices heading are the only places where the upstream name appears. Other committed prose, code comments and commit messages do not name it. The diff against `origin/main` is swept for such names before PR-A.
- Never used: the same vendor's proprietary extensions and any component that is not under the MIT or the Apache licence; the upstream's extension distribution service, as a source of code or of extensions; the vendor's trademarks and logos. The upstream's icon glyphs are under another licence (CC BY 4.0), which this rule's header and notices entry do not cover.
- A port is adapted to this repository's contracts and still meets this plan's invariants and boundaries. A port that needs a host capability the plan forbids (for example a host-run command) is not taken.
- A lane that ports records the upstream path and commit in the header. A lane that finds nothing suitable says so in its report and builds as planned.
