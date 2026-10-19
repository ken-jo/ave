// AUTO-GENERATED — i18n migration. Source: src/tools/terminal-run.ts. Do not edit by hand.
export const en = {
  "be_terminalRun.toolDescription":
    "Runs one shell command in a workspace terminal the user can see: the command is typed at the terminal's prompt and run there, in the terminal's own directory and sandbox, and its command block (exit code and output) is returned when it finishes. Use it when the user wants the work to happen in their terminal; use bash for commands that do not need to be seen. The command goes through the same permission rules as bash, so the user may be asked to approve it. It runs only when the terminal is idle at an empty prompt: if a command or full-screen program is running, or the user has typed something, the call is refused — do not retry until terminal_read shows the terminal idle. One line only: no newlines, tabs or control characters, and no history expansion (a ! before a word). If the command is still running when the wait ends, read the rest later with terminal_read.",
  "be_terminalRun.commandDescription": "The single-line shell command to type and run, exactly as it should appear in the terminal.",
  "be_terminalRun.tabIdDescription": "Terminal tab id from terminal_read (for example \"terminal:3fa91c0e-2\"). Omit it to use the terminal this conversation is bound to, or else the terminal the user is looking at.",
  "be_terminalRun.waitSecondsDescription": "Seconds to wait for the command to finish before returning (default {defaultWait}, max {maxWait}; 0 returns as soon as it is typed). The command keeps running in the terminal either way.",
  "be_terminalRun.stillRunning": "The command is still running in terminal {tabId}. Read its output later with terminal_read (tabId {tabId}, blockId {blockId}).",
  "be_terminalRun.notStarted": "The command was typed into terminal {tabId}, but the shell has not started it yet. Check with terminal_read (tabId {tabId}).",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_terminalRun.toolDescription":
    "사용자가 볼 수 있는 워크스페이스 터미널에서 셸 명령 하나를 실행합니다. 명령은 터미널 프롬프트에 입력되어 그 터미널의 디렉터리와 샌드박스 안에서 실행되고, 끝나면 그 명령 블록(종료 코드와 출력)을 반환합니다. 사용자가 자기 터미널에서 작업이 진행되기를 원할 때 사용하고, 보여줄 필요가 없는 명령은 bash 를 사용하세요. 명령은 bash 와 같은 권한 규칙을 거치므로 사용자에게 승인을 요청할 수 있습니다. 터미널이 빈 프롬프트에서 대기 중일 때만 실행됩니다. 명령이나 전체 화면 프로그램이 실행 중이거나 사용자가 무언가를 입력해 두었으면 거부되며, terminal_read 로 터미널이 대기 상태임을 확인하기 전에는 다시 시도하지 마세요. 한 줄만 가능합니다. 줄바꿈, 탭, 제어 문자, 히스토리 확장(단어 앞의 !)은 쓸 수 없습니다. 대기 시간이 끝났을 때 명령이 아직 실행 중이면 나머지는 나중에 terminal_read 로 읽으세요.",
  "be_terminalRun.commandDescription": "입력해 실행할 한 줄짜리 셸 명령. 터미널에 보일 모습 그대로 적습니다.",
  "be_terminalRun.tabIdDescription": "terminal_read 에서 얻은 터미널 탭 id (예: \"terminal:3fa91c0e-2\"). 생략하면 이 대화가 연결된 터미널을, 없으면 사용자가 보고 있는 터미널을 사용합니다.",
  "be_terminalRun.waitSecondsDescription": "명령이 끝나기를 기다릴 초 (기본 {defaultWait}, 최대 {maxWait}, 0 이면 입력하자마자 반환). 어느 경우든 명령은 터미널에서 계속 실행됩니다.",
  "be_terminalRun.stillRunning": "명령이 터미널 {tabId} 에서 아직 실행 중입니다. 출력은 나중에 terminal_read (tabId {tabId}, blockId {blockId}) 로 읽으세요.",
  "be_terminalRun.notStarted": "명령을 터미널 {tabId} 에 입력했지만 셸이 아직 시작하지 않았습니다. terminal_read (tabId {tabId}) 로 확인하세요.",
};
