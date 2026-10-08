# Design Mockups

Self-contained HTML mockups that captured the **design intent** for shipped UX
features. They are kept in-tree so the visual reasoning, alternatives
considered, and copy/spacing/color choices remain reviewable after the code
ships and the original chat thread is gone.

These files are static — open them directly in a browser. They have no build
step and no dependency on the app.

| File | Feature | Shipped in |
|------|---------|------------|
| [`plugin-grid-v3.html`](./plugin-grid-v3.html) | 5×2 plugin grid in the input action bar — monochrome line icons, install overlay, marketplace link. | PR #437 |
| [`composer-attachments.html`](./composer-attachments.html) | Multimodal composer — image/file drag-drop, clipboard paste, marker tokens (`[Image #N]`, `[File #N]`, `[Pasted text #N +M lines]`), `composeOutgoing()` contract. | PR #440 |
| [`ask-user-question-card.html`](./ask-user-question-card.html) | `ask_user_question` LLM tool non-modal composer dock card — single-question form / 2–4 paginated multi-question / urgent variant / confirm-review step / `dismissed:true` fallback. Recommend + 대안 badges, choice-only answers. | PR #334 initial surface → composer dock `QuestionOverlay` + `AskUserQuestionCard` (current production) |
| [`permission-reviewer-status-prefill.html`](./permission-reviewer-status-prefill.html) | Permission reviewer latency + HIGH approval purpose prefill — chat status card states for 검토중/승인 필요/자동 진행/목적 부족 and approval surface copy for automatic vs required purpose text. | Design review / not shipped |
| [`multi-source-git-marketplace.md`](./multi-source-git-marketplace.md) · [목업](../../design/multi-source-git-marketplace.html) | 멀티 소스 git 마켓플레이스 설계서(한국어 미러)와 설정 → 마켓플레이스 화면 목업 7종 | 구현됨 (공개 릴리스와 서버 종료가 남음) |
| [`settings-controls-shadcn.html`](./settings-controls-shadcn.html) | Settings control primitive baseline — shadcn registry-backed Select, Checkbox, Switch, RadioGroup, Slider, NativeSelect, Field/Label visual contract. | PR #708 |

## When to update vs add a new file

- **Update in place** when the mockup still represents the design intent and
  only minor copy/spacing changed.
- **Add a new versioned file** (`*-v4.html`, `*-v5.html`) when the design
  pivots — keeping the old file lets future readers see why we moved.

Keep the mockup of a shipped feature: it is the design record. A mockup whose
feature was removed from the product, or a comparison sheet nothing references,
is deleted rather than archived (Agent Hub boards, the evidence-rail and
tray-icon sheets and the question-overlay mockup went this way on 2026-09-23).
