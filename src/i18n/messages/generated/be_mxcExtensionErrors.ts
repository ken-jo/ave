// i18n fragment. Source: src/permissions/mxc-extension-errors.ts.
export const en = {
  "be_mxcExtensionErrors.workerTransportUnsupported": "This plugin's worker uses a connection a Windows extension container cannot carry: workers need stdio control v1. Update the plugin ({code})",
  "be_mxcExtensionErrors.nativeEntryRequired": "This process type has not been updated for Windows extension containers yet, so it was not started ({code})",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_mxcExtensionErrors.workerTransportUnsupported": "이 플러그인의 워커는 Windows 익스텐션 컨테이너가 지원하지 않는 연결 방식을 씁니다. 워커에는 stdio control v1 이 필요하니 플러그인을 업데이트하세요({code})",
  "be_mxcExtensionErrors.nativeEntryRequired": "이 프로세스 유형은 아직 Windows 익스텐션 컨테이너용으로 갱신되지 않아 시작하지 않았습니다({code})",
};
