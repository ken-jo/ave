// i18n fragment. Source: src/permissions/approval-gate.ts.
export const en = {
  "be_approvalGate.notificationTitle": "Approval required",
  "be_approvalGate.deferredEscalationBody":
    "{action}: nobody was at the desk, so the sub-agent request was denied and queued for your review.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_approvalGate.notificationTitle": "승인이 필요합니다",
  "be_approvalGate.deferredEscalationBody":
    "{action}: 자리에 아무도 없어 하위 에이전트 요청을 거부하고 검토 대기열에 넣었습니다.",
};
