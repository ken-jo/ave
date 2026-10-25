// Source: terminal workspace.
export const en = {
  "ptyTerminal.mountedElsewhere": "This terminal is open in another panel.",
  "ptyTerminal.manualLane": "Manual · host",
  "ptyTerminal.agentLane": "Agent · isolated",
  "ptyTerminal.laneLabel": "Terminal environment",
  "ptyTerminal.initialCwd": "Started in {cwd}",
  "ptyTerminal.currentCwd": "Current directory: {cwd}",
  "ptyTerminal.manualEnvironment": "Your host profile and HOME. Current directory and command exit status are unverified.",
  "ptyTerminal.agentEnvironment": "Separate isolated HOME, environment and directory. Confinement rules are fixed when this shell starts. Close and reopen the tab to apply changed rules.",
  "ptyTerminal.agentUnavailable": "Agent terminal unavailable. Enable a backend with filesystem and process isolation. Manual remains available.",
  "ptyTerminal.manualUnavailable": "The host terminal could not start. Check the selected interpreter and starting directory.",
  "ptyTerminal.startFailed": "The terminal could not start.",
  "ptyTerminal.restored": "Restored tab: this is a new shell.",
  "ptyTerminal.restoredRoot": "The saved directory is unavailable. Starting a new shell in the workspace root.",
  "ptyTerminal.exited": "Process exited: code {code}",
  "ptyTerminal.capacity": "Terminal capacity reached. Close another terminal and retry.",
  "ptyTerminal.stillClosing": "The previous shell is still closing. Retry shortly."
} as const;
export const ko: Record<keyof typeof en, string> = {
  "ptyTerminal.mountedElsewhere": "이 터미널은 다른 패널에 열려 있습니다.",
  "ptyTerminal.manualLane": "수동 · 호스트",
  "ptyTerminal.agentLane": "에이전트 · 격리",
  "ptyTerminal.laneLabel": "터미널 실행 환경",
  "ptyTerminal.initialCwd": "시작 디렉터리: {cwd}",
  "ptyTerminal.currentCwd": "현재 디렉터리: {cwd}",
  "ptyTerminal.manualEnvironment": "사용자의 호스트 프로필과 HOME을 사용합니다. 현재 디렉터리와 명령 종료 상태는 확인되지 않습니다.",
  "ptyTerminal.agentEnvironment": "별도의 격리된 HOME·환경·디렉터리를 사용합니다. 격리 규칙은 셸 시작 시 고정됩니다. 변경된 규칙을 적용하려면 탭을 닫고 다시 여세요.",
  "ptyTerminal.agentUnavailable": "에이전트 터미널을 사용할 수 없습니다. 파일시스템과 프로세스 격리가 가능한 실행 환경을 켜세요. 수동 터미널은 계속 사용할 수 있습니다.",
  "ptyTerminal.manualUnavailable": "호스트 터미널을 시작하지 못했습니다. 선택한 인터프리터와 시작 디렉터리를 확인하세요.",
  "ptyTerminal.startFailed": "터미널을 시작하지 못했습니다.",
  "ptyTerminal.restored": "복원된 탭입니다. 새 셸이 시작됩니다.",
  "ptyTerminal.restoredRoot": "저장된 디렉터리를 사용할 수 없어 워크스페이스 루트에서 새 셸을 시작합니다.",
  "ptyTerminal.exited": "프로세스 종료: 코드 {code}",
  "ptyTerminal.capacity": "터미널 수 제한에 도달했습니다. 다른 터미널을 닫고 다시 시도하세요.",
  "ptyTerminal.stillClosing": "이전 셸이 종료되는 중입니다. 잠시 후 다시 시도하세요."
};
