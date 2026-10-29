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
  "constants.execModeDefaultLabel": "Confirm writes outside the project",
  "constants.execModeDefaultDesc": "Reads and recoverable project file edits are allowed; writes outside the project and protected paths require approval. Other tools follow their own permission rules",
  "constants.execModeStrictLabel": "Confirm all",
  "constants.execModeStrictDesc": "Approval required for all tools including reads",
  "constants.execModeAutoLabel": "Auto-verify",
  "constants.execModeAutoDesc": "Recoverable project file edits are allowed; other eligible interactive calls use the reviewer threshold, and headless execution uses its separate fail-closed reviewer queue",
  "constants.execModeAllowLabel": "Allow all",
  "constants.execModeAllowDesc": "Tools outside hard blocks are auto-allowed; access outside allowed directories requires separate approval",

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
  "constants.execModeDefaultLabel": "프로젝트 밖 쓰기 확인",
  "constants.execModeDefaultDesc": "읽기와 복구 가능한 프로젝트 파일 변경은 허용하고, 프로젝트 밖 쓰기·보호 경로는 승인 요청. 나머지 도구는 해당 권한 규칙을 적용",
  "constants.execModeStrictLabel": "전체 확인",
  "constants.execModeStrictDesc": "읽기까지 포함해 모든 도구 실행 전 승인 요청",
  "constants.execModeAutoLabel": "자동 검증",
  "constants.execModeAutoDesc": "복구 가능한 프로젝트 파일 변경은 허용하고, 나머지 대화형 검증 대상은 리뷰어 임계값을 적용하며 헤드리스 실행은 별도의 실패 폐쇄형 리뷰 대기열을 사용",
  "constants.execModeAllowLabel": "모두 허용",
  "constants.execModeAllowDesc": "하드 차단 밖 도구는 자동 허용하고 허용 디렉터리 밖 접근은 별도 승인",

  // REASONING_DEPTHS
  "constants.reasoningEffortLow": "낮음",
  "constants.reasoningEffortMedium": "보통",
  "constants.reasoningEffortHigh": "높음",
  "constants.reasoningEffortXHigh": "매우높음",
  "constants.reasoningEffortMax": "최대",
};
