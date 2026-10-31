// Permission denial history surface.
export const en = {
  "recentlyDenied.title": "Recently denied",
  "recentlyDenied.description": "Denied calls have ended. Run again to request a fresh approval.",
  "recentlyDenied.empty": "No recent denials.",
  "recentlyDenied.rerun": "Run again",
  "recentlyDenied.freshApproval": "Runs admission checks again and asks for a fresh approval.",
  "recentlyDenied.unavailable": "The original invocation cannot be safely reconstructed. Submit a new call from its conversation.",
  "recentlyDenied.error": "Unable to load history or run this call again.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "recentlyDenied.title": "최근 거부됨",
  "recentlyDenied.description": "거부된 호출은 종료되었습니다. 다시 실행하면 새 승인을 요청합니다.",
  "recentlyDenied.empty": "최근 거부된 호출이 없습니다.",
  "recentlyDenied.rerun": "다시 실행",
  "recentlyDenied.freshApproval": "입장 검사를 다시 수행하고 새 승인을 요청합니다.",
  "recentlyDenied.unavailable": "원래 호출을 안전하게 복원할 수 없습니다. 해당 대화에서 새 호출을 요청해 주세요.",
  "recentlyDenied.error": "기록을 불러오거나 호출을 다시 실행할 수 없습니다.",
};
