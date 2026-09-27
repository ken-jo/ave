/** Source fragment assembled into the locale catalogs. */
export const en = {
  "gitMarketplace.authority.filesystem": "Filesystem: {grant}",
  "pluginConfigTab.doctorSandboxGrantTitle": "Filesystem access outside approved scope",
  "pluginConfigTab.doctorSandboxGrantDescription": "Current approvals do not cover this plugin's filesystem grant. Change its directory setting or restore an eligible approval, then restart. If the plugin itself requests more access than the host allows, update to a version with narrower permissions or remove it.",
} as const;

export const ko = {
  "gitMarketplace.authority.filesystem": "파일 접근: {grant}",
  "pluginConfigTab.doctorSandboxGrantTitle": "파일 접근 범위 초과",
  "pluginConfigTab.doctorSandboxGrantDescription": "현재 승인 범위에 플러그인의 파일 접근 권한이 포함되지 않습니다. 디렉터리 설정을 바꾸거나 승인할 수 있는 디렉터리를 다시 승인한 뒤 재시작하세요. 플러그인 자체가 호스트의 허용 범위를 넘는 권한을 요청한다면 요청 범위를 줄인 새 버전으로 업데이트하거나 제거하세요.",
} as const;
