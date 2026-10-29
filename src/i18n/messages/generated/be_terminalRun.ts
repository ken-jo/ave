// Source: src/tools/terminal-run.ts. Do not edit by hand.
export const en = {
  "be_terminalRun.toolDescription":
    "Runs one command in this conversation's persistent isolated shell, with a disposable HOME and active filesystem/process confinement. Results appear inline in the conversation. It never types into the user's host terminals. Terminal-bound pane chats cannot request host typing in this version; use ordinary isolated shell tools instead. No active-tab fallback or cross-conversation target is allowed. The same shell permission rules and sensitive/exfiltration floors apply. Requires an authenticated empty prompt and one complete command line without control characters, history expansion or persistent shell-state mutation. Supported isolated shells are zsh and bash. If still running after the wait, use the exact continuation with terminal_read.",
  "be_terminalRun.commandDescription": "The single-line shell command to type and run, exactly as it should appear in the terminal.",
  "be_terminalRun.tabIdDescription": "Optional opaque identity from this conversation's terminal_read inventory. It can only confirm this conversation's own isolated terminal, never select a host or foreign terminal.",
  "be_terminalRun.waitSecondsDescription": "Seconds to wait for the command to finish before returning (default {defaultWait}, max {maxWait}; 0 returns as soon as it is typed). The command keeps running in the terminal either way.",
  "be_terminalRun.ranDifferentCommand": "Terminal {tabId} ran a different command from the one approved (its shell's record is in block.command). This was recorded in the audit log. Do not retry; tell the user.",
  "be_terminalRun.stillRunning": "The command is still running in terminal {tabId}. Read its output later with terminal_read using the exact terminalSessionId and blockId in continuation (block {blockId}).",
  "be_terminalRun.notVerified": "The command was typed into terminal {tabId}, but its shell did not report starting it, so whether it ran as approved is not verified. Check with terminal_read using this result’s terminalSessionId (tabId {tabId}) and tell the user.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_terminalRun.toolDescription":
    "이 대화의 지속형 격리 셸에서 명령 하나를 실행합니다. 임시 HOME과 파일시스템·프로세스 격리를 유지하며 결과는 대화 안에 표시됩니다. 사용자의 호스트 터미널에는 입력하지 않습니다. 현재 버전에서는 터미널에 연결된 패널 대화의 호스트 입력을 지원하지 않으므로 일반 격리 셸 도구를 사용하세요. 활성 탭으로 대체하거나 다른 대화의 터미널을 선택할 수 없습니다. 같은 셸 권한 규칙과 민감 경로·정보 유출 방지 규칙을 적용합니다. 인증된 빈 프롬프트와 제어 문자·히스토리 확장·지속적 셸 상태 변경이 없는 완전한 한 줄 명령이 필요합니다. 격리 셸은 zsh와 bash를 지원합니다. 대기 후에도 실행 중이면 정확한 continuation을 terminal_read에 전달하세요.",
  "be_terminalRun.commandDescription": "입력해 실행할 한 줄짜리 셸 명령. 터미널에 보일 모습 그대로 적습니다.",
  "be_terminalRun.tabIdDescription": "이 대화의 terminal_read 목록에서 받은 선택적 식별자. 이 대화의 격리 터미널만 확인하며 호스트나 다른 대화의 터미널을 선택할 수 없습니다.",
  "be_terminalRun.waitSecondsDescription": "명령이 끝나기를 기다릴 초 (기본 {defaultWait}, 최대 {maxWait}, 0 이면 입력하자마자 반환). 어느 경우든 명령은 터미널에서 계속 실행됩니다.",
  "be_terminalRun.ranDifferentCommand": "터미널 {tabId} 가 승인된 명령과 다른 명령을 실행했습니다 (셸의 기록은 block.command 에 있습니다). 감사 로그에 기록했습니다. 다시 시도하지 말고 사용자에게 알리세요.",
  "be_terminalRun.stillRunning": "명령이 터미널 {tabId} 에서 아직 실행 중입니다. 출력은 나중에 continuation의 정확한 terminalSessionId·blockId로 terminal_read를 호출해 읽으세요(블록 {blockId}).",
  "be_terminalRun.notVerified": "명령을 터미널 {tabId} 에 입력했지만 셸이 시작을 알리지 않아, 승인된 대로 실행됐는지 확인하지 못했습니다. 결과의 terminalSessionId와 terminal_read (tabId {tabId}) 로 확인하고 사용자에게 알리세요.",
};
