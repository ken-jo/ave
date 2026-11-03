// i18n fragment. Source: src/plugins/runtime/index.ts.
export const en = {
  "be_runtimeIndex.preparingRuntimeMessage": "Starting extension runtime preparation.",
  "be_runtimeIndex.lifecycleQuarantined": "Extension {pluginId} cannot start until Ave restarts: an earlier stop or start could not be confirmed ({reason}) ({code})",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_runtimeIndex.preparingRuntimeMessage": "익스텐션 런타임 준비를 시작합니다.",
  "be_runtimeIndex.lifecycleQuarantined": "익스텐션 {pluginId} 는 Ave 를 재시작할 때까지 시작할 수 없습니다. 이전 중지나 시작을 확인하지 못했습니다({reason})({code})",
};
