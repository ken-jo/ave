// i18n fragment. Source: src/tools/routine-schedule.ts.
export const en = {
  "be_routineSchedule.toolDescription":
    "Registers a routine (automatic self-trigger) that fires at the scheduled time. " +
    "It does not read calendars or events: a request to check a calendar, today's schedule, or a meeting is not a routine registration. " +
    "execution='llm-session' starts an LLM conversation at the specified time; " +
    "'notification-only' sends an OS notification only. " +
    "Repeat modes: none/daily/weekly/monthly/interval/cron. " +
    "If only a date is provided for schedule.at (YYYY-MM-DD), the default time is 09:00 in the host's local time zone. " +
    "Example: daily 9 AM report → execution:'llm-session', " +
    "schedule:{at:'2026-05-09T09:00:00', repeat:{kind:'daily'}}, " +
    "prePrompt:'Write today\\'s daily report'",
  "be_routineSchedule.executionDescription":
    "Execution mode. llm-session=start LLM conversation, notification-only=notification only",
  "be_routineSchedule.scheduleDescription":
    "Schedule settings. at: ISO 8601 or YYYY-MM-DD. " +
    "repeat.kind: none|daily|weekly|monthly|interval|cron. " +
    "cron type requires only repeat.expression (5-field cron).",
  "be_routineSchedule.atDescription":
    "ISO 8601 datetime (e.g. '2026-05-09T09:00:00') or YYYY-MM-DD",
  "be_routineSchedule.intervalMsDescription": "interval type only: interval in ms",
  "be_routineSchedule.expressionDescription": "cron type only: 5-field cron expression",
  "be_routineSchedule.prePromptDescription":
    "Initial prompt passed to the LLM when execution=llm-session",
  "be_routineSchedule.titleDescription": "Routine title (optional)",
  "be_routineSchedule.notificationTitleDescription":
    "Notification title when execution=notification-only",
  "be_routineSchedule.notificationBodyDescription":
    "Notification body when execution=notification-only",
  "be_routineSchedule.allowedPluginsDescription":
    "List of extension IDs to expose in execution=llm-session routines. If omitted or [], no extension tools are available.",
  "be_routineSchedule.sourceDescription":
    "Optional origin marker for idempotency. Only set this when a system prompt explicitly instructs you to (format 'suggestion:<pluginId>:<intent>'). Leave unset for ordinary user-requested routines.",
  "be_routineSchedule.actionDescription":
    "add (default) registers a new item. update and remove change only an item connected to this chat, named by routineId " +
    "(update takes title, prePrompt or schedule). Any other item is the user's to change in the schedule panel.",
  "be_routineSchedule.routineIdDescription": "update/remove only: the id of an item connected to this chat",
  "be_routineSchedule.connectToThisChatDescription":
    "add with execution=llm-session only: when true, each run continues in this chat instead of a new conversation. " +
    "Set it when the user asks for the result here (e.g. 'remind me in this chat').",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_routineSchedule.toolDescription":
    "지정한 예약 시각에 발화되는 루틴(자동 self-trigger)을 등록합니다. " +
    "캘린더나 일정을 읽지 않습니다. 캘린더 점검, 오늘 일정, 회의 확인 요청은 루틴 등록이 아닙니다. " +
    "execution='llm-session'이면 지정 시각에 LLM 대화를 시작하고, " +
    "'notification-only'이면 OS 알림만 발송합니다. " +
    "반복 방식: none/daily/weekly/monthly/interval/cron. " +
    "schedule.at 에 날짜만 제공(YYYY-MM-DD)하면 호스트 로컬 시간대의 09:00 으로 처리됩니다. " +
    "예: 매일 오전 9시 데일리 리포트 → execution:'llm-session', " +
    "schedule:{at:'2026-05-09T09:00:00', repeat:{kind:'daily'}}, " +
    "prePrompt:'오늘의 데일리 리포트 작성'",
  "be_routineSchedule.executionDescription":
    "실행 모드. llm-session=LLM 대화 시작, notification-only=알림만",
  "be_routineSchedule.scheduleDescription":
    "스케줄 설정. at: ISO 8601 or YYYY-MM-DD. " +
    "repeat.kind: none|daily|weekly|monthly|interval|cron. " +
    "cron 타입은 repeat.expression(5필드)만 필요.",
  "be_routineSchedule.atDescription":
    "ISO 8601 datetime (예: '2026-05-09T09:00:00') 또는 YYYY-MM-DD",
  "be_routineSchedule.intervalMsDescription": "interval 타입 전용: ms 단위 간격",
  "be_routineSchedule.expressionDescription": "cron 타입 전용: 5필드 cron 표현식",
  "be_routineSchedule.prePromptDescription":
    "execution=llm-session 시 LLM에 전달할 초기 프롬프트",
  "be_routineSchedule.titleDescription": "루틴 제목 (선택)",
  "be_routineSchedule.notificationTitleDescription":
    "execution=notification-only 시 알림 제목",
  "be_routineSchedule.notificationBodyDescription":
    "execution=notification-only 시 알림 본문",
  "be_routineSchedule.allowedPluginsDescription":
    "execution=llm-session 루틴에서 노출할 익스텐션 id 목록. 미지정 또는 []이면 익스텐션 도구를 사용하지 않습니다.",
  "be_routineSchedule.sourceDescription":
    "멱등성용 출처 마커(선택). 시스템 프롬프트가 명시적으로 지시할 때만 설정하십시오(형식 'suggestion:<pluginId>:<intent>'). 일반 사용자 요청 루틴에서는 미설정.",
  "be_routineSchedule.actionDescription":
    "add(기본값)는 새 항목을 등록합니다. update·remove 는 routineId 로 지정한, 이 대화에 연결된 항목만 바꿉니다 " +
    "(update 는 title·prePrompt·schedule). 그 밖의 항목은 사용자가 스케줄 패널에서 바꿉니다.",
  "be_routineSchedule.routineIdDescription": "update/remove 전용: 이 대화에 연결된 항목의 id",
  "be_routineSchedule.connectToThisChatDescription":
    "add·execution=llm-session 전용: true 이면 실행마다 새 대화 대신 이 대화에서 이어집니다. " +
    "사용자가 결과를 이 대화에서 받기를 원할 때 설정하십시오(예: '이 대화에서 알려줘').",
};
