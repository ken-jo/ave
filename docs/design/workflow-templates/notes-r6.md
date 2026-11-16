# Work Board — user-built workflows (mockup round 6)

Offline design mockup. `artifact.html` changes browser memory only: no IPC, no network, no storage, fictional data. Product code was not changed; main `c2214d704` was read, not edited.

The page is the round-5 mockup with one added layer. Every round-5 board flow still runs in Interactive. The round-5 13-step storyboard is replaced by the storyboard below, and its `View setup steps` button, which reopened that storyboard, is removed.

## Words used here and in the UI

| Word | Meaning |
| --- | --- |
| Template | A reusable stage graph the user built. New. |
| Version | One confirmed, immutable snapshot of a template (v1, v2 …). New. |
| Workflow | The shipped `WorkItem`, as in round 5. It may follow a template. |
| Run | One execution of a workflow. Shipped (`runId`). A run is pinned to one template version. |
| Stage run | One stage's session(s) inside a run. New. |

Shipped controls keep their shipped labels (`Run history`, `Stop`, `Approve & complete`, `Allow once`, `Deny`, `Request changes`, `Reject`, `Approve and run`). New labels are proposals: `Templates`, `New from template`, `Describe a new workflow`, `Draft stages`, `Edit stages`, `Review and confirm`, `Confirm and save v1`, `Create and run`, `Approve and continue`, `Retry stage`.

## Storyboard: 8 screens, 12 sheets

| Sheet | Screen | What it shows |
| --- | --- | --- |
| 1 | 1 Empty state | Centre start card "What should get done?", project choice, `Start from a template` / `Describe a new workflow`, three example templates, `Suggest work with a briefing`, step-order preview, note that the map appears once a workflow exists |
| 2 | 2 Description → draft | The user's sentence, the drafted graph (7 stages, 1 parallel step), what the draft assumed, a warning the draft raised about its own gate choice |
| 3 | 3 Editing | Parallel lane, `+` and `+ Parallel stage`, stage settings: role, inputs, tools, profile, gate (human or automatic with a pass condition), order controls |
| 4 | 4 Confirm | One table of step / stage / profile / tools / gate, the graph hash, "confirming grants no permission", what every run still asks |
| 5a | 5 First run | Project → workflow → stage graph; three stage sessions live at once; session table |
| 5b | 5 First run | Two tool approvals from two parallel stages in one queue; the third stage keeps running |
| 5c | 5 First run | Three results handed to Review as quoted data, with the evidence each automatic gate used |
| 5d | 5 First run | Human stage gate on Review: Approve and continue / Request changes / Reject |
| 6 | 6 Final review | All stages passed, result saved, `Approve & complete` |
| 7a | 7 Later run | Start card with the confirmed template selected; list of what this run still asks; composition is not in the list |
| 7b | 7 Later run | Workflow #202 already in its Plan stage, pinned to v1, "Composition: None" |
| 8 | 8 Version 2 | Editor on a copy of v1 with New / Changed marks, diff, the in-flight run that stays on v1, `Review and confirm v2` |

Each sheet has a two-part Korean caption: what the system set up, then what the user can do.

Interactive adds: `Templates` and `New from template` in the board tool row; a template list with version history; the description → draft → edit → confirm path with a small local parser; run view driven by `Simulate update` (tool queue, gates, change request with a required note, a simulated stage failure, `Retry stage`, `Stop`, `Run again`, final review); `First-visit view`. A workflow that follows a template carries a small tag on its Map node and Lanes card and opens the run view.

## (a) Data model

```ts
interface WorkflowTemplate {
  id: string;                 // host-issued
  name: string;               // ≤ 60
  scope: { kind: "all" } | { kind: "project"; projectRoot: string };
  description?: string;       // the user's sentence, kept as data
  currentVersion: number;
  createdAt: string; updatedAt: string; archivedAt?: string;
}
interface TemplateVersion {   // immutable once confirmed
  templateId: string;
  version: number;            // strictly increasing
  graphHash: string;          // sha256 of canonical stages + edges, host-computed
  stages: TemplateStage[];    // ≤ 12
  edges: TemplateEdge[];
  confirmedAt: string;        // the user's confirmation; a draft has no version
  basedOn?: number;
}
interface TemplateStage {
  id: string;                 // stable inside a template across versions
  name: string;               // ≤ 40
  goal: string;               // role or goal, ≤ 400; instruction text for that stage
  kind?: "plan";              // derived, not authored: the first step when it is one read-only stage with a human gate
  inputs: string[];           // earlier stage ids whose outputs are passed in
  toolScope: "read" | "all";  // read = shipped plan scope, all = shipped execute scope; only narrows
  agentName?: string;         // an agent profile; absent = default model
  gate: StageGate;
}
type StageGate =
  | { type: "human" }                                        // a work approval
  | { type: "auto"; pass: { kind: "stage_ok" } | { kind: "check_exit_zero"; command: string } };
interface TemplateEdge { from: string; to: string }          // control order; a stage starts when all its `from` stages passed
interface WorkItemStageRun {
  stageId: string;
  attempt: number;            // 1..3
  status: "waiting" | "running" | "awaiting_gate" | "passed" | "failed" | "cancelled" | "rejected";
  childSessionId?: string;
  startedAt?: string; endedAt?: string;
  output?: string;            // the stage child's final message
  outputHash?: string;        // a gate decision binds to this
  gate?: { type: "human"; status: "pending" | "approved" | "changes_requested" | "rejected"; note?: string; decidedAt?: string; revision: number }
        | { type: "auto"; passed: boolean; evidence: string; evaluatedAt: string };
}
```

**Run.** A run stays what it is today: one `runId` on the item, archived into `runHistory` on the next run. The item carries `templateId` (set at creation, user-chosen). Each run takes its own pin when it starts: `runTemplateVersion` and `runTemplateGraphHash` are written by `beginRun` from the template's current version, together with a fresh `stageRuns: WorkItemStageRun[]`. `Run again` therefore uses the version current at that moment, and a run in flight never moves. `WorkItemRunHistoryEntry` gains `templateVersion`, `templateGraphHash` and a compact `stageRuns` summary so an old run stays readable. All of these are optional and engine-written; an item without `templateId` runs the shipped flow unchanged. The built-in flow is shown as a template "Plan → Run → Review", but it stays the shipped code path and has no stored template.

The mock's editor only produces series-parallel graphs (ordered steps; a step holds 1–3 stages; every stage of a step depends on every stage of the step before). `edges` is general so a later editor is not blocked. The last stage's gate is always the shipped result review.

## (b) Shipped versus new

| Area | Shipped (reused as is) | New |
| --- | --- | --- |
| Item fields | `id title detail status priority due_at projectRoot projectName runStatus plan output runSessionId runId runHistory planApproval` | `templateId`; per run: `runTemplateVersion runTemplateGraphHash stageRuns`; the same three on each `runHistory` entry |
| Run status | `idle planning awaiting_approval executing completed denied error cancelled` | none at item level; stage detail lives in `stageRuns[].status` |
| Derived Review | pending plan, or saved result | also: a stage run in `awaiting_gate` (proposal; the mock keeps the round-5 lane rule and adds a "needs you" tag) |
| Plan approval | `WorkPlanApproval` (runId, planHash, itemDigest, revision, note), `decideWorkPlan` / `ave:work-board:decide-plan` | add `templateGraphHash` to what the approval binds to |
| Stage gate | — | `decideStageGate(itemId,{runId,stageId,attempt,outputHash,decision,note?})` / `ave:work-board:decide-stage` with the same refusal set as plan decisions |
| Start a run | `runWorkBoardItem(id,{agentName?})` / `ave:work-board:run` | same channel; the engine reads the item's template fields. `agentName` per stage comes from the template |
| Progress | `ave:work-board:run-progress|run-started|run-finished|run-failed`, `WorkBoardRunEvent` | add optional `stageId` and `attempt` to the event; add phases `stage_gate`, `stage_passed`, `stage_failed` |
| Steer | `steerWorkBoardRun` / `ave:work-board:steer-run` | add `stageId` (the host resolves the child, never the renderer) |
| Stop | `cancelWorkBoardRun` / `ave:work-board:cancel-run` | unchanged call; engine stops every live stage |
| Retry | Run again = new run | `retryWorkBoardStage(itemId,{runId,stageId})` / `ave:work-board:retry-stage` |
| Transcript | `getWorkBoardRunTranscript` / `ave:work-board:run-transcript`, `RunTranscriptEvent` | add `stageId`, `attempt` to events |
| Tool approvals | `useBoardApprovals`, claims keyed by child session ids, window FIFO, `workBoard.toolApprovalSurface` | no new IPC; the hook must claim every stage child id of the item |
| Templates | — | `listWorkflowTemplates`, `getWorkflowTemplate`, `draftWorkflowTemplate(description, projectRoot)`, `confirmWorkflowTemplate(templateId|null, {name, scope, stages, edges, graphHash, basedOn?})`, `archiveWorkflowTemplate`, `onWorkflowTemplatesChanged`; channels `ave:work-board:template-list|template-get|template-draft|template-confirm|template-archive|templates-changed` |
| Creation | `addWorkBoardItem` (`WorkItemCreateInput`) | add optional `templateId` only; the version and hash are pinned when each run starts, not at creation |
| Storage | `~/.ave/work-board/board.json`, `BOARD_VERSION = 1` | `stageRuns` in the item; `templates.json` beside it with its own version field. Adding fields to `board.json` needs a version decision in `src/work-board/board-file.ts` |
| Empty state | per-column texts only ("No planned tasks." …); no whole-board empty state | the start card |
| Agent profile | IPC accepts `agentName`; the renderer never sends one; one profile for both phases | a profile per stage, chosen in the editor |

Checked in source: the 22 `ave:work-board:*` channel names, the engine, the shared types, the permission tree. Taken from a read-only survey and spot-checked by grep only: store method list, preload method names, `use-board-approvals.ts`, the routine tool, the empty-state strings.

## (c) Engine changes

Today the engine assumes one child per item. These all change: `inFlight: Set<number>` (work-board-engine.ts:429), `planSettling` (:431), `executingChildByItem: Map<number,string>` (:434), `cancelRequested` (:438), `executingTurnByItem` (:441), `guarded()` attaching one approval surface per item phase (:468–481), `steerRun` / `cancelRun` resolving the single child (:936, :961), and the store's single `runSessionId`. The sub-agent runner itself has no per-origin limit (`activeChildren` is keyed by child session id), so several children under `work-board:<id>` are possible without a runner change.

1. **Stage scheduler.** A per-run loop owned by the engine. A stage is ready when every incoming edge's stage is `passed`. Ready stages start together, up to a host constant (the mock uses 3 per step). The item stays in `inFlight` for the whole run; a per-item map `stageId → {childSessionId, turn, cancelRequested}` replaces the three single-child maps. Nothing waits in memory for the user: after a human gate is stored the loop returns, as `planPhase` does today, and `decideStageGate` continues the run.
2. **Parallel children.** Each stage is one `runner.spawn` with `originSessionId = work-board:<id>`, the stage's tool scope (`exactToolScope(read-tier names)` or `PARENT_ALL_TOOL_SCOPE`), the stage profile's model, and for read stages the shipped 20-round budget. `agent_spawn` stays stripped by `SUB_AGENT_TOOL_BLOCKLIST`. Children of one step share the project folder; the scheduler does not isolate their file writes (see risks).
3. **Passing outputs on.** The next stage's prompt is built by the host: its own goal as the instruction, then each selected input as a host-fenced, quoted block marked non-principal, the way `formatPlanRevisionDirective` fences the prior plan and the user's note. Size is bounded per input and in total. A stage never reads a sibling's transcript. A stage output is never stored as a template field or an instruction.
4. **Gates.** Human: store `output`, `outputHash`, `gate.status = pending`; emit; return. Decision: approve → `passed`; request changes (note required, ≤ 2000, control characters refused) → same stage, `attempt + 1`, note passed as fenced data; reject → run ends `denied`, no later stage starts. Automatic: the host evaluates the pass condition from facts it already holds — the child's `ok` result, or the recorded status of the stage's own tool step for the named command. It never runs a command itself and never reads the model's claim. A condition that cannot be evaluated fails the gate. A stage whose needed tool call was denied ends `failed` with no result; it never reaches its gate (the mock does this on `Deny`).
5. **Failure and retry per stage.** A failed stage (child `ok:false`, or a failed automatic gate) becomes `failed`. Its running siblings are left to finish and their results are kept. The join does not open. The run stays active with that stage marked; the user chooses `Retry stage` (new child, same inputs, attempt ≤ 3) or `Stop`. There is no automatic retry.
6. **Stop.** One user gesture interrupts every live stage child through the existing `interruptRun`, drops their queued steers, settles pending tool cards through the gate's own abort handling, and marks pending human gates cancelled. The run settles `cancelled` once all children have unwound. Finished stage results stay in the record. `Run again` starts a new run on the template's current version.
7. **Restart.** `reconcileInterruptedRuns` must settle stage runs too: `running` → failed-interrupted; `awaiting_gate` survives, like a pending plan approval.
8. **Pinning.** A run reads its stage graph from the pinned `(templateId, version, graphHash)`. If the stored version's hash differs, the run refuses to start. Confirming v2 never touches a run in flight.

## (d) Owner decisions for the permission tree

Source: `docs/architecture/permission-decision-tree.md` (v4). Nothing below is decided. The mock shows the conservative option in each case and tags the spot `Owner decision D…` where it is visible.

| # | Question | Node it touches | Option A | Option B |
| --- | --- | --- | --- | --- |
| D1 | What authorises creating all-tools stage children — for several stages, for stages that start after an automatic gate, and for a template with no plan gate? | Edge `ALLOW -.-> CHILD` ("허용된 위임·루틴 생성 · 승인된 업무 계획") and the note "Work approvals" (a plan approval "only authorizes creating the execute child") | Keep "approved work plan" as the only work-level authority. Every run that has an all-tools stage starts with the plan stage, and its plan approval is the one work approval that authorises stage children. It binds to plan hash + item digest + template graph hash and covers the stage children of that pinned version only, including ones that start later behind automatic gates. Template confirmation authorises nothing. Later human stage gates (D3) only release the scheduler; they are not a second source. The editor refuses a graph with an all-tools stage whose first step is not one read-only stage with a human gate. *(shown in the mock; even this option widens "the execute child" to "the stage children of the approved plan", which is why it is a decision)* | Add a third source to the `CHILD` edge: a confirmed template version plus the local `Create and run` gesture. A template without a plan gate then starts all-tools stages with no per-run approval. |
| D2 | May a stage session start sub-agents? | `CHILD → H` (admission of the child's calls) and the note "Delegated work"; in code the runner blocklist that strips `agent_spawn` | No. Parallel work exists only as host-scheduled stages. *(shipped; shown)* | A per-stage opt-in, depth 1. Needs rules for approval-surface inheritance, card attribution and the reviewer breaker for grandchildren. |
| D3 | Is a human stage gate — and the template confirmation — a work approval? | Note "Work approvals" (user decision on a host work object, desktop window, keyboard gesture, bound to an exact hash, outside the tree, "Remote controllers cannot decide work approvals") | Yes, same class. A stage gate binds to run + stage + attempt + output hash; a confirmation binds to the graph hash. Local desktop gesture only. It only lets the scheduler start the next stage(s); every tool call still enters `CHILD → H`. *(shown)* | Let a bound remote owner decide stage gates. This changes the quoted sentence. |
| D4 | How are tool cards from parallel stage children ordered and shown? | `ASK` (card delivery) and the note "App approval delivery" | Keep the window's single first-in-first-out queue and one visible card; label each card with its stage; a waiting stage blocks only itself. *(shipped behaviour extended; shown)* | One lane per stage, several cards visible at once, each still decided separately. Neither option batches or pre-approves. |
| D5 | Does a remembered approval apply across sibling stage sessions of one run? | `R` ("ask / allow 규칙 · 기억된 승인") and "Delegated work" (children are independent sessions) | No. Each stage session asks for itself; only saved rules, which already apply to every session, carry over. More cards, no tree change. | A new run-scoped remembered grant shared by the stage sessions of one run. A new scope at `R`. |
| D6 | In auto mode, what is the reviewer breaker's scope with N parallel children? | `RV → ASK` ("재요청 뒤 high · 오류 · 3연속 / 턴 20회 거부 뒤") | Per stage session, as for any child today. | Count across the whole run, so N stages cannot multiply the allowance. |
| D7 | Does a stage result that passed only an automatic gate count as another principal's content for the next stage? | `F` (질문† trigger "다른 주체 턴") and `T` (origin / envelope check) | No new floor. Results are host-fenced quoted data, never instructions; external-content taint already present in a result carries into the next stage. | Treat any result that no human approved as other-principal content: the next stage's effects are ask-forced until a human gate passes. |
| D8 | May a template run start with nobody present (from a routine or a schedule)? | `Q` ("사람 없음: 모델에 알림" → deny) and "Work approvals" | No. Runs start from a local gesture. Human gates wait with no timeout. A tool ask with no human is denied, as the tree says. *(the mock offers no unattended start)* | Allow a routine to start a run; human gates park in Needs review; headless tool asks still deny. |
| D9 | Does an automatic gate stay a non-permission? | None if A (it is not a tree node); `Q` / `RV` if anyone later wants a gate to stand in for an ask | Yes. It is a scheduler predicate over host-held facts. It never answers, skips or pre-fills a card. The check command is the stage's own tool call and asks like any other. *(shown; UI text says so)* | Allow model-judged pass conditions ("the reviewer stage says OK"). Still not a permission, but the predicate is a model's claim. |

Recommendation on merit, for the owner to accept or reject: A for D1, D2, D3, D4, D5, D7, D8, D9. D6 is a real trade-off: A changes nothing, B is the stricter reading for unattended-looking fan-out.

No tree change is needed for these, and the mock relies on them as written: a shared browser / terminal surface choice and agent-browser site grants are never inherited, so each parallel stage session asks for itself; `sandbox-unavailable` session grants are per requesting session; each stage child's calls pass the full tree in tree order.

## (e) Natural-language authoring and the routine pattern

How a routine is made today (survey, spot-checked): the model calls one built-in tool, `routine_schedule` (`category: "write"`). The user sees the generic tool-approval card "Manage this scheduled task?" with three fields (`action`, `title`, `routineId`); the schedule and the prompt are not on the card. The host stores a `RoutineRecord` in `routines.json` (version 2). Each later fire builds a fresh headless conversation; anything that would ask is denied with "Nobody can approve this request; do not retry."

| Step | Routine | Template (proposed) |
| --- | --- | --- |
| User input | A sentence in chat | A sentence in the start card or in chat |
| Who drafts | The model, as tool input | A read-only drafting child, like the briefing survey (`runBriefing`): read-tier tools, bounded rounds, output is one fenced JSON block the host parses and bounds (`extractJsonArray` / `boundedRows` pattern) |
| What the draft is | A tool call waiting on a card | A draft record: data only, not a template, nothing runnable |
| What the user sees before saying yes | Three fields | The whole graph: every stage's role, inputs, tools, profile, gate; and it is editable first |
| The yes | A tool-approval card (inside the tree) | A work-level confirmation bound to the graph hash (D3) |
| Stored | `RoutineRecord` | `TemplateVersion` |
| Later | Fires headless; asks become denies | Runs attended; asks become cards; gates wait for the user |
| Changing it | `update` through the same tool | Edit a copy, confirm it as the next version; runs in flight keep theirs |

Kept from the routine pattern: describe once, confirm once, repeat without composing again. Changed on purpose: the confirmation shows everything that will repeat, and repeating never means unattended. A chat tool that proposes a template (`workflow_template_propose`) can reuse the proposal store pattern (`WorkProposal`: host-bounded untrusted text, accept or dismiss). It files a draft; it can never save a confirmed version.

Anything the parser cannot map to a known pass-condition kind becomes a human gate. A drafted stage name and goal are untrusted text until the user confirms the version.

## (f) Risks

- **Parallel writes to one project folder.** Sibling stages can edit the same file. The mock does not solve this. Options to weigh before building: a worktree per stage with a merge at the join, or a declared path scope per stage that the host enforces.
- **Card load.** Three parallel all-tools stages in Default mode produce many cards. Pressure to add batch approval must go through D4 / D5, not through the gate model.
- **Automatic gates read as safety.** `stage_ok` only means the child ended without an error. The editor warns when the last stage would start on automatic gates alone, and the draft raised that warning about its own first proposal.
- **Injection through results.** A stage that read untrusted content can carry it into a later all-tools stage. Fencing and D7 limit this; they do not remove it.
- **Template text is instruction text.** A stage goal becomes a child's instruction on every later run. Confirmation must show the full text and bind to its hash; any edit is a new version.
- **Cost and limits.** N children multiply model use and tracked runs (`MAX_TRACKED_RUNS = 100` in the runner).
- **Version skew.** A run must refuse to start if its pinned version or hash is missing.
- **Stop is not instant.** A child unwinds at its next boundary; an effect already running is not rolled back.
- **Lane meaning.** Review now also means "a stage gate waits". The round-5 lane rule is unchanged in this mock.
- **Scope of this mock.** Fixed coordinates, a toy parser, canned results. The permission card here is a sketch of the shipped card, not a replacement.

## Delivery and checks

`out/artifact.html` is a fragment: it starts with `<title>Work Board Workflows</title>` and the `claude:viewport-fit-sides` meta, has one `<style>` and one `<script>`, and no doctype, html, head or body tag. It adds no colour token; the `:root` tokens and both dark blocks are the round-5 Ave tokens. Scratch sources and test scripts are in `build/` (not a deliverable).

Run in headless Chromium against a wrapper page:

- **738 assertions, 0 failures:** all 12 sheets × 6 runs (390×844 and 1280×1450, light and dark by media emulation; plus 390 dark and 1280 light forced by `data-theme` against the opposite system scheme). Per sheet: no horizontal page scroll, caption ≥ 15px, every button outside the scaled window ≥ 44px tall, window 1280×800, no panel past the pane edge, no clipped stage graph, page background matches the theme; per run: Interactive board, Templates, editor and the 100% zoom state repeat the scroll, 44px and caption checks; no console error, no non-file request.
- **55 interaction assertions, 0 failures:** one shipped item driven through the wrapped `Simulate update` (planning → plan review → Approve and run → tool approval → result → Approve & complete); board-level Simulate advances a template workflow with the stage machine only; a denied tool call fails its stage and keeps the join closed; deleting a template workflow through the shipped flow leaves the editor working; round-5 inspector, Lanes, reports and creation still open; template tag on Map and Lanes; tool queue (second request not decidable before the first); stage gate with a required note; failure blocks the join; retry; final review does not complete by itself; completion folds into the done bundle; a later run starts with no draft; v2 needs its own confirmation and the in-flight run stays on v1; the editor's add / remove / move / split / merge; confirm disabled when no human gate precedes an all-tools stage; description parser; first-visit card; built-in template opens the shipped creation panel; Stop interrupts every live stage; mode switches keep state.
- Looked at by eye: all 12 sheets at 1280 light, sheet 5b at 1280 dark, the 390 dark page, the 390 zoomed page, the Interactive board, the Templates list and the failed-stage state. Other captures (Lanes, v2 confirmation, description draft in Interactive, the remaining dark and phone sheets) were measured but not opened.
- `ref/`: one image was opened, as a layout reference for the radial map only. No text, name or wording from it was used.

Not checked: the round-5 876-assertion suite was not re-run (its scripts are not in this folder); 100% zoom panning on a real phone; screen-reader output; any real Electron, IPC, sub-agent or permission behaviour.
