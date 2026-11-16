# Workflow templates — engine plan (PR-B: WT-3 … WT-8, PR-E: WT-15 … WT-18)

Design only; no product code changes. Code read against main `c2214d704`. Authority: `decisions.md` and `unattended-review.md` on `origin/design/workflow-templates` at `a3df543d4` (D1–D9, W1, W2, OD-1..OD-4). Where `notes-r6.md` (c) disagrees with the decisions, the decisions win.

Revision 2 (2026-11-16) applies the owner's answers:

- A workflow is general-purpose. Nothing in the engine assumes git, source code or a build. A stage works on files and tools; git is one kind of workspace.
- W1: every stage has its own workspace under the Ave home; parallel stages always run in parallel; the serial fallback is gone. Joins never touch the user's branch or folder.
- W2: host commits carry the user's git identity and a run/stage trailer; ignored and secret files are never copied; setup commands ask like any tool call.
- D6: one breaker per stage session and per grandchild for template runs. The shipped flow is unchanged.
- `Create and run` starts only the current confirmed version. A schedule starts its attachment pin.
- The Review lane is derived from `stageRuns`; `awaiting_approval` never appears without a `planApproval`.
- WT-8 is no longer blocked: it is the schedule attachment plus the interim limit that only all-read-only templates may be scheduled. PR-E (WT-15..WT-18) lifts the limit.

Stage statuses use the WT-2 names. Mapping to the brief's words: pending = `waiting`, gate = `awaiting_gate`, stopped = `cancelled`.

## 0. Findings that change the build

| # | Finding (verified) | Consequence |
| --- | --- | --- |
| F1 | The reviewer breaker is keyed by the root session, and a child of `work-board:<id>` resolves to that origin (`src/permissions/root-session-resolver.ts:19`; calls at `permission-manager.ts:667, 1734, 2019, 2101`). The counter resets only at a depth-0 turn (`engine/turn/query-loop.ts:353`) and is forgotten only by `endSession(root)` (`permission-manager.ts:1063-1066`), which no work-board path calls (the only caller is `permissions/session-scope-end.ts:16`, reached from chat delete `ipc/domains/chat.ts:1678` and routine removal `ipc/domains/routines.ts:89`, `boot/steps/workflow-stores.ts:143`; repo-wide grep). | Today all children of one item share one counter that is never reset in the process. The owner corrected D6: template runs key the breaker per stage session and per grandchild (§4.3); the shipped flow keeps today's keying. |
| F2 | "This session" grants are keyed by the requesting session: rules in `permission-manager.ts:579, 982, 1004`; exact approvals in `user-approval-store.ts:202, 429, 452`. | Sibling stage sessions share nothing today. D5 needs a new scope; it cannot reuse the item origin, which would cross runs. |
| F3 | One visible card is a renderer rule only. The host gate holds any number of pending requests (`permissions/approval-gate.ts:700`); the window FIFO is `lib/approval-queue-reducer.ts` via `ui/renderer/hooks/use-approval.ts:84`; the board draws per item in `components/work-board/use-board-approvals.ts:88-101`. | D4 needs no host change. |
| F4 | A child's first-turn trust origin is hard-coded (`engine/subagent-runner.ts:3011`), and `SubAgentSpawnResult` (`:224`) reports none. | D7 "taint carries" needs one host-only spawn input and one result field. |
| F5 | `reconcileInterruptedRuns` turns every `executing` item into `error` (`main/work-board-store.ts:757-762`); only a decidable plan survives (`:756`). | A parked stage gate would die on restart. The reconcile rule changes (§2.7). |
| F6 | `inFlight` is a mutex: a decision is refused `already_running` while a phase runs (`core/work-board-engine.ts:783-787`). | With parallel stages a gate decision must land while siblings run. Template runs use a per-item serial event queue instead (§2.2). |
| F7 | Three independent blocks stop nested spawning: the blocklist (`subagent-runner.ts:625`, applied `:2336-2343`), `spawnDepth: 1` (`:3007`, `:3946`), the tool's refusal (`tools/agent-spawn.ts:162-165`). A grandchild's origin is a real session id, so `buildSubAgentApprovalProvenance` (`:862-884`) would route its asks to the stage model. | D2 must change all three and force direct-to-user approval (§5). |
| F8 | No worktree helper exists. Host git calls go through `buildHostGitArgs` (`shared/host-git.ts:47`); the marketplace `GitRunner` (`marketplace/git/run-git.ts:209`) is transport-specific. | WT-4 adds its own small git module. `HOST_GIT_CONFIG` (`shared/host-git.ts:5`) covers only bare-repository discovery and fsmonitor, plus the hooks path; filters, textconv, credential prompts and signing are not covered and WT-4 must add them for its calls. |
| F9 | The Ave home is closed twice. Reads: the sandbox denies the whole home and re-opens only the rows of `AVE_HOME_READ_REALLOWS` (`permissions/ave-home-read-boundary.ts:26-42`); there is no `worktrees` row. Writes: `protectedControlEntryFor` (`permissions/sensitive-paths.ts:568-591`) classes every path under the home as `application-home`, a protected-path floor, except `<home>/workspace` (`:580-583`). | A stage workspace under `<home>/worktrees/` is unreadable in the sandbox and every write to it is a forced ask (a deny when nobody can answer) until both places change. WT-4 owns both edits (§3.5). Lead ruling T2: the write and read carve-out is a session binding, not a path prefix. |
| F10 | `revokeWorkspaceRoot` (`engine/subagent-runner.ts:1066-1095`) cancels only wire children whose `wireProjectRoot` equals the removed root (`:999`); every other active child only has that root removed from its scopes. | A stage child's root is its own workspace, so removing the project does not stop it. The engine must interrupt stage children itself; a test proves it (§2.9, answers Q13). |
| F11 | `decidePermission` has one call site (`permissions/permission-manager.ts:1432`). In the Allow mode `applyMode` (`permissions/decision-pipeline.ts:54`) returns allow before the no-approver deny for everything but an exfiltration signal, a secret-file read included (`:126`). | A schedule-started child that takes the ambient mode can act with nobody present. WT-8's interim children must not take it (§7.4, R8); WT-15 removes the dependency. |
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
| `src/work-board/workflow/stage-workspace.ts` | new | `StageWorkspaceProvider` interface and `unavailableWorkspaceProvider`, whose `open` refuses `workspace_unavailable`. No template run can start until WT-4's provider is wired; tests use a fake. There is no shared-folder mode. |
| `src/work-board/workflow/stage-run-engine.ts` | new | Event queue, effect runner, `spawnStageChild`, stop, steer. |
| `src/work-board/workflow/run-authority.ts` | new | `authoriseRunSource`: the single run-authority function, with the D1 and OD-1 members (§2.4). |
| `src/work-board/workflow/workflow-errors.ts` | new | `WorkflowInvariantError` with a `code`. |
| `src/core/work-board-engine.ts` | changed | Branch in `runItem`; add `decideStageGate`, `decideStageJoin`, `retryStage`, `continueRun`; `steerRun` / `cancelRun` take the template path. |
| `src/main/work-board-store.ts` | changed | Stage-aware reconcile; stage mutators if WT-2 does not ship them (§13). |
| `src/shared/work-board-types.ts` | changed | Event fields, refusal and result types. |
| `src/shared/work-board-lifecycle.ts` | changed | `isAwaitingStageReview(item)`: true when any `stageRuns[]` is `awaiting_gate` or any join is `conflict`. The Review lane uses it (`:10, 21, 29-30`). |
| `src/ipc/domains/work-board.ts`, `src/shared/ipc-channels.ts`, `src/preload/internal-api-surface.ts` | changed | `ave:work-board:decide-stage`, `decide-join`, `retry-stage`; `stageId` on steer. |
| `src/engine/subagent-runner.ts` | changed | `hostInputTaint` in, `endTrustOrigin` out (F4). |
| `src/engine/parent-directive.ts` | changed | `formatStageInputDirective`. |
| `src/boot/steps/workflow-engine-extensions.ts` | new | One object of optional engine deps; later items add one line each. |

### 2.2 Types and functions

```ts
// stage-run-engine.ts
interface RunPin { templateId: string; version: number; graphHash: string }
/** Who asked for the run. WT-3 ships both members. WT-9 adds a member for a remote Create and run. */
type RunAuthoritySource =
  | { kind: "local-create-and-run"; pin: RunPin }                                    // IPC handler, after hasUserKeyboardIntent, from the tuple the user saw
  | { kind: "schedule-attachment"; attachmentId: string; pin: RunPin; firedAt: string };   // WT-8 fire handler, from the stored attachment
type RunAuthorityVerdict =
  | { ok: true; source: RunAuthoritySource["kind"]; lane: RunLane }
  | { ok: false; code: "source-not-authorised" | "pin-mismatch" | "not-current-version" | "template-archived" | "version-missing"
      | "graph-mismatch" | "attachment-missing" | "attachment-detached" | "unattended-not-read-only" };
type RunLane = "attended" | "unattended";            // decided by the source kind, never by whether a window is open
/** The ONE host function that says which sources may create a run's stage children. Called at start and before every spawn. */
type AuthoriseRunSource = (a: {
  source: RunAuthoritySource; runPin: RunPin;
  template: WorkflowTemplate | null;                  // current version number and archived flag
  stored: TemplateVersion | null;                     // the pinned version as stored
  attachment: ScheduleAttachment | null;              // looked up by the host for a schedule source
  unattendedAllowed: (v: TemplateVersion) => boolean; // WT-8: isAllReadOnlyVersion; PR-E swaps the predicate
}) => RunAuthorityVerdict;

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
  outputs?: RequestedOutputHooks;                   // WT-17; absent = a stage that declares outputs is refused `outputs-unavailable`
  runScope?: RunScopeHooks;                         // WT-5; absent = no-op
  passConditions: PassConditionRegistry;            // WT-7 registers one more kind
}
interface StageRunEngine {
  start(itemId: number, item: WorkItem, a: { source: RunAuthoritySource; approvalSurface: WebContents | null }): Promise<RunItemResult>;
  decideGate(itemId: number, i: StageGateDecideInput, o: { approvalSurface: WebContents | null }): Promise<StageGateDecideResult>;
  decideJoin(itemId: number, i: StageJoinDecideInput, o: { approvalSurface: WebContents | null }): Promise<StageJoinDecideResult>;
  retryStage(itemId: number, i: { runId: string; stageId: string }, o: { approvalSurface: WebContents | null }): Promise<StageRetryResult>;
  steer(itemId: number, stageId: string, text: string): WorkBoardSteerResult;
  stop(itemId: number): WorkBoardCancelResult;
  liveStageSessions(itemId: number): ReadonlyMap<string, string>;   // stageId → childSessionId
}
interface StageGateDecideInput { runId: string; stageId: string; attempt: number; outputHash: string; decision: WorkPlanDecision; note?: string }
type StageGateRefusal = "not_found" | "not_pending" | "run_mismatch" | "attempt_mismatch" | "output_mismatch" | "attempts_exhausted"
  | "note_required" | "note_too_long" | "note_invalid" | "version_missing" | "graph_mismatch";
interface RunScopeHooks { sessionLinked(runKey: string, sessionId: string): void; sessionEnded(sessionId: string): void; runEnded(runKey: string): void }
const runKeyOf = (itemId: number, runId: string) => `work-board:${itemId}#${runId}`;
interface LaneHooks {            // signatures fixed here so WT-15, WT-16 and WT-18 can build in parallel
  admit(a: { runKey: string; stageId: string; envelope: StageEnvelope | undefined; workspaceRoot: string }): Promise<{ ok: true } | { ok: false; code: LaneBlockCode }>;   // WT-16
  sessionLinked(a: { runKey: string; stageId: string; sessionId: string; envelope: StageEnvelope; workspaceRoot: string }): void;   // WT-15 registry
  sessionEnded(sessionId: string): void;
  onDenied(listener: (e: { sessionId: string; code: string }) => void): () => void;   // WT-15 emits, WT-18 counts
}
type LaneBlockCode = "envelope-missing" | "isolation-unproven" | "lane-unavailable";
function outputHashOf(output: string, requestedOutputs: readonly RequestedOutput[]): string;   // sha256 of the canonical pair; WT-3 always passes [] until WT-17

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
interface RunWorkspace { kind: "git" | "folder"; runRoot: string; branch?: string; baseCommit?: string; outputDir?: string }
interface StageWorkspace { root: string; kind: "git" | "folder"; baseCommit?: string }
interface StageWorkspaceProvider {
  open(run: RunRef, projectRoot: string | undefined): Promise<{ ok: true; workspace: RunWorkspace } | { ok: false; code: WorkspaceRefusal }>;   // once, at start
  prepare(run: RunRef, stage: TemplateStage, attempt: number): Promise<{ ok: true; workspace: StageWorkspace } | { ok: false; code: WorkspaceRefusal }>;
  seal(run: RunRef, stageId: string): Promise<{ ok: true; sealCommit?: string } | { ok: false; code: WorkspaceRefusal }>;   // after the stage passed
  integrate(run: RunRef, joinId: string, stageIds: readonly string[]): Promise<{ ok: true } | { ok: false; conflict: JoinConflict }>;
  release(run: RunRef, stageIds: readonly string[] | "all"): Promise<void>;       // stage folders only; the run branch and output folder stay
  sweep(activeRunIds: readonly string[]): Promise<void>;                          // boot
}
type WorkspaceRefusal = "workspace_unavailable" | "home-boundary-unverified" | "git-unavailable" | "inputs-need-project"
  | "seed-too-large" | "seed-unreadable" | "identity-missing";
```

Event handling: one promise chain per item. Each event does: read the item → check `runId` → reduce → one store write → run effects. A spawn effect is not awaited inside the chain; the child's end enqueues `stage_ended`. `inFlight` still holds the item from `start` to settle, so a second `runItem` is refused as today. The `spawn` effect calls `prepare` first; `seal` is emitted when a stage becomes `passed`. WT-3 lands both against the provider interface, so WT-4 does not edit `stage-machine.ts`. `integrate` runs after every step, one-stage steps included, because the next step's workspaces start from the collected result.

### 2.3 State machine

| Stage status | Event | Next | Notes |
| --- | --- | --- | --- |
| `waiting` | all `inputs` and incoming edges `passed` and integrated; a slot is free | `running` (attempt 1) | Slot cap: `MAX_PARALLEL_STAGES = 3`. `prepare` runs first; a refusal fails the stage before any spawn. |
| `running` | child `ok`, human gate | `awaiting_gate` (`gate.pending`, `output`, `outputHash`) | One store write, as `setPlanAwaitingApproval` does. |
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
| Version or hash missing, store or wiring fault | `error` |

### 2.4 D1 authority and pinning

Two sources can start a run. Both bind to an exact `(templateId, version, graphHash)`; they differ in which version they may name.

| Source | Built by | Version rule | Lane |
| --- | --- | --- | --- |
| `local-create-and-run` | The `ave:work-board:run` handler, only after a consumed keyboard gesture, from the tuple the user saw | The tuple must be the template's **current** confirmed version. An older or archived one refuses (`not-current-version`, `template-archived`). | attended |
| `schedule-attachment` | WT-8's fire handler, from the stored attachment record; never from a tool call or a renderer payload | The tuple must equal the attachment's. The template's current version is not consulted, so confirming v2 does not move the schedule. A detached or missing attachment refuses. `unattendedAllowed(stored)` must hold. | unattended |

In both cases the stored version must exist and its stored hash must equal the tuple's hash and the hash recomputed now (`version-missing`, `graph-mismatch`). A refusal writes nothing. On `ok`, `start()` passes the tuple to `beginRun` as the run pin and stores the whole source object as `runStartedBy`. `Run again` is a new `Create and run` with a new tuple.

The function is called again before every spawn with the stored source, so a run whose source it no longer accepts (a detached attachment, a predicate that no longer holds) spawns nothing. The lane is a property of the stored source. A scheduled run stays unattended for its whole life, whoever is at the desk; an attended run never enters the lane.

`spawnStageChild(run, stageId, attempt)` is the only `runner.spawn` call for a template run. It throws `WorkflowInvariantError` unless all hold:

| Code | Check |
| --- | --- |
| `run-not-authorised` | `authoriseRunSource` returns `ok` for the run's stored source and pin. Nothing in a renderer or model payload can carry a source. |
| `workspace-missing` | `prepare` returned this stage's workspace and it lies under the run's `runRoot`. |
| `lane-blocked` | For an unattended run: `lane.admit` returned `ok` for this stage, or the version is all-read-only (WT-8 interim). |
| `version-missing` | `templates.getVersion(templateId, runTemplateVersion)` exists. |
| `graph-mismatch` | Its stored `graphHash` equals `runTemplateGraphHash`, and equals `graphHashOf(stages, edges)` recomputed now. |
| `stage-not-in-version` | `stageId` is a stage of that version. |
| `stage-not-ready` | The reducer emitted this spawn for this attempt. |
| `attempt-out-of-range` | `1 ≤ attempt ≤ 3`. |
| `run-stopped` | No stop is pending. |

Checked at start and again at every spawn, so confirming v2 or archiving the template never moves a run, and a missing version fails the run instead of running another graph. The child is spawned with `projectRoot` = its stage workspace, `originSessionId = work-board:<id>`, the host-minted `unattendedStage: { runKey, stageId }` for an unattended run (a new host-only spawn input, like `hostInputTaint`), `toolScope` = `exactToolScope(read-tier names)` or `PARENT_ALL_TOOL_SCOPE`, the stage profile's model, and the 20-round budget for read stages. Nothing here touches permission evaluation: each tool call enters `CHILD → H` as today.

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
- A stage never receives a sibling's transcript, and no output is written into a template.

### 2.6 Gates, retry, Stop

- Human gate: `outputHash = outputHashOf(output, requestedOutputs)` by the host (§2.2), so a gate always binds the requested outputs it shows (WT-17). `decideStageGate` checks, inside the board lock, run, stage, attempt, pending status, stored hash = recomputed hash = sent hash, then the pin (§2.4). The IPC handler is a copy of decide-plan's (`ipc/domains/work-board.ts:316`): validated sender, consumed keyboard intent, owner frame, note bound and redaction, audit event `work-approval:stage-decided` with origin `local-desktop`.
- Automatic gate: `PassConditionRegistry.evaluate(kind, facts)` where `facts = { result: SubAgentSpawnResult, stage }`. `stage_ok` = `result.ok && !result.incomplete`. `check_exit_zero` reads the stage's own recorded shell step for exactly that command; if the host cannot prove exit zero it fails (Q8). The host runs no command.
- A stage whose child ends `ok:false` never reaches its gate.
- Stop: mark, interrupt every live child (`interruptRun`), cancel pending gates, settle `cancelled` when the last child has unwound; with no live child it settles at once (this is how a run parked across a restart is stopped). Finished outputs stay.
- Steer: `steerRun(itemId, text, stageId)`; the host resolves the child from `liveStageSessions`. Refuses `not-executing` for a stage with no live child.

### 2.7 Restart reconcile

`reconcileInterruptedRuns` gains a branch for items with `runTemplateVersion`:

| Stored | After boot |
| --- | --- |
| stage `running` | `failed`, `failure: "interrupted"` (attempt kept; Retry uses the next) |
| stage `awaiting_gate` with `output` and matching `outputHash` | kept |
| stage `awaiting_gate`, hash or output missing | `failed`, `failure: "interrupted"` |
| join `integrating` | `conflict` with `reason: "interrupted"` (decidable: retry merge / reject) |
| stage `waiting` whose inputs all passed | kept `waiting`; nothing starts at boot |
| item | stays `executing`; the Review lane is derived (`isAwaitingStageReview`); never `error` unless the pin is unreadable |
| stage workspace folder missing for a kept stage | the stage is `failed`, `failure: "workspace-lost"` |

Nothing spawns at boot. The run continues only on a user decision (gate, join, Retry) or Stop; each of those re-reads the store and starts whatever is ready. A run with only ready-but-unstarted stages is continued by `continueRun(itemId, { runId }, { approvalSurface })`, a separate user action that enqueues `continue_requested`; it is not a retry and does not consume an attempt. See Q6.

### 2.8 Invariants (each throws or refuses with the named code)

1. No spawn outside `spawnStageChild`; every §2.4 code.
2. At most one live child per `(run, stageId)`; `duplicate-stage-child`.
3. A decision that does not match run + stage + attempt + output hash is refused and changes nothing.
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
| `core/__tests__/work-board-stage-run.test.ts` | `spawns only the pinned version's stages with the stage's tool scope` | D1 |
| | `a run whose template gained v2 mid-run still spawns v1 stages` | pinning |
| | `refuses to start when the pinned version is missing` | version skew |
| | `refuses to start when the Create and run tuple differs from the stored version or hash` | start binding |
| | `refuses Create and run for a version that is not current, and for an archived template` | current version only |
| | `a schedule source starts its attachment pin while a newer version is current` | OD-1 pin |
| | `a schedule source with a detached attachment, or a version that is not all read-only, starts nothing` | OD-1, interim limit |
| | `a template run with a waiting gate keeps runStatus executing and isAwaitingStageReview is true` | Review lane derivation |
| | `two stages of one step are live at the same time with different project roots` | parallel in every project kind |
| `core/__tests__/work-board-stage-revoke.test.ts` | `removing the project interrupts every live stage child of its runs and fails those stages` (red today: F10) | Q13 |
| | `a run whose stored source the authority function refuses spawns nothing` | the check is on the spawn path |
| | `a stage whose tool ask has no approval surface fails and its gate never opens` | no-surface behaviour |
| `work-board/workflow/__tests__/run-authority.test.ts` | one table over both source kinds and every refusal code; `an unknown source kind is refused` | single authority function |
| | `accepts a gate decision while a sibling stage is running` | F6 |
| | `refuses a gate decision with another attempt or output hash` | binding |
| | `steer reaches the named stage's child only` | steer |
| `main/__tests__/work-board-stage-reconcile.test.ts` | `keeps a pending stage gate across restart and fails running stages as interrupted` | F5 |
| `engine/__tests__/subagent-runner.test.ts` (added cases) | `hostInputTaint sets the child's first-turn origin`, `reports endTrustOrigin` | F4 |
| `ipc/domains/__tests__/work-board-stage-decide.test.ts` | `refuses without a keyboard gesture or from a non-owner frame` | work-approval boundary |
| `core/__tests__/work-board-run-flow.test.ts` (existing) | unchanged and green | shipped flow untouched |

Commit: `feat(work-board): stage scheduler for template runs`.

## 3. WT-4 — per-stage workspaces and join collection (W1, W2)

Files: new `src/work-board/workflow/stage-workspaces.ts` (the provider), `workspace-layout.ts` (paths and slugs, pure), `workspace-seed.ts` (bounded no-follow copy), `host-git.ts` (hardened git calls); new `src/permissions/stage-workspace-binding.ts`; changed `permissions/ave-home-read-boundary.ts`, `permissions/asrt-sandbox.ts`, the sites that raise the protected-path floor (`permissions/permission-manager.ts`, `permissions/effect-enforcement.ts`, `tools/file-tools.ts`; `sensitive-paths.ts` itself is not changed), `shared/ave-home.ts` if the new child must be listed (R2); one line in `workflow-engine-extensions.ts`; en/ko for the conflict gate. The join state machine, `decideStageJoin`, the provider call sites, the boot sweep call, the `workspace` fields and their store and board-file validation already exist from WT-3.

### 3.1 Layout

```
<aveHome>/worktrees/<project>/<run>/<stage>/     one per stage; the stage child's project root, read and write
<aveHome>/worktrees/<project>/<run>/_join/       git only: the host's integration worktree, branch ave/workflow/<run>
<aveHome>/worktrees/<project>/<run>/_out/        folder kind only: the run output folder
```

```ts
function projectSlug(projectRoot: string | undefined, itemId: number): string;   // "<name≤24, [a-z0-9-]>-<8 hex of sha256(canonical root)>", or "board-<itemId>" with no project
function runSlug(runId: string): string;                                          // 12 chars, [a-z0-9]
function stageDirName(stageId: string): string;                                   // the stage id; WT-2 bounds it to ^[a-z0-9][a-z0-9-]{0,31}$
```

No raw path, user name or title enters a segment. `_join` and `_out` cannot be stage ids. `Request changes` reruns in the same stage folder; `Retry` of a failed stage removes it and prepares again.

### 3.2 Git kind

Chosen by `open` when the project root is the top level of a git work tree with a commit at `HEAD`.

| Step | Behaviour |
| --- | --- |
| `open` | Record `baseCommit` = the user's `HEAD` commit. Create the branch `ave/workflow/<run>` at it and add `_join` as a worktree on that branch. Nothing is checked out, staged or changed in the user's folder. Uncommitted changes of the user are not part of the run (R4). |
| `prepare` | `git worktree add --detach <stage dir> <head of ave/workflow/<run>>`. Then remove from the stage folder every file the existing sensitive-path test names (`permissions/sensitive-paths.ts:755`), so a tracked secret file is not handed to a stage (R3). Ignored files are never present: a worktree holds tracked files only. |
| `seal` | Host commit of the whole stage folder on its detached `HEAD` (the removed secret paths excluded from the commit). Author and committer are the user's `user.name` / `user.email` as git resolves them for that repository; with none, `identity-missing` and nothing is committed. Trailers `Ave-Run: <runId>` and `Ave-Stage: <stageId>`. An empty diff is a no-op. |
| `integrate` | In `_join`, merge each sealed commit into `ave/workflow/<run>` in stage order. On any failure: `git merge --abort`, return `conflict`; later stages stay `waiting`. |
| Conflict gate | A join gate: a work approval bound to run + join + `conflictHash`. The user resolves in `_join` (the board opens the folder) and decides `retry_merge`, or `reject`, which settles the run `denied`. The host never resolves and never force-merges. |
| `release` | `git worktree remove --force` the stage folders, then `_join` at settle, then `git worktree prune`. The branch `ave/workflow/<run>` stays as the result; it is deleted only when it still equals `baseCommit` (R6). |

The user's repository does change in one place: its `.git` gains worktree metadata, objects and the branch ref. The checked-out branch, the index and the working files are never written.

`host-git.ts`: `execFile("git", buildHostGitArgs([...]))`, no shell, timeouts, bounded output, and it honours `isHostGitWorkspaceAvailable` (`shared/host-git.ts:31`). On top of `HOST_GIT_CONFIG` (F8) every call adds: no credential helper and no terminal prompt, no commit or tag signing, no textconv and no external diff, and filter drivers disabled for `add`, `commit`, `merge` and `worktree add`. If a repository requires a filter driver to check out, `open` refuses `git-unavailable` instead of running it.

### 3.3 Folder kind

Chosen by `open` for every other case, a run with no project included.

| Step | Behaviour |
| --- | --- |
| `open` | Create `_out`. A stage that declares `{ from: "project" }` inputs in a run with no project refuses `inputs-need-project`. |
| `prepare` | Create the stage folder and seed it with the stage's declared inputs only: `{ from: "project"; paths }` from the project folder, `{ from: "stage"; stageId }` from that stage's collected files in `_out`. |
| `seal` | Record the manifest (relative path, size, sha256) of the files matching the stage's `outputs` globs (default `**`). |
| `integrate` | Copy each sealed stage's manifest files into `_out` at the same relative paths. The same path from two stages with different content is a `conflict`; nothing is copied for that join. |
| `release` | Remove stage folders. `_out` stays until the item is removed (R6). |

Seeding and collection (`workspace-seed.ts`) share one copier: it never follows a symbolic link, junction or other reparse point (the entry is skipped and listed); it skips every path the sensitive-path test names and, when the project has ignore rules, every ignored path; it stops at `MAX_SEED_FILES = 5 000` or `MAX_SEED_BYTES = 512 MiB` with `seed-too-large` before any spawn (R14); it refuses a destination outside the run root.

### 3.4 Setup commands (W2)

`TemplateStage.setupCommands` are host text in the stage's instructions ("run these first, in order"). The stage child runs them through its ordinary shell tool, so each one asks like any other tool call, and in the unattended lane each must be inside the envelope. The host never executes one.

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

`isOwnStageWorkspacePath` resolves the target the way the floor does (physical path of the deepest existing ancestor, links and reparse points not followed into, `inspectPhysicalFilesystemPath`), refuses any spelling with an uncollapsed `..`, and compares against the stored real path with the platform's case rule. A link inside the workspace that points outside it resolves outside and is not carved out. A nested `.ave` inside the workspace stays protected.

| File | Change |
| --- | --- |
| `permissions/stage-workspace-binding.ts` | The binding and the check above. The engine binds when a stage child is linked and binds each grandchild to its stage's root; it unbinds at session end. No other caller. |
| Floor sites: `permission-manager.ts`, `effect-enforcement.ts`, `tools/file-tools.ts` | Where `protectedControlEntryFor(path)` returns `application-home`, the floor is skipped only if `isOwnStageWorkspacePath(sessionId, path)`. `protectedControlEntryFor` keeps its single `<home>/workspace` exception and gains no new prefix. A session with no binding is decided exactly as today. |
| `permissions/ave-home-read-boundary.ts` | One ceiling row: `["worktrees", slug, slug, stageDir]`, `stageDir` not `_`-prefixed, so `_join`, `_out` and the levels above a stage folder can never be granted. |
| `permissions/asrt-sandbox.ts` | The wrap for a bound session re-opens exactly `boundStageWorkspace(sessionId)` for read and write, and nothing else beneath `worktrees`. |

A sibling's folder, `_join`, `_out`, the run root and every other Ave-home path are not carved out, so for a stage session they remain a protected-path floor: a forced ask in an attended run, a deny in the unattended lane (§8, step 1).

Invariants: a stage child never reads or writes another stage's folder, `_join` or `_out`; `integrate` runs only for stages that are `passed` and sealed; every git call goes through `host-git.ts`; a path outside the run root is refused for create, copy and remove; removal touches only folders the provider created (recorded on the stage run); the user's checked-out branch, index and folder are never written.

### 3.6 Tests

`work-board/workflow/__tests__/stage-workspaces-git.test.ts` (real git in a temp repository under the lane's temp root): `each stage gets its own worktree from the run branch head`, `the join merges both stages onto ave/workflow/<run> and leaves the user's branch, index and files unchanged`, `a conflicting join returns the files and stages and leaves _join clean`, `retry merge succeeds after the conflict is resolved`, `the seal commit carries the user's identity and the run and stage trailers`, `seal refuses without a user identity`, `a repository hook, a clean filter and a textconv driver do not run during prepare, seal or integrate`, `a tracked secret file is absent from the stage folder and is not committed as a deletion`, `release removes worktrees and keeps the run branch`.

`…/stage-workspaces-folder.test.ts`: `a folder project runs two stages in parallel in two folders`, `seeds only the declared inputs`, `never follows a link out of the project and never copies a secret or ignored file`, `refuses a seed above the bounds`, `collects outputs into _out and reports the same path from two stages as a conflict`, `a later stage is seeded from _out`.

`permissions/__tests__/stage-workspace-binding.test.ts` (each red before the change): `a read and a write inside the bound workspace are not a protected-path floor`, `the binding refuses a sibling stage's workspace`, `the binding refuses the run root, _join and _out`, `the binding refuses the Ave home settings file and the configuration folder`, `a symbolic link or junction inside the workspace that points at a sibling or at the Ave home is refused`, `a spelling with .. that leaves the workspace is refused`, `a grandchild is carved out for its stage's workspace only`, `a session with no binding gets no carve-out`, `bindStageWorkspace throws for a root that is not a real four-segment stage folder`, `the sandbox profile of a bound session re-opens its own folder and no sibling`.

`core/__tests__/work-board-stage-isolation.test.ts`: `request changes reruns in the same folder`, `retry prepares a fresh folder`, `boot sweep removes folders of runs that are no longer active only`.

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

Assumes `TemplateStage.allowSubAgents?: boolean`, part of the graph hash (§13).

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

Assumes pass kind `{ kind: "model_verdict" }` in WT-2's `StageGate` (§13). File: new `src/work-board/workflow/stage-verdict.ts`, registered in `stage-gates.ts`.

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
| `main/routines-store.ts` | `isRoutineExecution` (`:74`) admits the new kind; `add` (`:416`) and `edit` (`:707`) refuse it unless called through the attach path with a host proof object. |
| `tools/routine-schedule.ts` | `:139, 262`: the tool refuses `template-run` for create and edit, whatever approval it holds. |
| `main/routines-scheduler.ts` | A third handler set in `dispatch` (`:183`). |
| `boot/steps/routines-wiring.ts` | The handler: load the attachment, call `mayFire` (WT-18; until then "no unsettled run of this attachment"), create the item, call `StageRunEngine.start` with the schedule source and `approvalSurface: null`, record the outcome with `recordRunOutcome` (`routines-store.ts:665`). |
| new `src/ipc/domains/workflow-schedule.ts` | `ave:workflow:attach-schedule`, `detach-schedule`: a work-approval boundary copied from decide-plan (validated sender, consumed keyboard gesture, owner frame, audit `work-approval:schedule-attached` with origin). WT-9 adds the remote path. |
| `permissions/permission-manager.ts` | The interim rule of §7.4 for sessions spawned with `unattendedStage`. |

### 7.2 Attach and fire

```ts
interface AttachScheduleInput { templateId: string; version: number; graphHash: string; trigger: RoutineRecord["trigger"]; projectRoot?: string }
type AttachRefusal = "not-current-version" | "graph-mismatch" | "version-missing" | "not-read-only" | "template-archived";
function isAllReadOnlyVersion(v: TemplateVersion): boolean;
// every stage: toolScope "read", no setupCommands, no allowSubAgents, envelope absent or with empty network, declaredTools and outputs
```

- Attach binds to the tuple the user saw, which must be the current version at that moment. It creates the attachment record and its routine together; neither exists without the other.
- A fire creates a new board item for that run (R7) and starts it. The source is built from the stored attachment only.
- `isAllReadOnlyVersion` is checked at attach, at fire and before every spawn (through `unattendedAllowed`, §2.4).
- A fire whose start is refused creates no item and no child; the refusal code is recorded as the routine's failure.
- Detach, and removing the routine, never stop a run that already started; Stop does.
- Confirming a new version changes no attachment. The editor's "schedules still on v1" list reads `AttachmentReader.listByTemplate`.

### 7.3 Parked gates

Already in WT-3: a human gate is a stored object with no timeout; the item sits in Needs review by derivation; a pending gate survives restart and nothing spawns at boot; a later local decision continues the run with the deciding window as the approval surface **for gate and join decisions only**. In an unattended run that surface is never given to a stage child: its tool calls are never turned into cards.

### 7.4 Interim tool-call rule (until WT-15)

A session spawned with `unattendedStage` has only read-tier tools (the version is all read-only). Its permission requests are built with `headless: true`, mode `default`, and withheld session authority (the existing `withholdSessionAuthority` path, `subagent-runner.ts:2623`), whatever the owner's ambient mode is. This closes F11 for the interim (R8). WT-15 replaces the rule with the lane.

### 7.5 Invariants and tests

Invariants: no tool call and no renderer payload can create, edit or move an attachment; a fire never decides a gate; a fire never starts a version other than its attachment's; no stage child of a scheduled run ever raises a card.

Tests: `main/__tests__/routines-template-run.test.ts`: `the routine tool cannot create or edit a template-run routine`, `the store refuses the kind without the attach proof`, `a fire starts the attachment's version while a newer one is current`, `a fire is skipped while the attachment's last run is unsettled`, `a refused start records a failure and creates no item`. `ipc/domains/__tests__/workflow-schedule.test.ts`: `attach refuses without a keyboard gesture, from a non-owner frame, for a non-current version, and for a version with an all-tools stage`. `permissions/__tests__/unattended-interim.test.ts`: `a scheduled stage session in Allow mode is denied a secret-file read and never asks`. `core/__tests__/work-board-stage-run.test.ts` (added): `a scheduled run parks at its human gate and a local approve continues it`.

Commit: `feat(routines): schedule attachment starts a read-only template run`.

## 8. WT-15 — envelope evaluator: the unattended lane (OD-2, OD-3)

Files: new `src/permissions/unattended-lane.ts` (pure), new `src/permissions/unattended-lane-registry.ts`; changed `permissions/decision-pipeline.ts`, `permissions/permission-manager.ts`; one line in `workflow-engine-extensions.ts` (`LaneHooks.sessionLinked`, `sessionEnded`, `onDenied`).

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
| 6 | tool not in `envelope.tools` / `declaredTools`; a path outside the workspace and `readRoots` (read) or outside `writePaths` (write); a write with no checkpoint; a network target not in `envelope.network`; a shell command outside `envelope.commands` | deny `outside-envelope` |
| 7 | read inside; write inside; sandboxed shell with no unproven or destructive signal; a sandboxed connection to an envelope host | allow (`sandbox-auto` for the shell) |
| 8 | sandboxed shell with an unproven or destructive signal; a declared tool | reviewer: low or medium and breaker closed → allow; anything else → deny `reviewer-denied` |

`permission-manager.ts` attaches `unattended` from the registry and, for such a request, does not look up allow rules, remembered grants, floor-session grants or run grants, and does not read the mode. Deny rules still apply. Step 8 uses the pipeline's existing review-required intermediate; for a lane session the manager never turns it into a card: with no reviewer evidence the final result is deny. Every deny is reported through `onDenied`. The envelope's forbidden contents are refused again here even though WT-2 refuses them at confirmation.

Invariants: no lane decision is `ask` or `ask-forced`; the mode never changes a lane outcome; the reviewer never allows what step 6 denies; a session without a registry entry is decided exactly as today.

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
| Tools | `tool-scope.ts:119-121, 136`: for a lane session, MCP and plugin tools are those in `envelope.declaredTools` and no others. Their results are external content and carry taint. |
| Loaders | Hook commands, skills and MCP servers found in the stage workspace do not load. |
| Lifting the interim limit | The last commit of this item swaps WT-8's `unattendedAllowed` predicate from `isAllReadOnlyVersion` to "every stage has an envelope". |

Invariants: an unproven precondition never degrades to a weaker route; the profile's roots are never wider than the envelope plus the fixed toolchain roots; a lane session's egress list is never merged with another session's.

Tests (`permissions/__tests__/unattended-isolation.test.ts`): `builds the profile from the envelope and nothing else`, `each unproven reason blocks admission and spawns nothing`, `a host-route plan is refused for a lane session`, `an undeclared MCP tool is absent from the schema and a declared one is present`, `the egress list is released at stage end`, `a private address is refused even when listed`. Real-sandbox checks (a home file is unreadable, an unlisted host is unreachable, no agent socket) are per-OS and belong to WT-13 with hostile fixtures.

Commit: `feat(permissions): unattended isolation profile`.

## 10. WT-17 — requested outputs (OD-4)

Files: new `src/work-board/workflow/requested-outputs.ts`, new `src/tools/stage-request-output.ts`; changed `stage-run-engine.ts` (the `RequestedOutputHooks` call sites exist from WT-3), `ipc/domains/work-board.ts` (`retry-output`); en/ko.

```ts
interface RequestedOutput { id: string; decl: OutputKindDecl;            // must equal one entry of the pinned envelope's outputs
  args: string;                                                           // canonical JSON, ≤ 32 KiB
  files?: { path: string; sha256: string; size: number }[];               // workspace-relative, hashed by the host at request time
  summary: string }                                                       // ≤ 400 chars, shown as untrusted text
interface OutputExecution { id: string; status: "pending" | "done" | "failed" | "denied"; at?: string; detail?: string }
interface RequestedOutputHooks {
  accept(a: { stage: TemplateStage; workspaceRoot: string; raw: unknown }): { ok: true; output: RequestedOutput } | { ok: false; code: OutputRefusal };
  execute(a: { run: RunRef; stageId: string; output: RequestedOutput; approvalSurface: WebContents | null }): Promise<OutputExecution>;
}
type OutputRefusal = "kind-not-declared" | "too-many" | "args-too-large" | "file-outside-workspace" | "file-unreadable" | "needs-human-gate";
const MAX_REQUESTED_OUTPUTS = 10;
```

- `stage_request_output` is a builtin given only to a stage child whose pinned stage declares outputs. It records data and executes nothing, so it is read-tier and never asks.
- The outputs are part of the stage run and of `outputHash` (§2.2). The gate shows each one in full: kind, target, arguments, files.
- A stage that declares outputs must have a human gate. WT-2 refuses the version otherwise; the engine refuses again (`needs-human-gate`).
- On approve, the stage is `passed` and the host executes each output as a new host call through the ordinary tree, with the deciding window as the approver, so each can still ask. It is not a replay: no tool call was parked. Files are hashed again first; a mismatch is `failed` and nothing is sent.
- An execution that fails or is denied does not change the stage. `retry-output` reruns one output under the same approved hash.
- The lane session never executes an output. In an attended run a stage may still call an outward tool directly through cards; requested outputs are optional there (R13).

Invariants: nothing executes before an approve whose hash matches; executed arguments are byte-equal to the hashed ones; a kind not in the pinned envelope is refused at request and again at execution; an output is executed at most once per approval unless the user retries it.

Tests (`work-board/workflow/__tests__/requested-outputs.test.ts`): `records an output and executes nothing`, `refuses a kind the envelope does not declare`, `the gate hash changes when an output changes`, `approve executes each output once through the permission check`, `a file changed after the request is not sent`, `a rejected gate executes nothing`, `a failed output leaves the stage passed and can be retried under the same hash`; `core/__tests__/work-board-stage-outputs.test.ts`: `a scheduled run ends at the gate with outputs pending and nothing sent`.

Commit: `feat(work-board): requested outputs executed after the human gate`.

## 11. WT-18 — budgets and schedule breakers

Files: new `src/work-board/workflow/run-budget.ts` (pure), new `src/work-board/workflow/schedule-breaker.ts` (pure); changed `stage-run-engine.ts` (timer and counters behind `LaneHooks.onDenied`), `boot/steps/routines-wiring.ts` (`mayFire` in WT-8's handler), `main/routines-store.ts` (breaker state on the routine record).

```ts
interface StageUsage { rounds: number; startedAt: number; costUsd?: number; denials: number }
type BudgetVerdict = { ok: true } | { ok: false; code: "rounds" | "minutes" | "cost" | "denials" };
function checkStageBudget(usage: StageUsage, budget: StageEnvelope["budget"], now: number): BudgetVerdict;
const MAX_LANE_DENIALS_PER_STAGE = 3;
interface ScheduleBreakerState { consecutiveBad: number; pausedAt?: string }
function nextScheduleState(prev: ScheduleBreakerState, outcome: "completed" | "failed" | "parked-on-denials"): ScheduleBreakerState;   // pauses at 2
function mayFire(a: { unsettledRun: boolean; paused: boolean }): { fire: true } | { fire: false; reason: "run-unsettled" | "paused" };
```

| Limit | Enforcement |
| --- | --- |
| Rounds | `maxRounds` on the spawn (`subagent-runner.ts:197`) = `budget.rounds`. |
| Minutes | An engine timer per stage; on expiry `interruptRun` and the stage is `failed`, `failure: "budget"`. |
| Cost | Only if a per-child cost source exists (F13, R11). |
| Denials | The third lane denial in a stage ends it `failed` and the run waits with the denied calls listed (tool name and reason code only). |
| One run at a time | A fire is skipped while the attachment's last run is unsettled, a run that only waits at a gate included. |
| Pause | After two consecutive `failed` or `parked-on-denials` runs the routine is paused (`routines-store.ts:775`) until the owner resumes it. A run that waits at a human gate is not "bad". |

Budgets apply to unattended runs only; attended runs keep today's round budget. Retry stays manual.

Tests (`work-board/workflow/__tests__/run-budget.test.ts`, `schedule-breaker.test.ts`): `each limit fails the stage with its code`, `the third lane denial ends the stage and lists the calls`, `a grandchild's rounds and denials count against its stage`, `a fire is skipped while a run is unsettled`, `two bad runs pause the schedule and a completed run resets the count`, `a run waiting at a gate does not count as bad`.

Commit: `feat(work-board): stage budgets and schedule breakers`.

## 12. Order and parallelism

PR-B, in build order: WT-3 → (WT-4, WT-5, WT-7 together) → (WT-6, WT-8 together). PR-E after PR-B: (WT-15, WT-16, WT-17 together) → WT-18 → the limit-lifting commit of WT-16.

| Item | PR | After | Parallel with | Files it owns alone | Shared files it touches |
| --- | --- | --- | --- | --- | --- |
| WT-3 | B | PR-A (WT-1, WT-2) | — | `src/work-board/workflow/*` except the files named below; `workflow-engine-extensions.ts`; `work-board-stage-run.test.ts`, `work-board-stage-revoke.test.ts` | `work-board-engine.ts`, `work-board-store.ts`, `work-board-types.ts`, `work-board-lifecycle.ts`, `ipc/domains/work-board.ts`, `ipc-channels.ts`, preload, `subagent-runner.ts`, `parent-directive.ts`, `conversation-wiring.ts` |
| WT-4 | B | WT-3 | WT-5, WT-7 | `stage-workspaces.ts`, `workspace-layout.ts`, `workspace-seed.ts`, `host-git.ts`, `permissions/stage-workspace-binding.ts`, their tests, `work-board-stage-isolation.test.ts` | `ave-home-read-boundary.ts`, `asrt-sandbox.ts`, the floor sites `permission-manager.ts` (one guarded call; agree the order with WT-5), `effect-enforcement.ts`, `tools/file-tools.ts`; `shared/ave-home.ts` (R2); one line in `workflow-engine-extensions.ts`; en/ko |
| WT-5 | B | WT-3 | WT-4, WT-7 | `permissions/run-grants.ts`, the permission files of §4, `use-board-approvals.ts` | `permission-manager.ts`; one line in `workflow-engine-extensions.ts`; en/ko |
| WT-7 | B | WT-3 | WT-4, WT-5 | `stage-verdict.ts`, its tests, `work-board-stage-verdict-run.test.ts` | one line in `stage-gates.ts`; en/ko |
| WT-6 | B | WT-3, WT-5 | WT-8 | — | `subagent-runner.ts`, `tools/agent-spawn.ts`, `stage-run-engine.ts` |
| WT-8 | B | WT-3, WT-5 | WT-6 | `ipc/domains/workflow-schedule.ts`, the routine files of §7.1, its tests | `permission-manager.ts` (after WT-5); `ipc-channels.ts`, preload; en/ko |
| WT-15 | E | PR-B | WT-16, WT-17 | `unattended-lane.ts`, `unattended-lane-registry.ts`, their tests | `decision-pipeline.ts`, `permission-manager.ts`; one line in `workflow-engine-extensions.ts` |
| WT-16 | E | PR-B | WT-15, WT-17 | `unattended-isolation.ts`, its tests | `asrt-sandbox.ts`, `egress-runtime.ts`, `tool-scope.ts`, `host-shell-execution-plan.ts`, the shell environment builder, the loaders; one line in `workflow-engine-extensions.ts`; last commit edits WT-8's predicate after WT-15 merged |
| WT-17 | E | PR-B | WT-15, WT-16 | `requested-outputs.ts`, `tools/stage-request-output.ts`, their tests | `stage-run-engine.ts` (hook bodies only), `ipc/domains/work-board.ts`, tool registration; en/ko |
| WT-18 | E | WT-15 (denial events), WT-8 | WT-16, WT-17 | `run-budget.ts`, `schedule-breaker.ts`, their tests | `stage-run-engine.ts` (timer), `routines-wiring.ts`, `routines-store.ts` |

One owner per hot permission file within a wave: `permission-manager.ts` is WT-5's (WT-4 adds one guarded call at the floor site in the same wave), then WT-8's, then WT-15's; `asrt-sandbox.ts` is WT-4's, then WT-16's; `decision-pipeline.ts` and `tool-scope.ts` have one editor each. `stage-run-engine.ts` in PR-E: WT-17 edits the output hook bodies, WT-18 the budget timer; different functions, but the two lanes should agree the order before merging.

The parallel claims hold only because WT-3 pre-lands every seam the later lanes need: the provider interface with `open` / `prepare` / `seal` / `integrate` / `release` / `sweep` and their call sites; the `workspace`, `blocked`, `requestedOutputs`, `outputExecutions` and `usage` fields with store and board-file validation; `outputHashOf`; the gate registry's `promptSuffix`; `RunScopeHooks`, `LaneHooks` and `RequestedOutputHooks` with the signatures of §2.2 and §10; the host-minted `unattendedStage` spawn input; both authority members. If WT-3 ships without one, the lane that needs it adds it and is no longer parallel-safe on that file. No two lanes add cases to the same test file, except WT-8's one added case in `work-board-stage-run.test.ts`, which lands after WT-3.

## 13. Types WT-2 must ship (PR-A)

Names of existing WT-2 types follow notes-r6 (a). Everything in the first block is inside `graphHash`; a field added to the hash after PR-A would invalidate confirmed versions.

```ts
// ---- inside graphHash ----
interface TemplateStage {
  // … notes-r6 (a) fields: id, name, goal, toolScope, agent, gate, inputs (upstream stage ids) …
  id: string;                               // additionally bounded: ^[a-z0-9][a-z0-9-]{0,31}$ (it is a folder name)
  allowSubAgents?: boolean;                 // D2
  inputFiles?: StageInputDecl[];            // W1 folder kind; default: every upstream stage's collected files
  outputs?: string[];                       // W1 folder kind: globs relative to the stage workspace; default ["**"]; ≤ 32 entries
  setupCommands?: string[];                 // W2; ≤ 8, each ≤ 400 chars
  envelope?: StageEnvelope;                 // OD-2; absent = the stage cannot run unattended unless the version is all read-only
}
type StageInputDecl = { from: "project"; paths: string[] } | { from: "stage"; stageId: string };   // paths: project-relative globs, ≤ 64
type PassCondition = /* existing kinds */ | { kind: "model_verdict" };                              // D9

interface StageEnvelope {
  tools: string[];                          // exact builtin names; never broader than toolScope
  writePaths: string[];                     // globs relative to the stage workspace; default ["**"]
  readRoots: string[];                      // absolute read-only roots outside the workspace; default []
  network: { host: string; port?: number }[];          // default []
  commands: string[];                       // command prefixes; a ceiling, not a boundary; setupCommands must be covered
  declaredTools: { tool: string; readOnly: boolean; sendsInputsTo?: string }[];   // "server.tool"; local generation or fetching only; default []
  outputs: OutputKindDecl[];                // what the stage may request for its human gate; default []
  budget: { rounds: number; minutes: number; costUsd?: number };
}
type OutputKindDecl = { kind: "git-push"; remote: string; branch: "run" } | { kind: "tool"; tool: string };   // an outward tool is declared here, never in declaredTools

// ---- not in graphHash: stored records ----
interface ScheduleAttachment {
  id: string; routineId: string;
  templateId: string; version: number; graphHash: string;       // the pin; references the hash, is not part of it
  projectRoot?: string;
  attachedAt: string; origin: "local-desktop" | "tailnet-surface";
  detachedAt?: string;
}
interface AttachmentReader {
  get(id: string): Promise<ScheduleAttachment | null>;
  listByTemplate(templateId: string): Promise<ScheduleAttachment[]>;
  listByRoutine(routineId: string): Promise<ScheduleAttachment[]>;
}
interface AttachmentWriter {            // callable only from the attach / detach IPC handlers; takes a host proof object, like the plan decision path
  attach(input: Omit<ScheduleAttachment, "id" | "attachedAt" | "detachedAt">, proof: HostDecisionProof): Promise<ScheduleAttachment>;
  detach(id: string, proof: HostDecisionProof): Promise<boolean>;
}

// ---- functions ----
interface TemplateReader {
  getTemplate(id: string): Promise<WorkflowTemplate | null>;    // must expose currentVersion: number and archived: boolean
  getVersion(templateId: string, version: number): Promise<TemplateVersion | null>;   // immutable
}
function graphHashOf(stages: readonly TemplateStage[], edges: readonly TemplateEdge[]): string;
function validateStageForConfirm(stage: TemplateStage): EnvelopeRefusal[];
type EnvelopeRefusal = "tools-broader-than-scope" | "host-shell" | "floor-target" | "secret-path" | "user-owned-surface"
  | "outward-tool-declared" | "outputs-need-human-gate" | "setup-outside-commands" | "bad-stage-id" | "too-many-entries";
function isAllReadOnlyVersion(v: TemplateVersion): boolean;     // or WT-8 ships it; see §7.2
```

Board fields (`board.json`, engine-written, each optional). WT-2 ships them or WT-3 does; they are listed so both lanes use one shape:

```ts
WorkItem.templateId?: string
WorkItem.runTemplateVersion?: number; WorkItem.runTemplateGraphHash?: string
WorkItem.runStartedBy?: RunAuthoritySource                       // the whole accepted source (§2.2)
WorkItem.runWorkspace?: RunWorkspace                             // §2.2; replaces the earlier runIsolation
WorkItem.stageRuns?: WorkItemStageRun[]
WorkItem.stageJoins?: { joinId: string; stageIds: string[]; status: "integrating" | "integrated" | "conflict" | "rejected"; conflict?: JoinConflict; decidedAt?: string }[]
WorkItemRunHistoryEntry.templateVersion?, .templateGraphHash?, .stageRuns? (summary)

WorkItemStageRun (beyond notes-r6 (a)):
  failure?: "error" | "gate" | "interrupted" | "denied-tool" | "workspace-lost" | "workspace-revoked" | "budget" | "seed"
  taint?: "file-content" | "agent-message"
  gate.judgedBy?: "host" | "model"
  workspace?: { root: string; kind: "git" | "folder"; baseCommit?: string; sealCommit?: string; manifest?: { path: string; size: number; sha256: string }[] }
  blocked?: { code: LaneBlockCode; at: string }
  requestedOutputs?: RequestedOutput[]; outputExecutions?: OutputExecution[]
  usage?: { rounds: number; startedAt: string; denials: number; costUsd?: number }

interface JoinConflict { conflictHash: string; reason: "merge-conflict" | "same-path" | "identity-missing" | "interrupted";
  files: { path: string; stageIds: string[] }[];                 // ≤ 50, relative paths
  excerpt?: string }                                             // bounded, shown as untrusted text

store.beginRun(id, runId, startedAt, pin?: { templateId: string; version: number; graphHash: string; source: RunAuthoritySource; stageRuns: WorkItemStageRun[] })
store.updateStageRun(id, runId, mutate: (item) => WorkItem | null)      // one locked read-check-write; refuses on another runId
```

`beginRun` takes the pin it is given and never reads "current version" itself: for an attended run the caller already checked that the tuple is current, and for a scheduled run the pin is the attachment's. A bound on `stageRuns[].output` is still needed from WT-2 (48 000 characters assumed; the rest stays in the transcript file).

## 14. Open questions

### 14.1 Answered by the owner (2026-11-16) and applied

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

### 14.2 Standing defaults (confirmed: "keep the plan defaults")

Q2 one attempt counter, cap 3. Q3 a template's plan stage uses the generic stage gate. Q4 taint carries as the existing other-principal treatment from the first turn. Q6 after a restart nothing starts without a user action. Q7 48 000-character output bound. Q9 three parallel stages, three sub-agents per stage, `MAX_TRACKED_RUNS` unchanged. Q15 the verdict is the stage's own structured ending. Q17 `Request changes` keeps the stage folder; `Retry` starts fresh. Q18 a stage's end interrupts its live grandchildren.

Two of them still need a code check by the implementing lane before they are relied on: Q8 (whether a child's final entries carry a shell exit status; if not, `check_exit_zero` always fails) and Q18 (how a grandchild's result reaches a depth-1 parent loop).

### 14.3 Remaining

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
| R11 | Cost budgets have no verified per-child cost source (F13). | `costUsd` optional; rounds and minutes always enforced. |
| R12 | Windows unattended isolation: read narrowing against the ACL cost, and the local-network requirement of the container route against the lane's refusal of local destinations. Not designed. | Windows reports `platform-not-qualified` for stages with an envelope until its own design lands; all-read-only templates still run. |
| R13 | Do requested outputs and budgets apply to attended runs? | Outputs are optional there; budgets are unattended only. |
| R14 | Seed and collection bounds (5 000 files, 512 MiB). | As stated. |
| R15 | A filter driver the repository needs for checkout is not run, so such a repository cannot use git workspaces. Fall back to the folder kind, or refuse? | Refuses `git-unavailable`; no silent fallback. |
