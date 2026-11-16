# Workflow templates — owner decisions and work plan

Owner decisions of 2026-11-16 on the round-6 mockup, which is [mockup-r6.html](mockup-r6.html) with [notes-r6.md](notes-r6.md); the published mockup is <https://claude.ai/artifact/BX5Bdvoe6CzcSmSu2HNFVn>. Round 7 applies these decisions and replaces both files when it lands.

The feature: a user builds a reusable stage graph, for example plan → backend / frontend / design in parallel → review → UI test → publish. It can be described in natural language, as a routine is. The user confirms it once as a version. Later runs repeat that confirmed version without composing it again.

## Decisions

Option text is quoted from notes-r6.md section (d). "A" or "B" refers to that table.

| # | Decision | What it means for the build |
| --- | --- | --- |
| D1 | **B** | A third source on the permission tree's `ALLOW -.-> CHILD` edge: a confirmed template version plus the user's `Create and run` gesture authorises that run's stage children, including all-tools stages, with no per-run plan approval. A plan stage is optional. Confirmation binds to the graph hash, and a run pinned to `(templateId, version, graphHash)` may only create the stage children of that version. Every tool call of every stage child still enters `CHILD → H` in tree order. |
| D2 | **B** | A stage may opt in to sub-agents, at depth 1 only. Grandchildren inherit the stage's approval surface. Their cards name the stage and the grandchild. They are counted by the reviewer breaker as their own sessions (D6). They may not spawn further. |
| D3 | **B, redesigned for the Tailnet** | Work approvals can be decided remotely: stage gates, plan approvals, **template confirmation and `Create and run`**. Remote decisions are accepted only through the existing Tailnet surface. That means: Tailscale Serve ingress to the loopback-only `TailnetSurfaceServer`, a current owner-identity match from the Serve identity headers, a paired, bound session, and the controller role. LAN, Funnel, public links and any other ingress are refused, fail-closed. A remote decision binds to exactly the same object hash as a local one (run + stage + attempt + output hash; graph hash for confirmation) and is audited with origin `tailnet-surface`. Without the Tailnet configured, work approvals stay local-desktop only. The sentence "Remote controllers cannot decide work approvals" in the permission tree's Work approvals note changes accordingly. |
| D4 | **B** | One approval lane per stage. Several cards may be visible at once, and each is decided separately. Nothing batches or pre-approves. |
| D5 | **B** | A new run-scoped remembered grant at node `R`: "Allow for this run" is shared by the stage sessions (and their grandchildren) of one run. It ends when the run ends, is never saved as a rule, and never crosses runs or items. Floors that the tree marks as non-rememberable stay non-rememberable. |
| D6 | **A** | The reviewer breaker counts per session, as for any child today. |
| D7 | **A** | No new floor. Stage results pass on as host-fenced quoted data, never as instructions. External-content taint already present in a result carries into the next stage. |
| D8 | **B** | A routine or schedule may start a template run. Human gates park in the board's Needs review, with no timeout, and can be decided locally or over the Tailnet (D3). Tool asks with nobody present are still denied, as the tree says. |
| D9 | **B** | A pass condition may be model-judged ("the reviewer stage says OK"). It is labelled as a model judgement, is still a scheduler predicate, and never answers, skips or pre-fills a permission card. |
| W1 | **Stage worktrees** | Parallel stages each run in their own git worktree of the project. At the join the host merges them. A merge conflict turns the join into a human gate showing the conflict. A project that is not a git repository runs its parallel stages one after another and says so. |

The permission tree (`docs/architecture/permission-decision-tree.md`) changes for D1, D2, D3, D5, D8 and D9. The owner approved these changes on 2026-11-16. The tree edit lands first, in the same PR as the host code that implements it, and every implementer and reviewer brief attaches the tree.

## Work plan — 14 items

Each item ends in main. The lead (macOS session) owns the mockup, merges and the progress count. The Windows session owns implementation. Complex design and core items go to Fable sessions working in parallel, each in its own worktree. Lighter items go to Codex (gpt-6.1-sol high) under the existing routing. Every PR gets an independent read-only review from a different model than its author.

| ID | Item | Owner | PR topic |
| --- | --- | --- | --- |
| WT-0 | Round-7 mockup applying D1–D9 and W1: phone Tailnet decision sheets, per-stage approval lanes, run-scoped grant, sub-agent opt-in, routine start, model-judged gate, worktree join and conflict gate | Fable (macOS lead) | design branch |
| WT-1 | Permission-tree edits for D1, D2, D3, D5, D8, D9, with the mermaid order kept | Fable | PR-A host contract |
| WT-2 | Template store and data model: `templates.json`, immutable versions, host graph hash, `board.json` fields, a board-version decision, and template IPC (list / get / draft / confirm / archive / changed) | Codex | PR-A host contract |
| WT-3 | Stage scheduler: parallel stage children, fenced input passing, human and automatic gates, retry ≤ 3, Stop, restart reconcile, version pinning, D1 authority | Fable | PR-B engine |
| WT-4 | Stage worktrees and the join merge (W1), including the conflict gate and the fallback for projects that are not git repositories | Fable | PR-B engine |
| WT-5 | Approval delivery: per-stage lanes with several visible cards (D4), the run-scoped grant (D5), and the breaker per session (D6) | Fable | PR-B engine |
| WT-6 | Per-stage sub-agent opt-in at depth 1 (D2) | Fable | PR-B engine |
| WT-7 | Model-judged pass conditions (D9) | Codex | PR-B engine |
| WT-8 | Routine or schedule start with parked gates (D8) | Codex | PR-B engine |
| WT-9 | Remote work approvals over the Tailnet (D3): stage gates, plan approvals, template confirmation, `Create and run`; fail-closed ingress and identity checks; audit | Fable | PR-C remote |
| WT-10 | Natural-language drafting: a read-only drafting child, draft records, and the `workflow_template_propose` chat tool (it files drafts only) | Codex | PR-D authoring + UI |
| WT-11 | Desktop UI from the round-7 mockup: start card, templates, editor, confirm, run view, stage lanes, v2 diff, i18n for every locale | Codex | PR-D authoring + UI |
| WT-12 | Phone Tailnet Web UI for work approvals (D3) | Codex | PR-C remote |
| WT-13 | End-to-end and real-machine verification: Windows by the Windows session, macOS by the lead over CDP and computer use, including a real Tailnet phone decision | Windows + lead | each PR, then a final pass |

Order: PR-A → PR-B → PR-C, with PR-D in parallel once PR-A merges. WT-11 and WT-12 wait for the WT-0 mockup.
