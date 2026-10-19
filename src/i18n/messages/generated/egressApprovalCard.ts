// i18n fragment. Source: src/ui/renderer/components/permissions/EgressHostApprovalCard.tsx.
export const en = {
  "egressApprovalCard.dockTitle": "Approve Network Access",
  "egressApprovalCard.title": "Allow this network connection?",
  "egressApprovalCard.body": "A sandboxed {tool} command wants to connect to a host that is not allowed yet:",
  "egressApprovalCard.conversation": "Conversation: {conversation}",
  "egressApprovalCard.denyOnce": "Deny",
  "egressApprovalCard.allowOnce": "Allow once",
  "egressApprovalCard.allowConversation": "This conversation",
  "egressApprovalCard.allowWorkspace": "This workspace",
  "egressApprovalCard.allowAlways": "Always",
  "egressApprovalCard.revokeHint": "Workspace and always grants can be revoked in Settings → Permissions → Network.",
  "egressApprovalCard.invalid": "This network request is incomplete and can only be denied.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "egressApprovalCard.dockTitle": "네트워크 접근 승인",
  "egressApprovalCard.title": "이 네트워크 연결을 허용할까요?",
  "egressApprovalCard.body": "샌드박스 안의 {tool} 명령이 아직 허용되지 않은 호스트에 연결하려고 합니다:",
  "egressApprovalCard.conversation": "대화: {conversation}",
  "egressApprovalCard.denyOnce": "거절",
  "egressApprovalCard.allowOnce": "한 번만 허용",
  "egressApprovalCard.allowConversation": "이 대화에서 허용",
  "egressApprovalCard.allowWorkspace": "이 워크스페이스에서 허용",
  "egressApprovalCard.allowAlways": "항상 허용",
  "egressApprovalCard.revokeHint": "워크스페이스·항상 허용은 설정 → 권한 → 네트워크에서 취소할 수 있습니다.",
  "egressApprovalCard.invalid": "이 네트워크 요청은 정보가 빠져 있어 거절만 할 수 있습니다.",
};
