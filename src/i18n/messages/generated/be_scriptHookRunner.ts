// i18n fragment. Source: src/hooks/script-hook-runner.ts.
export const en = {
  "be_scriptHookRunner.containedSettleDeadline": "The hook's contained process did not settle within {ms} ms; it keeps its sandbox resources while its termination is unconfirmed ({code})",
  "be_scriptHookRunner.containedTerminationUnverified": "The hook's contained process termination is unverified; it keeps its sandbox resources: {detail} ({code})",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_scriptHookRunner.containedSettleDeadline": "훅의 격리 프로세스가 {ms} ms 안에 끝나지 않았습니다. 종료가 확인되지 않는 동안 샌드박스 자원을 유지합니다({code})",
  "be_scriptHookRunner.containedTerminationUnverified": "훅의 격리 프로세스 종료를 확인하지 못했습니다. 샌드박스 자원을 유지합니다: {detail}({code})",
};
