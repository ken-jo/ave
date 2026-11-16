# Workflow templates — owner decisions and work plan

Owner decisions of 2026-11-16. Mockup: <https://claude.ai/artifact/BX5Bdvoe6CzcSmSu2HNFVn>, updated in place for each round.
- [mockup-r6.html](mockup-r6.html) and [notes-r6.md](notes-r6.md): the round the decisions were taken on. Section (d) of notes-r6.md holds the original A/B option text.
- [unattended-review.md](unattended-review.md): the review behind OD-1..OD-4.

## What a workflow is

A **general-purpose** reusable stage graph. Code is one use, not the model. Examples the design must serve equally:
- Product: plan → backend / frontend / design in parallel → review → UI test → publish.
- Shorts: topic research → script and asset generation in parallel → assemble → review → publish.
- Daily report: gather sources on a schedule → summarise → review → deliver.

A workflow is described in natural language, as a routine is. It is confirmed once as a version, and later runs repeat that version without composing it again.

Nothing in the engine may assume a git repository, source code or a build. A stage works on files and tools. Git is one kind of workspace.

## Decisions

| # | Decision | What it means for the build |
| --- | --- | --- |
| D1 | **B** | A confirmed template version plus the user's `Create and run` gesture authorises that run's stage children, all-tools stages included. No per-run plan approval; a plan stage is optional. `Create and run` binds to `(templateId, version, graphHash)` and starts the template's **current** confirmed version. A mismatch, or an archived version, refuses to start. Every tool call of every stage child still enters `CHILD → H` in tree order. |
| D2 | **B** | A stage may opt in to sub-agents at depth 1. Grandchildren inherit the stage's approval surface, workspace, envelope and budget. Their cards name the stage and the grandchild, and their asks go to the user directly. They cannot spawn further. When a stage ends, its live grandchildren are interrupted. |
| D3 | **B, Tailnet only** | Every work approval can be decided remotely: plan approvals, stage gates, join-conflict gates, template confirmation, `Create and run`, schedule attachment (OD-1), and requested-output approval (OD-4). Remote decisions are accepted only through the existing Tailnet surface: Serve ingress to the loopback `TailnetSurfaceServer`, a current owner-identity match, a paired bound session, and a new controller capability for work decisions (added by PR-C). LAN, Funnel and every other ingress are refused, fail-closed. A remote decision binds to exactly the same hash as a local one and is audited with origin `tailnet-surface`. The identity shown is the Serve login; Serve supplies no device name. |
| D4 | **B** | One approval lane per stage. Several cards are visible at once and each is decided separately. Nothing batches or pre-approves. |
| D5 | **B** | `Allow for this run` is a run-scoped grant at `R`, shared by the stage sessions and grandchildren of one run. It matches with the tool's existing remember key, now scoped to the run. It ends with the run, is never saved, and never crosses runs or items. Non-rememberable floors offer no such option. Cards that are already open when the grant is made are not auto-answered. |
| D6 | **Per stage session** (corrected 2026-11-16) | Code today keys the reviewer breaker by the root session, so every child of one board item shares a counter. For template runs, each stage session (and each grandchild) gets its own breaker. The shipped single-run flow is unchanged. |
| D7 | **A** | No new floor. Stage results pass on as host-fenced quoted data, never as instructions. Taint carries into later stages. |
| D8 | **B** | A schedule can start a template run. Human gates park in Needs review with no timeout and can be decided locally or over the Tailnet. Authority and tool calls follow OD-1..OD-4. |
| D9 | **B** | A pass condition may be model-judged. It is labelled as a model judgement and the verdict is the stage's own structured ending. It never answers, skips or pre-fills a permission card. |
| W1 | **A per-stage workspace** (generalised 2026-11-16) | Every stage runs in its own workspace under `~/.ave/worktrees/<project>/<run>/<stage>/`. In a git project the workspace is a git worktree. Otherwise it is a plain folder seeded with the stage's declared inputs. The Ave-home read boundary re-allows a stage session only its own workspace (owner-approved tree change). At a join the host collects the results. For git, the stage commits merge onto a new branch `ave/workflow/<run>`; the user's checked-out branch and folder are never touched. For non-git projects, the stage outputs are collected into the run's output folder. A conflict (the same path from two stages, or a git merge conflict) becomes a human gate that shows it. Parallel stages run in parallel in both cases. |
| W2 | **Commit identity** | Host commits use the user's git identity with an Ave run/stage trailer. Gitignored files are never copied into a workspace. A template may declare setup commands (e.g. `bun install`), which ask like any other tool call. Secret files such as `.env` are never copied. |
| OD-1 | **A: schedule attachment** | A schedule runs a template only through a new work approval that attaches it to an exact `(templateId, version, graphHash)`, decided locally or over the Tailnet. The `routine_schedule` tool cannot create it. Confirming v2 does not move a schedule; the editor shows schedules still on v1. |
| OD-2 | **B: the unattended lane** | Stage sessions of a schedule-started run never ask. A call is allowed only inside the stage's **capability envelope** (confirmed with the version, inside the graph hash) and inside a proven OS sandbox and the stage workspace. Anything else is denied with "do not retry". The lane ignores ambient mode, allow rules, remembered grants and D5 grants. Interim rule: until WT-15 and WT-16 land, a schedule may start only templates whose stages are all read-only. |
| OD-3 | **B: reviewer narrows only** | Inside the envelope, the reviewer checks unproven or destructive sandboxed shell commands and declared tool calls, and can only deny. |
| OD-4 | **A: nothing leaves unattended** | Outward effects (publish, upload, post, send, push, merge, purchase) are **requested outputs**: data bound to `outputHash` that the host executes only after a human gate approves them, locally or over the Tailnet. Network domains and declared tools are empty unless the owner fills them in at confirmation. |

### General-purpose consequences for the envelope (lead ruling, 2026-11-16)

A Shorts or daily-report stage needs tools that are neither code nor read-only. Examples: a generation API, a plugin that renders media, fetching sources. An envelope may therefore declare, per stage:
- network domains;
- MCP or plugin tools without `readOnlyHint`, provided their effect is local generation or fetching. These are confirmed explicitly, and the confirm screen states that prompts and inputs are sent to the declared service.

A tool whose effect is outward publishing can never be declared in an envelope. It is reachable only as a requested output (OD-4). The unattended-review "readOnly MCP only" rule is widened accordingly. Everything else in section 5.7 of the review stays forbidden.

### Lead rulings on Fable's round-7 questions

- N1: answered by D5.
- N2: answered by OD-1.
- N3: the unattended lane never asks. In attended runs, tool cards follow the existing tree: a remote user counts as the user only for sessions they drive.
- N4: the stage workspace is the stage's project root for write policy.
- N5: answered by D5.
- N6: answered by D3. Join-conflict gates are work approvals.

Engine questions from the Windows plan:
- Q5 = current version only for `Create and run`; schedules use their attachment pin.
- Q16 = the Review lane is derived from `stageRuns` (`awaiting_gate`). `awaiting_approval` keeps meaning a pending `planApproval` and never appears without one.
- Q13 must be verified by a test (workspace revocation stops the stage children), not assumed.
- Q2–Q4, Q6–Q9, Q15, Q17 and Q18 keep the plan defaults.

The permission tree (`docs/architecture/permission-decision-tree.md`) changes for D1, D2, D3, D5, D6, W1 (Ave-home re-allow), OD-1 and OD-2 (the lane after `F`, unattended-review §5.8). The owner approved these on 2026-11-16. Every implementer and reviewer brief attaches the tree.

## Work plan — 19 items

The lead (macOS session) owns the mockup, the merges and the progress count. The Windows session owns implementation. Complex design and core items go to Fable sessions in parallel, each in its own worktree. Lighter items go to Codex (gpt-6.1-sol high). Every PR gets an independent read-only review by a model other than its author.

| ID | Item | Owner | PR topic |
| --- | --- | --- | --- |
| WT-0 | Mockup applying every decision above, with general-purpose examples (Shorts, daily report) | Fable (macOS lead) | design branch |
| WT-1 | Permission-tree edits for D1, D2, D3, D5, D6, W1, OD-1, OD-2 | Fable | PR-A host contract |
| WT-2 | Template store and model: versions, graph hash covering stages, sub-agent flag, pass kinds, envelope and setup commands; schedule attachments; board fields; template IPC | Codex | PR-A host contract |
| WT-3 | Stage scheduler: parallel children, fenced inputs, gates, retry, Stop, restart reconcile with parked gates, pinning, the run-authority function (D1 and OD-1 members) | Fable | PR-B engine |
| WT-4 | Per-stage workspaces (git worktree or plain folder) and join collection: new branch for git, output folder otherwise, conflict gate, hardened host git, W2 identity | Fable | PR-B engine |
| WT-5 | Per-stage lanes (D4), run grant (D5), breaker per stage session (D6) | Fable | PR-B engine |
| WT-6 | Per-stage sub-agents at depth 1 (D2) | Fable | PR-B engine |
| WT-7 | Model-judged pass conditions (D9) | Codex | PR-B engine |
| WT-8 | Schedule start with parked gates (D8, OD-1), read-only interim limit | Codex | PR-B engine |
| WT-9 | Remote work approvals over the Tailnet (D3) | Fable | PR-C remote |
| WT-10 | Natural-language drafting and the `workflow_template_propose` tool | Codex | PR-D authoring + UI |
| WT-11 | Desktop UI from the mockup, every locale | Codex | PR-D authoring + UI |
| WT-12 | Phone Tailnet Web UI for work approvals | Codex | PR-C remote |
| WT-13 | End-to-end and real-machine verification on Windows and macOS, including a real Tailnet phone decision and hostile fixtures | Windows + lead | each PR, then a final pass |
| WT-14 | Unattended safety review and owner decisions OD-1..OD-4 | Fable (macOS lead) | done 2026-11-16 |
| WT-15 | Envelope evaluator: the unattended lane in the decision pipeline | Fable | PR-E unattended |
| WT-16 | Unattended isolation profile: sandbox proof per OS, narrowed reads, secret and socket scrub, run-held egress list | Fable | PR-E unattended |
| WT-17 | Requested outputs: kinds, hash binding, host execution after the gate | Fable | PR-E unattended |
| WT-18 | Budgets and schedule breakers | Codex | PR-E unattended |

Order: PR-A → PR-B → PR-C. PR-D runs in parallel once PR-A merges. PR-E follows PR-B; it lifts WT-8's read-only interim limit. WT-11 and WT-12 follow the mockup.
