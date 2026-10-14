// i18n fragment. Source: src/ui/renderer/hooks/status-bar/use-status-bar-install.ts.
export const en = {
  "useStatusBarInstall.installSuccess": "{target} installed successfully",
  "useStatusBarInstall.installFailure": "{target} installation failed: {error}",
  "useStatusBarInstall.uninstallSuccess": "{target} removed successfully",
  "useStatusBarInstall.uninstallFailure": "{target} removal failed: {error}",
  "useStatusBarInstall.labelAgent": "agent",
  "useStatusBarInstall.labelSkill": "skill",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "useStatusBarInstall.installSuccess": "{target} 설치 완료",
  "useStatusBarInstall.installFailure": "{target} 설치 실패: {error}",
  "useStatusBarInstall.uninstallSuccess": "{target} 제거 완료",
  "useStatusBarInstall.uninstallFailure": "{target} 제거 실패: {error}",
  "useStatusBarInstall.labelAgent": "에이전트",
  "useStatusBarInstall.labelSkill": "스킬",
};
