// i18n fragment. Source: src/plugins/isolation/plugin-child-transport.ts.
export const en = {
  "be_pluginChildTransport.terminationUnverified": "Plugin child termination is unverified: {pluginId}. It keeps its folder access and cannot restart until Ave restarts ({code})",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_pluginChildTransport.terminationUnverified": "플러그인 하위 프로세스 종료를 확인하지 못했습니다: {pluginId}. Ave 를 재시작할 때까지 폴더 접근을 유지하며 다시 시작할 수 없습니다({code})",
};
