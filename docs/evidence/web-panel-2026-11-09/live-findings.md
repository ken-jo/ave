# Live findings (isolated dev build of HEAD 389e6c444, real free model, CDP; 2026-11-09)

Evidence: <lab>/web-run/{w2,w3,w4,w5,m1,m2,m3,m4,m5}.png; child transcripts <lab>/web-run/home/subagent/sessions/sub-eba1f8a9-*.jsonl (read-only, do not edit that home).

Works: with the panel closed, a single agent opened Seoul Wikipedia in a background tab, scrolled, and the composer preview (128x80 "실시간") showed the page moving; panel never opened.

Broken:
L1 (high) First `browser_tab_new` after the user answers the site card ALWAYS fails with `{"error":"nothing more was done: the browser document changed"}` (single agent: 12.4s then error; each child too). The model then needs browser_navigate to recover. The navigation the tool itself caused (about:blank -> approved URL) must not count as a foreign document change.
L2 (high) Multi-agent: both children's new tabs (tab-3 owner sub-...007b944d, tab-4 owner sub-...a21df73b, ownership correct) stay at about:blank with `"mode":"human"` and lease null; all later child calls fail: snapshot -> "this call was not approved for the page the tab shows; nothing was done. Call it again to ask."; children ended TASK_STATE_INPUT_REQUIRED saying the user must approve tab control. Also tab-1 from the earlier single-agent chat is `"mode":"human"` although no human touched it (my driver clicked only approval-card buttons in the shell, never a guest). Hypothesis to verify: the item-5 wake/reveal path (or something in tab creation/approval) is attributed as user input / takeover and flips the tab to human mode. Find the real cause; agent-owned tabs must never become human without a real user input event in that guest.
L3 (medium) Only ONE child preview was shown in the composer (labelled "Python.org 스크롤 및 제목 보고", stuck "업데이트 중…" on about:blank); the other child had none.
L4 (medium) Site card deny button renders the raw i18n key `toolApprovalDialog.deny` (ko UI).
L5 (low) Site card shows the heading twice (card header and body both "이 사이트를 열어도 될까요? https://en.wikipedia.org:443"); show the origin without the default :443 port.
L6 (low) Child site cards do not say which sub-agent asks (no child label visible on the card; 1/2 counter only).
L7 (medium, owner rule) `agent_spawn` still shows the generic "도구 실행 승인" tool-use card. Owner rule: Ave builtin tools ask about the action. Frame it as the action (e.g. "하위 에이전트를 시작할까요?" with the task title), en/ko.
L8 (low) Parent's text says "새 브라우저 탭 제어에 사용자 승인이 필요" — derived from L2; re-check after L2.

# Live run 2 (isolated dev build of ave-webfix HEAD 566e5908a, web-5 port 9351, real free model; 2026-11-09 03:15)
Evidence: web-run/m6-1..m6-4.png; child transcripts web-run/home/subagent/sessions/sub-5c408240-524ceffc-*.jsonl (Busan) and sub-5c408240-1765cb8b-*.jsonl (Python); parent = the newest chat in web-run/home sessions. Read-only.

Fixed and confirmed live: L1 (child browser_tab_new returned tabId+url), L2 (child snapshots succeeded, no human-mode error), L3 (two child previews, both "실시간", each labelled), L4 (거부 translated), L5 (one heading, no :443), L7 (agent_spawn card titled with child label), site card shows "요청한 하위 에이전트: <label>". Both children reported to the parent via the [Sub-Agent: ...] host report.

New:
N1 (high) Children cannot read snapshots. browser_snapshot output is replaced by "[tool_result truncated by host ...]" even at 5,438 chars / 1,361 tokens (python.org), and the stub tells the model to call read_tool_result_chunk, which is NOT in the child's toolset ("도구를 찾을 수 없습니다: read_tool_result_chunk"). Both children failed the task (no first paragraph). Either children get read_tool_result_chunk (with the same recovery path as the parent) or the child budget/stub must not point at a tool the agent lacks; and a 5 KB snapshot should not be truncated at all — find why the child's per-result limit is that small.
N2 (high) browser_tab_close took 45,685 ms (python child) and 202,207 ms (Busan child). Find what close waits on (control release, lease, focus, preview teardown, approval) and make it immediate.
N3 (medium) While both children were blocked on the site approval card, the parent's agent status calls reported them as still loading pages (8+ polls, "두 에이전트 모두 여전히 페이지 로드 중"), so the parent gave up and tried browser_tab_new itself (two extra site cards, which I denied). Agent status must say a child is waiting for user approval (and on what), so the parent waits instead of duplicating work.
N4 (low) After the run the renderer took ~60 s to answer a CDP screenshot / Runtime.evaluate (UI busy). Check for a hot loop around the composer previews or approval cards when a child tab closes; report only if found.
N5 (medium) The host's sub-agent report is injected as a "[방향 지시 — 진행 중 추가 입력]" steering message: it renders as a user bubble with the raw "[호스트] 아래는 … 턴을 끝내지 마라" instructions, and it renamed the chat title to "[방향 지시 — 진행 중 추가 입력] [호스트] 아래는 당신이 시작한…" (m6-7.png, sidebar + header). Host reports must not become user-authored steering, must not rename the conversation, and should render as a sub-agent report block, not a user message.
End state: parent finished with a merged two-site report only after using web_fetch + read_tool_result_chunk itself (m6-7.png), because the children could not read their snapshots (N1).
