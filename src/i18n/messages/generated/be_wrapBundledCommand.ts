// i18n fragment. Source: src/sandbox/wrap-bundled-command.ts.
export const en = {
  "be_wrapBundledCommand.executableNotAdmissible": "This program cannot run in an extension container: {detail} ({code})",
  "be_wrapBundledCommand.executableRelative": "\"{command}\" is a relative path, which would resolve inside the working folder",
  "be_wrapBundledCommand.executableNotFound": "\"{command}\" was not found as a Windows executable (.exe) on PATH",
  "be_wrapBundledCommand.executableUnresolvable": "\"{path}\" cannot be resolved ({reason})",
  "be_wrapBundledCommand.executableNotExe": "\"{path}\" is not a Windows executable (.exe); run its interpreter directly",
  "be_wrapBundledCommand.executableInsideWorkspace": "\"{path}\" lies inside an open project folder or a folder a contained process can write. When a conversation's project folder is your user folder, that includes programs installed under it, such as %APPDATA%\\npm; open a narrower project folder",
  "be_wrapBundledCommand.workspaceBusy": "Another contained process is writing this project folder, so this one did not start; it is not queued. Retry after it ends ({code})",
  "be_wrapBundledCommand.workspaceBusyStaging": "Another contained process is writing inside this project folder, so this one did not start; it is not queued. This project folder contains Ave's data folder, where every running contained MCP server or extension hook keeps its private folder, so this is refused while any of them runs; open a narrower project folder ({code})",
  "be_wrapBundledCommand.bashIncompatible": "Git Bash cannot start inside a Windows extension container on this host; use PowerShell or a Windows program ({code})",
  "be_wrapBundledCommand.holderQuarantined": "{label}: the previous contained process could not be confirmed stopped, so it was not restarted. Restart Ave to clear it ({code})",
  "be_wrapBundledCommand.environmentRefused": "An extension container cannot receive these environment variables: {keys}. Remove them from this server or hook ({code})",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_wrapBundledCommand.executableNotAdmissible": "이 프로그램은 익스텐션 컨테이너에서 실행할 수 없습니다: {detail}({code})",
  "be_wrapBundledCommand.executableRelative": "\"{command}\" 는 상대 경로라 작업 폴더 안에서 해석됩니다",
  "be_wrapBundledCommand.executableNotFound": "PATH 에서 \"{command}\" 를 Windows 실행 파일(.exe)로 찾지 못했습니다",
  "be_wrapBundledCommand.executableUnresolvable": "\"{path}\" 를 확인할 수 없습니다({reason})",
  "be_wrapBundledCommand.executableNotExe": "\"{path}\" 는 Windows 실행 파일(.exe)이 아닙니다. 해당 인터프리터를 직접 실행하세요",
  "be_wrapBundledCommand.executableInsideWorkspace": "\"{path}\" 는 열린 프로젝트 폴더나 컨테이너 프로세스가 쓸 수 있는 폴더 안에 있습니다. 대화의 프로젝트 폴더가 사용자 폴더이면 그 아래 설치된 프로그램(예: %APPDATA%\\npm)도 여기에 해당하니, 더 좁은 프로젝트 폴더를 여세요",
  "be_wrapBundledCommand.workspaceBusy": "다른 컨테이너 프로세스가 이 프로젝트 폴더에 쓰고 있어 이 프로세스는 시작하지 않았습니다(대기열 없음). 끝난 뒤 다시 시도하세요({code})",
  "be_wrapBundledCommand.workspaceBusyStaging": "다른 컨테이너 프로세스가 이 프로젝트 폴더 안에 쓰고 있어 이 프로세스는 시작하지 않았습니다(대기열 없음). 이 프로젝트 폴더에는 실행 중인 컨테이너 MCP 서버·익스텐션 훅이 전용 폴더를 두는 Ave 데이터 폴더가 들어 있어, 그중 하나라도 실행 중이면 거부됩니다. 더 좁은 프로젝트 폴더를 여세요({code})",
  "be_wrapBundledCommand.bashIncompatible": "이 PC 에서는 Git Bash 를 Windows 익스텐션 컨테이너 안에서 시작할 수 없습니다. PowerShell 이나 Windows 프로그램을 쓰세요({code})",
  "be_wrapBundledCommand.holderQuarantined": "{label}: 이전 컨테이너 프로세스가 멈췄는지 확인하지 못해 다시 시작하지 않았습니다. Ave 를 재시작하면 해제됩니다({code})",
  "be_wrapBundledCommand.environmentRefused": "익스텐션 컨테이너는 다음 환경 변수를 받을 수 없습니다: {keys}. 이 서버나 훅 설정에서 제거하세요({code})",
};
