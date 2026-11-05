// i18n fragment. Source: src/boot.ts.
export const en = {
  "be_boot.upgradeMarkersPlural": "~/.ave reference {count} files",
  "be_boot.upgradeNotificationTitle": "Ave reference update available",
  "be_boot.upgradeNotificationBody": "Review: {markerSummary}. Open Settings > Roles to apply, keep yours, or merge.",
  "be_boot.routineNotificationFallbackTitle": "Routine notification",
  "be_boot.routineWakeNote": "Scheduled prompt · {title} · not a message from you\n\n{prompt}",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_boot.upgradeMarkersPlural": "~/.ave reference {count}개 파일",
  "be_boot.upgradeNotificationTitle": "Ave reference 업데이트 사용 가능",
  "be_boot.upgradeNotificationBody": "검토 대상: {markerSummary}. 설정 > 역할에서 적용·유지·갱신할 수 있습니다.",
  "be_boot.routineNotificationFallbackTitle": "루틴 알림",
  "be_boot.routineWakeNote": "예약된 프롬프트 · {title} · 사용자 메시지가 아닙니다\n\n{prompt}",
};
