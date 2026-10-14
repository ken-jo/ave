// i18n fragment. Source: src/ui/renderer/components/BootstrapStatusPill.tsx.
export const en = {
  "bootstrapStatusPill.installing": "Installing managed extensions…",
  "bootstrapStatusPill.pillInstalling": "Installing extensions",
  "bootstrapStatusPill.pillError": "Bootstrap failed",
  "bootstrapStatusPill.pillFailed": "Extension install failed",
  "bootstrapStatusPill.pillSkipped": "Bootstrap skipped",
  "bootstrapStatusPill.pillRetryAriaLabel": "Retry extension bootstrap",
  "bootstrapStatusPill.bootstrapError": "Extension bootstrap failed: {message}",
  "bootstrapStatusPill.dismissNotification": "Close notification",
  "bootstrapStatusPill.skippedE2eIsolated": "Managed extension bootstrap is off in isolated test mode.",
  "bootstrapStatusPill.singlePluginFailed": "Extension {id} installation failed: {error}",
  "bootstrapStatusPill.multiplePluginsFailed": "{count} extensions failed to install",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "bootstrapStatusPill.installing": "매니지드 익스텐션 설치 중…",
  "bootstrapStatusPill.pillInstalling": "익스텐션 설치 중",
  "bootstrapStatusPill.pillError": "부트스트랩 실패",
  "bootstrapStatusPill.pillFailed": "익스텐션 설치 실패",
  "bootstrapStatusPill.pillSkipped": "부트스트랩 건너뜀",
  "bootstrapStatusPill.pillRetryAriaLabel": "익스텐션 부트스트랩 다시 시도",
  "bootstrapStatusPill.bootstrapError": "익스텐션 부트스트랩 실패: {message}",
  "bootstrapStatusPill.dismissNotification": "알림 닫기",
  "bootstrapStatusPill.skippedE2eIsolated": "격리된 테스트 모드에서는 매니지드 익스텐션 부트스트랩을 실행하지 않습니다.",
  "bootstrapStatusPill.singlePluginFailed": "익스텐션 {id} 설치 실패: {error}",
  "bootstrapStatusPill.multiplePluginsFailed": "{count}개 익스텐션 설치 실패",
};
