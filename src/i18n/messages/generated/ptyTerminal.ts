// Source: terminal workspace.
export const en = {
  "ptyTerminal.integrationUnsupportedShell": "Shell integration is unavailable for this interpreter. Your shell remains usable.",
  "ptyTerminal.integrationMissingHome": "Shell integration requires a home directory. Your shell remains usable.",
  "ptyTerminal.integrationCustomLaunch": "Shell integration is unavailable with custom launch arguments. Your shell remains usable.",
  "ptyTerminal.integrationSetupFailed": "Shell integration could not be prepared. Your shell remains usable.",
  "ptyTerminal.hostBadge": "My terminal (host) · No agent access",
  "ptyTerminal.mountedElsewhere": "This terminal is open in another panel.",
  "ptyTerminal.initialCwd": "Started in {cwd}",
  "ptyTerminal.currentCwd": "Current directory: {cwd}",
  "ptyTerminal.manualEnvironment": "Your host profile and HOME. Commands and output stay private unless you attach them to chat.",
  "ptyTerminal.manualUnavailable": "The host terminal could not start. Check the selected interpreter and starting directory.",
  "ptyTerminal.startFailed": "The terminal could not start.",
  "ptyTerminal.restored": "Restored tab: this is a new shell.",
  "ptyTerminal.restoredRoot": "The saved directory is unavailable. Starting a new shell in the workspace root.",
  "ptyTerminal.exited": "Process exited: code {code}",
  "ptyTerminal.capacity": "Terminal capacity reached. Close another terminal and retry.",
  "ptyTerminal.stillClosing": "The previous shell is still closing. Retry shortly."
} as const;
export const ko: Record<keyof typeof en, string> = {
  "ptyTerminal.integrationUnsupportedShell": "이 인터프리터는 셸 통합을 지원하지 않습니다. 셸은 계속 사용할 수 있습니다.",
  "ptyTerminal.integrationMissingHome": "홈 디렉터리가 없어 셸 통합을 사용할 수 없습니다. 셸은 계속 사용할 수 있습니다.",
  "ptyTerminal.integrationCustomLaunch": "사용자 지정 실행 인수로 셸 통합을 사용할 수 없습니다. 셸은 계속 사용할 수 있습니다.",
  "ptyTerminal.integrationSetupFailed": "셸 통합을 준비하지 못했습니다. 셸은 계속 사용할 수 있습니다.",
  "ptyTerminal.hostBadge": "내 터미널 (호스트) · 에이전트 접근 없음",
  "ptyTerminal.mountedElsewhere": "이 터미널은 다른 패널에 열려 있습니다.",
  "ptyTerminal.initialCwd": "시작 디렉터리: {cwd}",
  "ptyTerminal.currentCwd": "현재 디렉터리: {cwd}",
  "ptyTerminal.manualEnvironment": "사용자의 호스트 프로필과 HOME을 사용합니다. 직접 채팅에 첨부한 명령과 출력만 공유됩니다.",
  "ptyTerminal.manualUnavailable": "호스트 터미널을 시작하지 못했습니다. 선택한 인터프리터와 시작 디렉터리를 확인하세요.",
  "ptyTerminal.startFailed": "터미널을 시작하지 못했습니다.",
  "ptyTerminal.restored": "복원된 탭입니다. 새 셸이 시작됩니다.",
  "ptyTerminal.restoredRoot": "저장된 디렉터리를 사용할 수 없어 워크스페이스 루트에서 새 셸을 시작합니다.",
  "ptyTerminal.exited": "프로세스 종료: 코드 {code}",
  "ptyTerminal.capacity": "터미널 수 제한에 도달했습니다. 다른 터미널을 닫고 다시 시도하세요.",
  "ptyTerminal.stillClosing": "이전 셸이 종료되는 중입니다. 잠시 후 다시 시도하세요."
};
