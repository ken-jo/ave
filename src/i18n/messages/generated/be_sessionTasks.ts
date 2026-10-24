// i18n fragment. Source: src/tools/session-tasks.ts.
export const en = {
  "be_sessionTasks.toolDescription": "Manage the checklist the assistant follows in this session. " +
    "Tasks are numbered from 1 in the order listed; the user sees the same numbers, so \"task 2\" means the same thing to both of you. " +
    "Every action returns the full numbered list. Completed tasks stay in the list (struck through); the list is saved with the session and comes back when it is reopened. " +
    "Actions: create (replace the list with steps), add (insert steps after task N; 0 = front; omitted = end), " +
    "edit (change a task's text and/or status: pending | in_progress), delete (remove task N), complete (mark task N done), " +
    "list (return the list without changing it). " +
    "Do NOT use this tool when the user asks to register, record, or add their own tasks — " +
    "if an extension tool for registering permanent task items is available, call that first. This tool is for " +
    "*tracking the assistant's own steps* while working through a multi-step request. " +
    "Do not spend a separate round only on status updates: send a status change in the same message as the next work tool call, listed before that work tool. The host executes a message's tool calls in the listed order, so the chip updates before the work starts, and a status-only round adds a full round of cost and latency. " +
    "Register the whole plan with create and set task 1 in_progress in the same message as the first work call. Mark a task complete only after you have seen its result. While one step spans several tool calls, leave the list alone until the step ends. " +
    "Do not re-send a task in the status it already has; a call that changes nothing is treated as an error. " +
    "Numbers shift after add/delete, so use the numbers from the latest returned list. When the user starts a new job, replace the list with create.",
  "be_sessionTasks.actionDesc": "create | add | edit | delete | complete | list.",
  "be_sessionTasks.stepsDesc": "create/add: the tasks, comma-separated, in order (e.g. \"scan folder, summarize findings, write report\"). A JSON array of strings is also accepted.",
  "be_sessionTasks.afterDesc": "add only: insert after this task number (1-based). 0 inserts at the front. Omit to append at the end.",
  "be_sessionTasks.indexDesc": "edit/delete/complete: the task number as shown in the list (1-based).",
  "be_sessionTasks.textDesc": "edit only: the new text for the task.",
  "be_sessionTasks.statusDesc": "edit only: pending or in_progress. Set in_progress on the step you are working on now; use action=complete when it is done.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_sessionTasks.toolDescription": "이 세션에서 어시스턴트가 따라갈 체크리스트를 관리합니다. " +
    "작업은 나열된 순서대로 1번부터 번호가 붙고 사용자도 같은 번호를 보므로 \"2번 작업\" 은 서로 같은 것을 가리킵니다. " +
    "모든 action 은 번호가 붙은 전체 목록을 돌려줍니다. 완료된 작업은 목록에 남고(취소선), 목록은 세션과 함께 저장되어 다시 열면 그대로 돌아옵니다. " +
    "action: create (목록을 steps 로 교체), add (N번 뒤에 steps 삽입; 0 = 맨 앞; 생략 = 맨 뒤), " +
    "edit (작업의 text 와/또는 status 변경: pending | in_progress), delete (N번 제거), complete (N번 완료 표시), " +
    "list (변경 없이 목록만 반환). " +
    "사용자가 본인의 업무·할 일을 등록·기록·추가해달라는 요청에는 이 도구를 사용하지 마세요 — " +
    "영구 업무 항목 등록을 지원하는 익스텐션 도구가 노출되어 있으면 그쪽을 우선 호출하세요. 본 도구는 어시스턴트가 " +
    "다단계 요청을 풀어가는 *내부 단계 추적* 용도입니다. " +
    "상태 갱신만을 위한 별도 라운드를 만들지 말고, 상태 전환은 다음 작업 도구 호출과 같은 메시지에, 그 작업 도구보다 앞 순서로 함께 보내세요. host 는 한 메시지의 tool_call 을 나열된 순서대로 실행하므로 작업이 시작되기 전에 칩이 갱신되고, 상태만 바꾸는 라운드는 비용과 지연을 한 라운드만큼 늘립니다. " +
    "계획은 create 로 한 번에 등록하고, 첫 작업 호출과 같은 메시지에서 1번을 in_progress 로 바꾸세요. 결과를 확인한 뒤에만 complete 하세요. 한 단계가 여러 도구 호출에 걸치는 동안에는 그 단계가 끝날 때까지 목록을 건드리지 마세요. " +
    "이미 그 상태인 작업을 같은 상태로 다시 보내지 마세요. 아무것도 바꾸지 않는 호출은 오류로 처리됩니다. " +
    "add/delete 뒤에는 번호가 밀리므로 마지막으로 돌려받은 목록의 번호를 사용하세요. 사용자가 새 일을 시작하면 create 로 목록을 교체하세요.",
  "be_sessionTasks.actionDesc": "create | add | edit | delete | complete | list.",
  "be_sessionTasks.stepsDesc": "create/add: 작업 목록을 쉼표로 구분해 순서대로 (예: \"폴더 스캔, 결과 요약, 보고서 작성\"). 문자열 JSON 배열도 허용.",
  "be_sessionTasks.afterDesc": "add 전용: 이 번호(1부터) 의 작업 뒤에 삽입. 0 이면 맨 앞. 생략하면 맨 뒤에 추가.",
  "be_sessionTasks.indexDesc": "edit/delete/complete: 목록에 표시된 작업 번호(1부터).",
  "be_sessionTasks.textDesc": "edit 전용: 작업의 새 텍스트.",
  "be_sessionTasks.statusDesc": "edit 전용: pending 또는 in_progress. 지금 진행 중인 단계에 in_progress 를 지정하고, 끝나면 action=complete 를 사용.",
};
