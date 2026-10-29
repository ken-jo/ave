// i18n fragment. Source: src/ui/renderer/constants.ts.
export const en = {
  // SOURCE_BADGE
  "constants.sourceBadgeBuiltin": "Built-in",
  "constants.sourceBadgePlugin": "Extension",

  // WEB_PROVIDERS placeholders
  "constants.webProviderDuckDuckGoPlaceholder": "No key required",
  "constants.webProviderSerperPlaceholder": "Enter key...",
  "constants.webProviderGooglePlaceholder": "API Key...",

  // VENDOR_UI labels/placeholders
  "constants.vendorAzureFoundryPlaceholder": "Azure API key...",
  "constants.vendorVertexAiPlaceholder": "service account (unused — uses ADC)",
  "constants.vendorOpenAiCompatibleLabel": "Custom provider",
  "constants.vendorOpenAiCompatiblePlaceholder": "API key (or any value if unauthenticated)",

  // EXEC_MODE_OPTIONS
  "constants.execModeDefaultLabel": "Allow writes",
  "constants.execModeDefaultDesc": "Allows ordinary reads, recoverable project file edits, and safe sandboxed commands. Other actions ask; protected actions always require approval.",
  "constants.execModeStrictLabel": "Default",
  "constants.execModeStrictDesc": "Allows ordinary reads and proven read-only sandboxed commands. File changes and other actions require approval.",
  "constants.execModeAutoLabel": "auto",
  "constants.execModeAutoDesc": "Allows the same project edits and safe sandboxed commands as Allow writes; the reviewer checks other actions. Protected actions always require approval.",
  "constants.execModeAllowLabel": "Allow",
  "constants.execModeAllowDesc": "Allows actions after admission and deny rules. Protected actions still require one-time approval.",

  // REASONING_DEPTHS
  "constants.reasoningEffortLow": "Low",
  "constants.reasoningEffortMedium": "Medium",
  "constants.reasoningEffortHigh": "High",
  "constants.reasoningEffortXHigh": "X-High",
  "constants.reasoningEffortMax": "Max",
} as const;
export const ko: Record<keyof typeof en, string> = {
  // SOURCE_BADGE
  "constants.sourceBadgeBuiltin": "내장",
  "constants.sourceBadgePlugin": "익스텐션",

  // WEB_PROVIDERS placeholders
  "constants.webProviderDuckDuckGoPlaceholder": "키 불필요",
  "constants.webProviderSerperPlaceholder": "키 입력...",
  "constants.webProviderGooglePlaceholder": "API 키...",

  // VENDOR_UI labels/placeholders
  "constants.vendorAzureFoundryPlaceholder": "Azure API 키...",
  "constants.vendorVertexAiPlaceholder": "서비스 계정 (미사용 — ADC 사용)",
  "constants.vendorOpenAiCompatibleLabel": "사용자 지정 제공업체",
  "constants.vendorOpenAiCompatiblePlaceholder": "API 키 (인증이 없으면 임의 값 가능)",

  // EXEC_MODE_OPTIONS
  "constants.execModeDefaultLabel": "쓰기 허용",
  "constants.execModeDefaultDesc": "일반 읽기, 복구 가능한 프로젝트 파일 변경, 안전한 샌드박스 명령을 허용합니다. 나머지는 승인 요청하며 보호 대상은 항상 확인합니다.",
  "constants.execModeStrictLabel": "기본",
  "constants.execModeStrictDesc": "일반 읽기와 읽기 전용으로 입증된 샌드박스 명령을 허용합니다. 파일 변경과 나머지 작업은 승인을 요청합니다.",
  "constants.execModeAutoLabel": "auto",
  "constants.execModeAutoDesc": "쓰기 허용과 같은 프로젝트 변경·안전한 샌드박스 명령을 허용하고 나머지는 리뷰어가 검증합니다. 보호 대상은 항상 확인합니다.",
  "constants.execModeAllowLabel": "허용",
  "constants.execModeAllowDesc": "입장 검사와 거부 규칙을 통과한 작업을 허용합니다. 보호 대상은 계속 이번 한 번 승인이 필요합니다.",

  // REASONING_DEPTHS
  "constants.reasoningEffortLow": "낮음",
  "constants.reasoningEffortMedium": "보통",
  "constants.reasoningEffortHigh": "높음",
  "constants.reasoningEffortXHigh": "매우높음",
  "constants.reasoningEffortMax": "최대",
};
