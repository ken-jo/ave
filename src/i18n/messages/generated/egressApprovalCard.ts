// i18n fragment. Source: src/ui/renderer/components/permissions/EgressHostApprovalCard.tsx.
export const en = {
  "egressApprovalCard.dockTitle": "Approve Network Access",
  "egressApprovalCard.title": "Allow this network connection?",
  "egressApprovalCard.body": "A sandboxed {tool} command wants to connect to a host that is not allowed yet:",
  "egressApprovalCard.conversation": "Conversation: {conversation}",
  "egressApprovalCard.revokeHint": "This project and Always apply to this domain and port for future sandboxed commands (in this project, or everywhere); revoke them in Settings → Permissions → Network.",
  "egressApprovalCard.revokeHintTerminal": "Always grants can be revoked in Settings → Permissions → Network.",
  "egressApprovalCard.invalid": "This network request is incomplete and can only be denied.",
  "egressApprovalCard.localWarning": "This is this computer or a private network (local services, intranet hosts, routers). An allow here lasts for this command only.",
  "egressApprovalCard.unverifiedWarning": "Your network's proxy server looks up this name, so Ave could not check where it leads. An allow here lasts at most for this session.",
  "egressApprovalCard.terminalBody": "A command in this conversation's isolated shell wants to connect to a host that is not allowed yet:",
  "egressApprovalCard.localWarningShell": "This is this computer or a private network (local services, intranet hosts, routers). An allow here lasts at most until this isolated shell exits (the conversation ends, or the shell exits and restarts).",
  "egressApprovalCard.unverifiedWarningShell": "Your network's proxy server looks up this name, so Ave could not check where it leads. An allow here lasts at most until this isolated shell exits (the conversation ends, or the shell exits and restarts).",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "egressApprovalCard.dockTitle": "네트워크 접근 승인",
  "egressApprovalCard.title": "이 네트워크 연결을 허용할까요?",
  "egressApprovalCard.body": "샌드박스 안의 {tool} 명령이 아직 허용되지 않은 호스트에 연결하려고 합니다:",
  "egressApprovalCard.conversation": "대화: {conversation}",
  "egressApprovalCard.revokeHint": "이 프로젝트에서 허용과 항상 허용은 이후 샌드박스 명령(이 프로젝트 또는 모든 곳)에서도 이 도메인과 포트에 적용되며, 설정 → 권한 → 네트워크에서 취소할 수 있습니다.",
  "egressApprovalCard.revokeHintTerminal": "항상 허용은 설정 → 권한 → 네트워크에서 취소할 수 있습니다.",
  "egressApprovalCard.invalid": "이 네트워크 요청은 정보가 빠져 있어 거부만 할 수 있습니다.",
  "egressApprovalCard.localWarning": "이 컴퓨터 또는 사설 네트워크(로컬 서비스, 내부망 호스트, 공유기)입니다. 여기서 허용해도 이 명령에서만 유지됩니다.",
  "egressApprovalCard.unverifiedWarning": "이 이름은 네트워크의 프록시 서버가 직접 찾기 때문에 Ave 가 연결 대상을 확인하지 못했습니다. 여기서 허용해도 이 세션까지만 유지됩니다.",
  "egressApprovalCard.terminalBody": "이 대화의 격리 셸에서 실행한 명령이 아직 허용되지 않은 호스트에 연결하려고 합니다:",
  "egressApprovalCard.localWarningShell": "이 컴퓨터 또는 사설 네트워크(로컬 서비스, 내부망 호스트, 공유기)입니다. 여기서 허용해도 이 격리 셸이 끝날 때까지만(대화가 끝나거나 셸이 종료되어 다시 시작될 때까지) 유지됩니다.",
  "egressApprovalCard.unverifiedWarningShell": "이 이름은 네트워크의 프록시 서버가 직접 찾기 때문에 Ave 가 연결 대상을 확인하지 못했습니다. 여기서 허용해도 이 격리 셸이 끝날 때까지만(대화가 끝나거나 셸이 종료되어 다시 시작될 때까지) 유지됩니다.",
};
