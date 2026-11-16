# Workflow templates — engine plan (PR-B: WT-3 … WT-8)

Design only; no product code changes. Read against main `c2214d704`. Authority: `decisions.md` (D1–D9, W1) on `origin/design/workflow-templates`. Where `notes-r6.md` (c) disagrees with the decisions (stripped `agent_spawn`, single FIFO, host-facts-only gates, local-only start, required plan gate), the decisions win.

Lead rulings folded in (2026-11-16): `Create and run` binds to the same `(templateId, version, graphHash)` tuple as the run pin; unattended start has no authorising source until the separate safety design (WT-14), so **WT-8 is blocked on WT-14** and WT-3 covers attended runs only; the Tailnet controller capability for work approvals belongs to WT-9.

Stage statuses use the WT-2 names. Mapping to the brief's words: pending = `waiting`, gate = `awaiting_gate`, stopped = `cancelled`.

## 0. Findings that change the build

| # | Finding (verified) | Consequence |
| --- | --- | --- |
| F1 | The reviewer breaker is keyed by the root session, and a child of `work-board:<id>` resolves to that origin (`src/permissions/root-session-resolver.ts:19`; calls at `permission-manager.ts:667, 1734, 2019, 2101`). The counter resets only at a depth-0 turn (`engine/turn/query-loop.ts:353`) and is forgotten only by `endSession(root)` (`permission-manager.ts:1063-1066`), which no work-board path calls (callers: `ipc/domains/chat.ts:1677`, `ipc/domains/routines.ts:87`, `boot/steps/workflow-stores.ts:141`). | Today all children of one item share one counter that is never reset in the process. D6 "per session, as for any child today" does not describe the code. WT-5 needs a keying change (§4.3). Open question Q1. |
| F2 | "This session" grants are keyed by the requesting session: rules in `permission-manager.ts:579, 982, 1004`; exact approvals in `user-approval-store.ts:202, 429, 452`. | Sibling stage sessions share nothing today. D5 needs a new scope; it cannot reuse the item origin, which would cross runs. |
| F3 | One visible card is a renderer rule only. The host gate holds any number of pending requests (`permissions/approval-gate.ts:700`); the window FIFO is `lib/approval-queue-reducer.ts` via `ui/renderer/hooks/use-approval.ts:84`; the board draws per item in `components/work-board/use-board-approvals.ts:88-101`. | D4 needs no host change. |
| F4 | A child's first-turn trust origin is hard-coded (`engine/subagent-runner.ts:3011`), and `SubAgentSpawnResult` (`:224`) reports none. | D7 "taint carries" needs one host-only spawn input and one result field. |
| F5 | `reconcileInterruptedRuns` turns every `executing` item into `error` (`main/work-board-store.ts:757-762`); only a decidable plan survives (`:756`). | A parked stage gate would die on restart. The reconcile rule changes (§2.7). |
| F6 | `inFlight` is a mutex: a decision is refused `already_running` while a phase runs (`core/work-board-engine.ts:783-787`). | With parallel stages a gate decision must land while siblings run. Template runs use a per-item serial event queue instead (§2.2). |
| F7 | Three independent blocks stop nested spawning: the blocklist (`subagent-runner.ts:625`, applied `:2336-2343`), `spawnDepth: 1` (`:3007`, `:3946`), the tool's refusal (`tools/agent-spawn.ts:162-165`). A grandchild's origin is a real session id, so `buildSubAgentApprovalProvenance` (`:862-884`) would route its asks to the stage model. | D2 must change all three and force direct-to-user approval (§5). |
| F8 | No worktree helper exists. Host git calls go through `buildHostGitArgs` (`shared/host-git.ts:47`); the marketplace `GitRunner` (`marketplace/git/run-git.ts:209`) is transport-specific. | WT-4 adds its own small git module. |

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
| Routines | `shared/routines-types.ts:11, 69`; `main/routines-scheduler.ts:183`; `boot/steps/routines-wiring.ts:187`; `tools/routine-schedule.ts:139, 262`; headless deny text `permissions/decision-pipeline.ts:46` | Blocked on WT-14 (§7). |
| Worktree helpers | none (F8). Project root reaches the child at `subagent-runner.ts:2695-2703`; workspace revocation `:1066` | Stage child gets the worktree as its project root. |

## 2. WT-3 — stage scheduler

### 2.1 Modules

| File | New / changed | Content |
| --- | --- | --- |
| `src/work-board/workflow/stage-graph.ts` | new | Pure: `assertPinnedVersion`, `readyStages`, `parallelGroupOf`, cycle and unknown-id checks. |
| `src/work-board/workflow/stage-machine.ts` | new | Pure reducer: `(RunSnapshot, RunEvent) → { stageRuns, joins, runStatus, effects }`. |
| `src/work-board/workflow/stage-prompt.ts` | new | `buildStagePrompt`, bounds, taint union. |
| `src/work-board/workflow/stage-gates.ts` | new | Pass-condition registry; `stage_ok`, `check_exit_zero`. |
| `src/work-board/workflow/stage-workspace.ts` | new | `StageWorkspaceProvider` interface and `serialWorkspaceProvider` (shared folder, one stage at a time). |
| `src/work-board/workflow/stage-run-engine.ts` | new | Event queue, effect runner, `spawnStageChild`, stop, steer. |
| `src/work-board/workflow/run-authority.ts` | new | `authoriseAttendedRunSource`: the single run-authority function (§2.4). |
| `src/work-board/workflow/workflow-errors.ts` | new | `WorkflowInvariantError` with a `code`. |
| `src/core/work-board-engine.ts` | changed | Branch in `runItem`; add `decideStageGate`, `decideStageJoin`, `retryStage`; `steerRun` / `cancelRun` take the template path. |
| `src/main/work-board-store.ts` | changed | Stage-aware reconcile; stage mutators if WT-2 does not ship them (§9). |
| `src/shared/work-board-types.ts` | changed | Event fields, refusal and result types. |
| `src/ipc/domains/work-board.ts`, `src/shared/ipc-channels.ts`, `src/preload/internal-api-surface.ts` | changed | `ave:work-board:decide-stage`, `decide-join`, `retry-stage`; `stageId` on steer. |
| `src/engine/subagent-runner.ts` | changed | `hostInputTaint` in, `endTrustOrigin` out (F4). |
| `src/engine/parent-directive.ts` | changed | `formatStageInputDirective`. |
| `src/boot/steps/workflow-engine-extensions.ts` | new | One object of optional engine deps; later items add one line each. |

### 2.2 Types and functions

```ts
// stage-run-engine.ts
interface RunPin { templateId: string; version: number; graphHash: string }
/** Who asked for the run. WT-3 ships one source. WT-9 and WT-14 each add a member and a branch in the authority function; nothing else changes. */
type RunAuthoritySource =
  | { kind: "local-create-and-run"; pin: RunPin };  // built by the IPC handler after hasUserKeyboardIntent, from the tuple the user saw
type RunAuthorityVerdict =
  | { ok: true; source: RunAuthoritySource["kind"] }
  | { ok: false; code: "source-not-authorised" | "pin-mismatch" | "version-missing" | "graph-mismatch" };
/** The ONE host function that says which sources may create a run's stage children. Called at start and before every spawn. */
type AuthoriseRunSource = (a: { source: RunAuthoritySource; stored: TemplateVersion | null; runPin: RunPin }) => RunAuthorityVerdict;

interface StageRunEngineDeps {
  store: WorkBoardStore;
  templates: TemplateReader;                        // WT-2, §9
  getRunner: () => SubAgentRunner | undefined;
  getAgentProfile?: (name: string) => Promise<LoadedAgentProfile | null>;
  emit: (e: Omit<WorkBoardRunEvent, "at">) => void;
  workspace: StageWorkspaceProvider;                // WT-3 default: serialWorkspaceProvider
  authoriseRunSource: AuthoriseRunSource;           // default: authoriseAttendedRunSource (run-authority.ts)
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

// stage-machine.ts
type RunEvent =
  | { type: "started" } | { type: "stage_linked"; stageId: string; childSessionId: string }
  | { type: "stage_ended"; stageId: string; attempt: number; ok: boolean; output?: string; taint?: StageTaint; reason?: string; interrupted?: boolean }
  | { type: "gate_evaluated"; stageId: string; attempt: number; passed: boolean; evidence: string; judgedBy: "host" | "model" }
  | { type: "gate_decided"; stageId: string; attempt: number; decision: WorkPlanDecision; note?: string }
  | { type: "retry_requested"; stageId: string } | { type: "stop_requested" }
  | { type: "join_integrated"; joinId: string } | { type: "join_conflict"; joinId: string; conflict: JoinConflict }
  | { type: "join_decided"; joinId: string; decision: "retry_merge" | "reject" };
type RunEffect =
  | { type: "spawn"; stageId: string; attempt: number } | { type: "evaluate_gate"; stageId: string; attempt: number }
  | { type: "interrupt"; stageId: string } | { type: "integrate"; joinId: string; stageIds: string[] }
  | { type: "settle"; runStatus: "completed" | "denied" | "error" | "cancelled" } | { type: "release_workspace"; stageIds: string[] };

// stage-workspace.ts
interface StageWorkspaceProvider {
  plan(projectRoot: string | undefined): Promise<{ mode: "isolated" } | { mode: "serial"; reason: SerialReason }>;
  prepare(run: RunRef, stageId: string, attempt: number): Promise<{ root: string | undefined }>;
  seal(run: RunRef, stageId: string): Promise<void>;                          // after the stage passed
  integrate(run: RunRef, stageIds: readonly string[]): Promise<{ ok: true } | { ok: false; conflict: JoinConflict }>;
  release(run: RunRef, stageIds: readonly string[] | "all"): Promise<void>;
}
type SerialReason = "no-project" | "not-git" | "git-unavailable" | "unsupported-repository";
```

Event handling: one promise chain per item. Each event does: read the item → check `runId` → reduce → one store write → run effects. A spawn effect is not awaited inside the chain; the child's end enqueues `stage_ended`. `inFlight` still holds the item from `start` to settle, so a second `runItem` is refused as today.

### 2.3 State machine

| Stage status | Event | Next | Notes |
| --- | --- | --- | --- |
| `waiting` | all `inputs` and incoming edges `passed` and integrated; a slot is free | `running` (attempt 1) | Slot cap: `MAX_PARALLEL_STAGES = 3`, or 1 in serial mode. |
| `running` | child `ok`, human gate | `awaiting_gate` (`gate.pending`, `output`, `outputHash`) | One store write, as `setPlanAwaitingApproval` does. |
| `running` | child `ok`, automatic gate passes / fails | `passed` / `failed` | Evidence stored. Unevaluable = fails. |
| `running` | child `ok:false` (not a requested stop) | `failed` | Siblings keep running; downstream stays `waiting`. |
| `running` | interrupted after `stop_requested` | `cancelled` | |
| `awaiting_gate` | approve / reject | `passed` / `rejected` | Reject settles the run `denied` once live siblings are interrupted and unwound. |
| `awaiting_gate` | request changes (note required) | `running`, attempt + 1 | Refused `attempts_exhausted` at attempt 3. Note and prior output go in as fenced data. |
| `failed` | `retry_requested` | `running`, attempt + 1 | Same inputs; refused at attempt 3. No automatic retry. |
| any non-terminal | `stop_requested` | `cancelled` | Pending gates become `cancelled`. |

Run (item `runStatus`, no new value):

| Condition | `runStatus` |
| --- | --- |
| A child is live, or a stage is `failed` and waits for Retry / Stop | `executing` |
| No child live, no failed stage, ≥ 1 pending human gate or join gate | `awaiting_approval` (the item sits in Needs review; `planApproval` stays absent) |
| Last stage `passed` | `completed` (`output` = last stage output; shipped result review follows) |
| A gate or join rejected | `denied` |
| Stop | `cancelled` |
| Version or hash missing, store or wiring fault | `error` |

### 2.4 D1 authority and pinning

Start: `ave:work-board:run` for a template item carries the `(templateId, version, graphHash)` the user saw on `Create and run`. The handler builds `{ kind: "local-create-and-run", pin }` only after a consumed keyboard gesture. `start()` calls `authoriseRunSource`; on `ok` it passes that same tuple to `beginRun` as the run pin. A tuple that differs from the item's `templateId`, from the stored version, or from the recomputed hash refuses the start (`pin-mismatch`, `version-missing`, `graph-mismatch`) and writes nothing. `Run again` is a new `Create and run` with a new tuple.

`authoriseAttendedRunSource` accepts exactly `local-create-and-run`; any other kind returns `source-not-authorised`. The accepted source kind is stored as `runStartedBy` and re-checked from the store at every spawn, so a run whose stored source the function does not accept spawns nothing.

`spawnStageChild(run, stageId, attempt)` is the only `runner.spawn` call for a template run. It throws `WorkflowInvariantError` unless all hold:

| Code | Check |
| --- | --- |
| `run-not-authorised` | `authoriseRunSource` returns `ok` for the run's stored source and pin. Nothing in a renderer or model payload can carry a source. |
| `version-missing` | `templates.getVersion(templateId, runTemplateVersion)` exists. |
| `graph-mismatch` | Its stored `graphHash` equals `runTemplateGraphHash`, and equals `graphHashOf(stages, edges)` recomputed now. |
| `stage-not-in-version` | `stageId` is a stage of that version. |
| `stage-not-ready` | The reducer emitted this spawn for this attempt. |
| `attempt-out-of-range` | `1 ≤ attempt ≤ 3`. |
| `run-stopped` | No stop is pending. |

Checked at start and again at every spawn, so confirming v2 or archiving the template never moves a run, and a missing version fails the run instead of running another graph. The child is spawned with `originSessionId = work-board:<id>`, `toolScope` = `exactToolScope(read-tier names)` or `PARENT_ALL_TOOL_SCOPE`, the stage profile's model, and the 20-round budget for read stages. Nothing here touches permission evaluation: each tool call enters `CHILD → H` as today.

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

- Human gate: `outputHash = sha256(output)` by the host. `decideStageGate` checks, inside the board lock, run, stage, attempt, pending status, stored hash = recomputed hash = sent hash, then the pin (§2.4). The IPC handler is a copy of decide-plan's (`ipc/domains/work-board.ts:316`): validated sender, consumed keyboard intent, owner frame, note bound and redaction, audit event `work-approval:stage-decided` with origin `local-desktop`.
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
| item | `awaiting_approval` if a gate is pending and nothing failed, else `executing`; never `error` unless the pin is unreadable |

Nothing spawns at boot. The run continues only on a user decision (gate, join, Retry) or Stop; each of those re-reads the store and starts whatever is ready. A run with only ready-but-unstarted stages is continued by `retryStage` on one of them (attempt stays 1). See Q6.

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
| | `a run whose stored source the authority function refuses spawns nothing` | the check is on the spawn path |
| | `a stage whose tool ask has no approval surface fails and its gate never opens` | no-surface behaviour |
| `work-board/workflow/__tests__/run-authority.test.ts` | `accepts local-create-and-run with a matching pin and refuses every other source kind` | single authority function |
| | `accepts a gate decision while a sibling stage is running` | F6 |
| | `refuses a gate decision with another attempt or output hash` | binding |
| | `steer reaches the named stage's child only` | steer |
| `main/__tests__/work-board-stage-reconcile.test.ts` | `keeps a pending stage gate across restart and fails running stages as interrupted` | F5 |
| `engine/__tests__/subagent-runner.test.ts` (added cases) | `hostInputTaint sets the child's first-turn origin`, `reports endTrustOrigin` | F4 |
| `ipc/domains/__tests__/work-board-stage-decide.test.ts` | `refuses without a keyboard gesture or from a non-owner frame` | work-approval boundary |
| `core/__tests__/work-board-run-flow.test.ts` (existing) | unchanged and green | shipped flow untouched |

Commit: `feat(work-board): stage scheduler for template runs`.

## 3. WT-4 — stage worktrees and the join (W1)

Files: `src/work-board/workflow/stage-worktrees.ts` (the `StageWorkspaceProvider`), `src/work-board/workflow/host-git.ts` (`execFile("git", buildHostGitArgs([...]))`, no shell, timeouts, bounded output), one line in `workflow-engine-extensions.ts`, i18n en/ko for the serial notice and the conflict gate. The join state machine and `decideStageJoin` already exist from WT-3 and are tested there with a fake provider.

```ts
interface JoinConflict { conflictHash: string; reason: "merge-conflict" | "dirty-target" | "interrupted";
  files: { path: string; stageIds: string[] }[];           // ≤ 50, paths relative to the project
  excerpt?: string }                                        // bounded, shown as untrusted text
interface StageJoinDecideInput { runId: string; joinId: string; conflictHash: string; decision: "retry_merge" | "reject" }
function createGitWorktreeProvider(deps: { git: HostGit; worktreesRoot: (projectRoot: string) => string; now: () => number }): StageWorkspaceProvider;
```

| Step | Behaviour |
| --- | --- |
| `plan` | `isolated` when the project root is the top level of a git work tree with a commit at `HEAD`; otherwise `serial` with a reason. The engine records the mode on the run and emits it, and the board says "parallel stages run one after another: <reason>". |
| `prepare` | Only for a stage in a group of ≥ 2. `git worktree add -b ave/run-<runId8>/<stageId>-a<n> <dir> <baseCommit>`; base = `HEAD` when the group starts. The child's `projectRoot` is the worktree. A single-stage step runs in the project folder as today. |
| `seal` | After the stage passes its gate: commit everything in its worktree on its branch (host commit, hooks disabled by `buildHostGitArgs`). An empty diff is a no-op. |
| `integrate` | When every stage of the group has passed: merge each sealed branch into the project's checked-out branch, in stage order. On any failure: `git merge --abort`, return `conflict`. The downstream stages stay `waiting`. |
| Conflict gate | A join gate (work approval; binds to run + join + `conflictHash`). `retry_merge` runs `integrate` again after the user fixed the tree; `reject` settles the run `denied`. |
| `release` | Remove the worktree and delete the branch after integration; on any settle remove all of the run's; at boot remove worktrees of runs that are no longer active, then `git worktree prune`. A failed stage's worktree is removed when its retry starts. |

Invariants: a stage child never runs in another stage's worktree (`workspace-mismatch`); `integrate` runs only for groups whose stages are all `passed` and sealed; the host never resolves a conflict itself and never force-merges; every git call uses `buildHostGitArgs`; a worktree path outside `worktreesRoot` is refused; removal only touches paths the provider created (recorded on the stage run).

Tests (`work-board/workflow/__tests__/stage-worktrees.test.ts`, real git in a temp repo under the lane's `ctmp`): `gives each parallel stage its own worktree from the same base`, `merges both stage branches at the join`, `turns a conflicting join into a conflict result naming the files and stages and leaves the tree clean`, `retry merge succeeds after the conflict is resolved`, `falls back to serial for a folder that is not a repository and reports why`, `removes worktrees and branches on settle and after Stop`, `boot cleanup removes a dead run's worktrees only`. Plus `core/__tests__/work-board-stage-run.test.ts`: `serial mode starts one stage at a time`.

Commit: `feat(work-board): stage worktrees and host merge at the join`.

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

### 4.3 D6 breaker per session

`JudgeRequest` gains `breakerSessionId`; `permission-manager` computes it as the session itself when `runKeyOfSession(sessionId)` is set, else the root as today. `judge-engine.ts:171, 460, 501` and `permission-manager.ts:1734, 2019` use it. `sessionLinked` calls `beginTurn(sessionId)`; `sessionEnded` calls `forget(sessionId)`. Sessions outside a template run keep today's behaviour (Q1 asks whether that is intended).

Tests (`permissions/judge/__tests__/judge-breaker-run-sessions.test.ts`): `three blocks in one stage session pause that session only`, `a sibling stage session keeps its own count`, `a non-run child still counts on its root`.

Commit: `feat(permissions): per-stage approval lanes, run-scoped grant, per-session breaker for run members`.

## 5. WT-6 — sub-agents at depth 1 (D2)

Assumes `TemplateStage.allowSubAgents?: boolean`, part of the graph hash (§9).

| File | Change |
| --- | --- |
| `engine/subagent-runner.ts` | `SubAgentSpawnInput.stageSubAgents?: { stageName: string; runKey: string; max: number }` (host-only). `buildChildDeps` (`:2315`) keeps `agent_spawn`, `agent_status`, `agent_interrupt` for such a child. Its tool context carries `spawnDepth: 1` and `stageSubAgents: true`. A spawn made by that child runs with `spawnDepth: 2`, never `stageSubAgents`, `approvalProvenance: null`, title `<stage name> › <sub-agent title>`. |
| `tools/agent-spawn.ts` | `:162-165`: allow depth 1 only when the host metadata says `stageSubAgents`; depth ≥ 2 always refuses. |
| `work-board/workflow/stage-run-engine.ts` | Pass `stageSubAgents` when the pinned stage opted in; register grandchild sessions through `RunScopeHooks`; forward `subAgentSessionId` on progress events so the board claims their cards. |

Rules: the grandchild inherits the approval surface through the registry chain (stage child → `work-board:<id>`); its cards go to the user, never to the stage model (F7); it is a run member (run grant, own breaker count); Stop on the stage interrupts its grandchildren first; `max` is a host constant (Q9).

Invariants: `agent_spawn` at depth 2 is refused with the existing error; a stage without the opt-in never sees `agent_spawn`; a grandchild with non-null approval provenance throws at spawn.

Tests (`engine/__tests__/subagent-stage-subagents.test.ts`): `an opted-in stage child can spawn one level`, `the grandchild cannot spawn`, `a stage without the opt-in has no agent_spawn tool`, `the grandchild's approval is labelled with stage and sub-agent and has no parent adjudication`, `the grandchild resolves the stage's approval surface`, `interrupting the stage interrupts its grandchildren`; `permissions/__tests__/run-grants.test.ts`: `a grandchild shares the run grant and has its own breaker count`.

Commit: `feat(work-board): per-stage sub-agent opt-in at depth 1`.

## 6. WT-7 — model-judged pass conditions (D9)

Assumes pass kind `{ kind: "model_verdict" }` in WT-2's `StageGate` (§9). File: new `src/work-board/workflow/stage-verdict.ts`, registered in `stage-gates.ts`.

```ts
function evaluateModelVerdict(output: string): { passed: boolean; evidence: string; judgedBy: "model" };
// passes only when the stage's final message ends with exactly one fenced JSON object {"verdict":"pass"|"fail","reason":string≤400}
```

The host tells the stage, in its instructions, to end with that block. Unparseable, missing, duplicated or oversized = failed gate with evidence `verdict-unreadable`. The stored gate carries `judgedBy: "model"`, and the event and the gate row are labelled as a model judgement. The module imports nothing from `src/permissions`.

Invariants: a verdict never creates, answers or removes an approval request; a `model_verdict` gate cannot be the answer to a human gate; a failed verdict follows the ordinary failed-stage path.

Tests (`work-board/workflow/__tests__/stage-verdict.test.ts`): `passes on a single pass verdict`, `fails on fail, on no block, on two blocks, on prose claiming OK`, `records judgedBy model`; `core/__tests__/work-board-stage-run.test.ts`: `a pass verdict leaves a pending tool approval of a sibling untouched`; an import test `stage-verdict has no permissions import`.

Commit: `feat(work-board): model-judged stage pass condition`.

## 7. WT-8 — routine or schedule start (D8) — BLOCKED on WT-14

Unattended start has no authorising source: `authoriseAttendedRunSource` refuses everything but `local-create-and-run`. WT-14 (the owner-ordered safety design) decides the source, its binding and its limits. Nothing that creates a run from a routine may be built before it.

Buildable now, and already part of WT-3 because attended runs need it too (the parked-gate mechanics):

| Mechanic | Where |
| --- | --- |
| A human gate is a stored object with no timeout; the run returns after storing it | §2.3, §2.6 |
| The item shows in Needs review while only gates wait | §2.3 |
| A pending gate survives restart; nothing spawns at boot | §2.7 |
| A later local decision continues the run with the deciding window as the approval surface | `decideGate(…, { approvalSurface })` |
| With no approval surface a tool ask is denied under `Q` with the existing text (`permissions/decision-pipeline.ts:46`) and the stage fails | `start(…, { approvalSurface: null })` is already legal; WT-3 test in §2.9 |

Sketch for after WT-14, not a commitment: `RoutineExecution` gains a kind (`shared/routines-types.ts:11`); the scheduler gets a third handler set (`main/routines-scheduler.ts:183`); `boot/steps/routines-wiring.ts` calls `start()` with the source WT-14 defines and `approvalSurface: null`; `tools/routine-schedule.ts:262` keeps refusing the new kind unless WT-14 says otherwise. The engine change is one new `RunAuthoritySource` member and one branch in the authority function.

Invariants that hold whatever WT-14 decides: a fire never decides a gate; no run starts from an unconfirmed draft; no surface is inferred for an unattended start.

Commit (after WT-14): `feat(routines): start a workflow template run from a schedule`.

## 8. Order and parallelism

Commits in build order: WT-3 → WT-5 → WT-6, with WT-4 and WT-7 independent after WT-3. WT-8 is blocked on WT-14.

| Item | After | Parallel with | Files it owns alone | Shared files it touches |
| --- | --- | --- | --- | --- |
| WT-3 (attended runs only) | PR-A (WT-1, WT-2) | — | all of `src/work-board/workflow/*` except the three below; `workflow-engine-extensions.ts` | `work-board-engine.ts`, `work-board-store.ts`, `work-board-types.ts`, `ipc/domains/work-board.ts`, `ipc-channels.ts`, preload, `subagent-runner.ts`, `parent-directive.ts`, `conversation-wiring.ts` |
| WT-4 | WT-3 | WT-5, WT-7 | `stage-worktrees.ts`, `host-git.ts` | one line in `workflow-engine-extensions.ts`; en/ko |
| WT-5 | WT-3 | WT-4, WT-7 | `permissions/run-grants.ts` and the permission files of §4; `use-board-approvals.ts` | one line in `workflow-engine-extensions.ts`; en/ko |
| WT-6 | WT-3 and WT-5 | WT-4, WT-7 | — | `subagent-runner.ts`, `tools/agent-spawn.ts`, `stage-run-engine.ts` |
| WT-7 | WT-3 | WT-4, WT-5 | `stage-verdict.ts` | one line in `stage-gates.ts` |
| WT-8 | WT-14 and WT-3 | blocked | routine files of §7 | `run-authority.ts` (one source), en/ko |

Must be sequential: WT-3 before everything (it owns the seams and the hot files); WT-6 after WT-5 (run membership, breaker key, and both edit the runner's approval path). Same-file touches between parallel lanes are limited to one added line in `workflow-engine-extensions.ts` and added keys in the en/ko message files; they merge mechanically.

## 9. Assumed WT-2 interface

```ts
// read side, any module
interface TemplateReader {
  getTemplate(id: string): Promise<WorkflowTemplate | null>;
  getVersion(templateId: string, version: number): Promise<TemplateVersion | null>;   // immutable; null when absent
}
function graphHashOf(stages: readonly TemplateStage[], edges: readonly TemplateEdge[]): string;   // host canonical sha256

// board.json, engine-written (notes-r6 (a))
WorkItem.templateId?: string
WorkItem.runTemplateVersion?: number; WorkItem.runTemplateGraphHash?: string; WorkItem.stageRuns?: WorkItemStageRun[]
WorkItemRunHistoryEntry.templateVersion?, .templateGraphHash?, .stageRuns? (summary)

// store
beginRun(id, runId, startedAt, pin?: { templateId: string; version: number; graphHash: string; stageRuns: WorkItemStageRun[] })
// the pin is the tuple the Create and run gesture named, already checked by authoriseRunSource; beginRun does not read "current version" itself
```

Additions this plan needs beyond notes-r6 (a). Each is optional and engine-written; WT-2 ships it, or the named item adds it:

| Field / function | Needed by | Fallback owner |
| --- | --- | --- |
| `store.updateStageRun(id, runId, mutate: (item) => WorkItem \| null)` — one locked read-check-write, refuses on another `runId` | WT-3 | WT-3 |
| `WorkItemStageRun.failure?: "error" \| "gate" \| "interrupted" \| "denied-tool"`, `.taint?: "file-content" \| "agent-message"`, `.gate.judgedBy?: "host" \| "model"` | WT-3, WT-7 | WT-3 |
| `WorkItemStageRun.workspace?: { root: string; branch: string; baseCommit: string }` | WT-4 | WT-4 |
| `WorkItem.runIsolation?: { mode: "isolated" \| "serial"; reason?: SerialReason }`, `WorkItem.stageJoins?: { joinId: string; stageIds: string[]; status: "integrating" \| "integrated" \| "conflict" \| "rejected"; conflict?: JoinConflict; decidedAt?: string }[]` | WT-3 (state), WT-4 (content) | WT-3 |
| `WorkItem.runStartedBy?: string` (a `RunAuthoritySource` kind; WT-3 writes `"local-create-and-run"`) | WT-3 | WT-3 |
| Run IPC payload for a template item: `{ templateId, version, graphHash }` beside `agentName` | WT-3 | WT-3 |
| `TemplateStage.allowSubAgents?: boolean`, inside the graph hash | WT-6 | WT-2 (a hash change after PR-A would invalidate confirmed versions) |
| `StageGate` pass kind `{ kind: "model_verdict" }`, inside the graph hash | WT-7 | WT-2 (same reason) |
| A bound on `stageRuns[].output` in `board.json` (Q7) | WT-3 | WT-2 |

## 10. Open questions (not decided here)

| # | Question | What the plan does meanwhile |
| --- | --- | --- |
| Q1 | D6 says the breaker counts "per session, as for any child today". Today it counts per root, and for board children per item, never reset in the process (F1). Is the intent a per-session count for run members only (this plan), for every child, or the current per-item count? Should the never-reset count of the shipped plan / execute flow be fixed separately? | Per session for run members; shipped flow untouched. |
| Q2 | Does one attempt counter cover both `Request changes` and `Retry stage` (cap 3 in total), or does each have its own? | One counter. |
| Q3 | Does a template's plan stage use the shipped `planApproval` object, or the generic stage gate? (Remote decisions of either belong to WT-9.) | Generic stage gate; template runs never write `planApproval`. |
| Q4 | D7: carrying taint makes a downstream stage start with the existing other-principal treatment that a child gets after its first file read. Is that the intended reading of "taint carries"? | Yes, carried as described. |
| Q5 | Settled by the lead: `Create and run` binds to the run pin tuple, and unattended start waits for WT-14. Still open: must the tuple be the template's current version, or may the user start an older confirmed version? | Any stored confirmed version whose tuple matches. |
| Q6 | After a restart, should ready stages start by themselves, or only after a user action (this plan; fail-closed, since no approval surface exists at boot)? | User action only. |
| Q7 | What bound applies to a stored stage output, and where does the rest go (transcript file)? | 48 000 characters assumed; needs WT-2. |
| Q8 | `check_exit_zero`: the board's tool step keeps only an 80-character label (`work-board-types.ts:283-297`). May the engine read the child's final transcript entries for the exact command and its exit status? If the host cannot prove it, the gate fails. | Reads `SubAgentSpawnResult.entries`; unverified that they carry an exit status. |
| Q9 | Limits: parallel stages per step (3), sub-agents per stage, and whether `MAX_TRACKED_RUNS = 100` (`subagent-runner.ts:640`) needs raising. | 3; 3; unchanged. |
| Q10 | W1 worktree location. It must not sit under a forced-ask path (`.git`, the Ave home) or inside the project tree. Candidates: a sibling folder of the project, or an app data folder outside the Ave home. | Left to the provider's `worktreesRoot`; needs an owner choice before WT-4 starts. |
| Q11 | W1 merge target and dirty trees: merge into the project's checked-out branch (this plan) or into a run branch the user merges later? Uncommitted user changes are not visible in stage worktrees; a merge they block becomes the conflict gate. Is that acceptable? | Checked-out branch; dirty target → conflict gate. |
| Q12 | W1 host commits: which author identity seals a stage's work, and is a host commit in the user's repository acceptable at all? Git-ignored files (dependencies, build output) are absent from a fresh worktree; is a per-template setup step needed? | Host identity placeholder; no setup step. |
| Q13 | Is the project's workspace revocation (`subagent-runner.ts:1066`) required to stop children running in that project's worktrees? Unverified that it does, since their root differs. | Engine interrupts stage children itself when the project root is revoked; needs a check. |
| Q14 | For WT-14: one item reused per routine or a new item per fire; whether an open main window receives an unattended run's tool cards; which version a binding follows. | Not designed here. |
| Q15 | D9: is the verdict the judged stage's own structured ending (this plan) or a separate host model call over the output with a stored criterion? | Stage's own ending. |
| Q16 | Item status while only gates wait: `awaiting_approval` without `planApproval` changes what `work-board-lifecycle.ts:10, 21, 29-30` and the board read. Accept, or keep `executing` and derive Review from `stageRuns`? | `awaiting_approval`. |
