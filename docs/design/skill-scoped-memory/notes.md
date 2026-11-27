# Skill-scoped memory

Status: proposal for owner review. Open [mockup.html](mockup.html) in a browser and switch between **A** and **B**. Both use fictional records and show proposal review, approval, rejection, and forgetting with undo. The page runs locally in English and Korean, with light, dark and system themes.

## Current behavior

Ave has no skill-owned memory, skill-specific recall, or skill-specific write grant. A conversation that loads a skill continues to use its own memory context and tools. Prompt selection and `memory_search` / `memory_read` can include eligible active notes from the current project and managed global notes. Legacy unscoped notes are also visible for the default project and for callers without a project. The host uses the session's project context and excludes expired notes and derived summaries from regular recall. [Memory manager](../../../src/memory/memory-manager.ts) · [Recall tools](../../../src/tools/memory-recall.ts)

The conversation can use `memory_write` through the usual tool permission pipeline. New notes default to the current project. An explicit global scope applies across projects, and a session without a project saves globally. Updates require an ID visible to the session. Writes and deletes refuse tainted turns. Accepted writes become active immediately and emit an undo notice. The loader approves and tracks skill instructions and resources in a per-conversation overlay. Load approval grants no separate memory access. [Write tool](../../../src/tools/memory-write.ts) · [Skill loader](../../../src/tools/skill-load.ts) · [Skill overlay](../../../src/main/skill-overlay.ts)

The Memory view shows project/global entries and their kind, source, origin, use, and history. The embedding map's design used playbooks as a facet, and its current catalog has no skill ownership dimension. The work-board review lanes inform layout B. [Memory view](../../../src/ui/renderer/components/MemoryView.tsx) · [Memory detail](../../../src/ui/renderer/components/MemoryDetailContent.tsx) · [Map catalog](../../../src/main/memory-map/catalog.ts) · [Embedding map design](../memory-embedding-map/notes.md)

## Proposed layouts

| Variant | Control-room entry | Best fit |
| --- | --- | --- |
| **A · Skill library** | Memory → Skills → selected skill | Inspect what one skill can recall, which entries are saved, and which proposals are waiting. Recommended as the primary home. |
| **B · Review board** | Work board → Memory review | Review proposals across skills in the selected project, with pending and saved lanes and a shared inspector. |

## Data and reuse

- Add a managed scope keyed by a host-issued durable skill identity and canonical project identity. Carry the source kind, canonical source identity and reviewed content fingerprint in the binding. The fingerprint identifies the loaded revision, with a fresh binding on change. Display names and model-supplied selectors confer no ownership. Multiple loaded skills require an explicit, host-verified invocation binding. Start with local skills. Removal or replacement suspends access and leaves entries available to the owner for review or deletion.
- Reuse managed note IDs, kind, provenance, history, expiry and digest-bound undo. Add a versioned proposal record with the target scope, proposed text, content digest, source conversation/turn and approval state. Keep pending proposals outside the active catalog, prompt, recall, map and consolidation inputs. Approval consumes the exact proposal once and creates an active note. Rejection discards the pending content. Forget removes the active note from future recall and derived indexes, with the existing undo semantics. Existing global and project notes retain their scopes. [Memory manager](../../../src/memory/memory-manager.ts) · [Save notices](../../../src/memory/memory-save-notices.ts) · [Feature namespace](../../../src/main/storage/feature-namespace.ts)
- Enforce exact scope in the host on listing, ID lookup, prompt selection and mutation. Only an invocation with a current skill binding can recall its saved skill notes in the selected project. Reuse the skill loader's identity and live checks, the Memory catalog and detail UI, and IPC sender guards for owner review. Keep search, use and history projections scoped. Fence recalled content as data. [Skill store](../../../src/main/skill-store.ts) · [Memory search panel](../../../src/ui/renderer/components/MemorySearchPanel.tsx) · [Memory IPC](../../../src/ipc/domains/chat.ts)

## Permission placement

Route model-initiated proposals through the existing permission tree. Verify origin and envelope at **T**, then check admission and deny rules at **H**. The skill/project binding is host evidence for admission. Missing, stale or ambiguous evidence refuses under **U3**. Preserve **F** floors and the **UN** unattended path. Start with attended proposals only. Under **R → K → Q**, classify the durable proposal as a write to host-managed memory. The in-project reversible-file shortcut cannot authorize it. Apply existing rule, mode and reviewer outcomes. If the tree asks, **LIVE** rechecks authority at answer and execution. Check the binding again at the effect, and apply existing source-taint, credential and text checks before persisting the proposal. [Owner-approved permission decision tree](../../architecture/permission-decision-tree.md) · [Permission policy](../../architecture/permission-policy-design.md)

An allowed tool call can create a private pending proposal. The account owner then approves the exact content, scope and source revision in the control room. Recheck identity and the proposal digest at commit and refuse stale approvals. This product action grants no future tool authority. Existing skill-load consent covers the instructions and declared resources. The automatic memory reviewer can help with content checks. Admission and acceptance stay with the tool pipeline and account owner, respectively. [Skill approvals](../../../src/main/skill-approvals-store.ts) · [Memory capture service](../../../src/memory/memory-capture-service.ts) · [Memory reviewer](../../../src/memory/memory-reviewer-service.ts)

## 오너 결정

1. **기본 진입점은 어디로 둘까요?** 첫 버전은 A(메모리 → 스킬)를 권장합니다. B(작업 보드 → 메모리 검토)는 여러 스킬의 대기가 쌓일 때 추가 진입점으로 적합합니다.
2. **같은 스킬의 메모리를 다른 프로젝트에서도 읽게 할까요?** 첫 버전은 스킬 × 프로젝트 범위의 읽기와 쓰기 제안만 권장합니다.
3. **스킬 제안을 언제 저장할까요?** 기존 도구 권한을 통과한 뒤 계정 소유자가 항목별로 승인할 때 활성 메모리에 저장하는 방식을 권장합니다. 첫 버전은 로컬 스킬과 사람이 있는 실행으로 시작하는 안입니다.
