// i18n fragment. Source: src/permissions/approval-gate.ts.
export const en = {
  "be_approvalGate.notificationTitle": "Approval required",
  "be_approvalGate.deferredEscalationBody":
    "Denied; queued · {action} · {title}",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_approvalGate.notificationTitle": "승인이 필요합니다",
  "be_approvalGate.deferredEscalationBody":
    "거부·검토 대기열 · {action} · {title}",
};
