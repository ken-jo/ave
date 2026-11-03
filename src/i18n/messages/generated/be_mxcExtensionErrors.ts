// i18n fragment. Source: src/permissions/mxc-extension-errors.ts.
export const en = {
  "be_mxcExtensionErrors.workerTransportUnsupported": "This extension's worker uses a connection a Windows extension container cannot carry: workers need stdio control v1. Update the extension ({code})",
  "be_mxcExtensionErrors.nativeEntryRequired": "This process type has not been updated for Windows extension containers yet, so it was not started ({code})",
  "be_mxcExtensionErrors.readinessRefused": "No extension backend has admitted this start, so it was refused; it does not run unconfined ({code})",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_mxcExtensionErrors.workerTransportUnsupported": "이 익스텐션의 워커는 Windows 익스텐션 컨테이너가 지원하지 않는 연결 방식을 씁니다. 워커에는 stdio control v1 이 필요하니 익스텐션을 업데이트하세요({code})",
  "be_mxcExtensionErrors.nativeEntryRequired": "이 프로세스 유형은 아직 Windows 익스텐션 컨테이너용으로 갱신되지 않아 시작하지 않았습니다({code})",
  "be_mxcExtensionErrors.readinessRefused": "허용된 익스텐션 백엔드가 없어 이 시작을 거부했습니다. 격리 없이 실행되지 않습니다({code})",
};
