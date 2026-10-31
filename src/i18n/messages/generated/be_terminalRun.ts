// i18n fragment. Source: src/tools/terminal-run.ts.
export const en = {
  "be_terminalRun.toolDescription": "Runs one command. In an ordinary conversation it types into that conversation's persistent isolated shell, with a disposable HOME and active filesystem/process confinement. In a workspace terminal's own pane chat it types into that bound host terminal, the user's real shell with their privileges: the user chooses for this session between allowing all actions, automatic logical review, or asking every time (the default). The user can take over at any time, and only that command's own output returns. There is no active-tab fallback, side panel access or cross-conversation target. Shell permission rules, protected-path floors and ordinary upload/exfiltration guardrails apply. Requires an authenticated empty prompt and one complete command line without control characters, history expansion or persistent shell-state mutation. Supported shells are zsh and bash. If still running after the wait, use the exact continuation with terminal_read.",
  "be_terminalRun.commandDescription": "The single-line shell command to type and run, exactly as it should appear in the terminal.",
  "be_terminalRun.tabIdDescription": "Optional opaque identity to confirm the target: this conversation's isolated terminal, or this pane chat's own host terminal. It never selects another terminal.",
  "be_terminalRun.waitSecondsDescription": "Seconds to wait for the command to finish before returning (default {defaultWait}, max {maxWait}; 0 returns as soon as it is typed). The command keeps running in the terminal either way.",
  "be_terminalRun.ranDifferentCommand": "Terminal {tabId} ran a different command from the one approved (its shell's record is in block.command). This was recorded in the audit log. Do not retry; tell the user.",
  "be_terminalRun.stillRunning": "The command is still running in terminal {tabId}. Read its output later with terminal_read using the exact terminalSessionId and blockId in continuation (block {blockId}).",
  "be_terminalRun.notVerified": "The command was typed into terminal {tabId}, but its shell did not report starting it, so whether it ran as approved is not verified. Check with terminal_read using this result’s terminalSessionId (tabId {tabId}) and tell the user.",
  "be_terminalRun.hostRanDifferentCommand": "Host terminal {tabId} ran a different command from the one approved, so none of its output is returned. This was recorded in the audit log. Do not retry; tell the user.",
  "be_terminalRun.hostInterrupted": "The user took control of terminal {tabId} (or its pane chat ended) before the command finished. Only the output from before that moment is shown, and nothing later can be read. Do not retry unless the user asks.",
  "be_terminalRun.hostNoPromptYet": "Terminal {tabId} has not drawn a marked prompt yet: its shell may still be starting or waiting at a startup question (for example zsh's compinit prompt). Nothing was typed. Ask the user to answer it in the terminal, then retry."
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_terminalRun.toolDescription": "명령 하나를 실행합니다. 일반 대화에서는 그 대화의 지속 격리 셸에 입력하며, 일회용 HOME과 파일 시스템·프로세스 격리가 적용됩니다. 워크스페이스 터미널의 패널 채팅에서는 연결된 호스트 터미널, 즉 사용자 권한으로 실행되는 실제 셸에 입력합니다. 사용자는 이 세션 모두 허용, 논리적 일관성을 확인하는 자동 리뷰, 모두 질문(기본값) 중 하나를 선택합니다. 사용자는 언제든 제어를 가져올 수 있으며, 해당 명령의 출력만 돌아옵니다. 활성 탭 대체, 사이드 패널 접근, 다른 대화 대상은 없습니다. 셸 권한 규칙, 보호 경로 하한, 일반 업로드·유출 방지 가드레일이 적용됩니다. 인증된 빈 프롬프트와 제어 문자, 히스토리 확장, 셸 상태 변경이 없는 완전한 한 줄 명령이 필요합니다. 지원 셸은 zsh와 bash입니다. 대기 후에도 실행 중이면 terminal_read로 정확한 continuation을 사용하세요.",
  "be_terminalRun.commandDescription": "입력해 실행할 한 줄짜리 셸 명령. 터미널에 보일 모습 그대로 적습니다.",
  "be_terminalRun.tabIdDescription": "대상을 확인하는 선택적 불투명 식별자입니다. 이 대화의 격리 터미널 또는 이 패널 채팅의 호스트 터미널만 가리키며, 다른 터미널을 선택하지 않습니다.",
  "be_terminalRun.waitSecondsDescription": "명령이 끝나기를 기다릴 초 (기본 {defaultWait}, 최대 {maxWait}, 0 이면 입력하자마자 반환). 어느 경우든 명령은 터미널에서 계속 실행됩니다.",
  "be_terminalRun.ranDifferentCommand": "터미널 {tabId} 가 승인된 명령과 다른 명령을 실행했습니다 (셸의 기록은 block.command 에 있습니다). 감사 로그에 기록했습니다. 다시 시도하지 말고 사용자에게 알리세요.",
  "be_terminalRun.stillRunning": "명령이 터미널 {tabId} 에서 아직 실행 중입니다. 출력은 나중에 continuation의 정확한 terminalSessionId·blockId로 terminal_read를 호출해 읽으세요(블록 {blockId}).",
  "be_terminalRun.notVerified": "명령을 터미널 {tabId} 에 입력했지만 셸이 시작을 알리지 않아, 승인된 대로 실행됐는지 확인하지 못했습니다. 결과의 terminalSessionId와 terminal_read (tabId {tabId}) 로 확인하고 사용자에게 알리세요.",
  "be_terminalRun.hostRanDifferentCommand": "호스트 터미널 {tabId}이(가) 승인된 명령과 다른 명령을 실행했으므로 출력은 반환되지 않습니다. 감사 로그에 기록되었습니다. 다시 시도하지 말고 사용자에게 알리세요.",
  "be_terminalRun.hostInterrupted": "명령이 끝나기 전에 사용자가 터미널 {tabId}의 제어를 가져왔거나 패널 채팅이 끝났습니다. 그 시점 이전의 출력만 표시되며 이후 내용은 읽을 수 없습니다. 사용자가 요청하지 않으면 다시 시도하지 마세요.",
  "be_terminalRun.hostNoPromptYet": "터미널 {tabId}이(가) 아직 표시된 프롬프트를 그리지 않았습니다. 셸이 시작 중이거나 시작 질문(예: zsh compinit 프롬프트)에서 기다리고 있을 수 있습니다. 아무것도 입력하지 않았습니다. 사용자에게 터미널에서 답하도록 요청한 뒤 다시 시도하세요."
};
