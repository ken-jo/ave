// i18n fragment. Source: src/ui/renderer/components/permissions/TerminalEgressBanner.tsx.
export const en = {
  "terminalEgressBanner.region": "Network approval for this terminal",
  "terminalEgressBanner.blocked": "{target} blocked",
  "terminalEgressBanner.held": "The connection waits for your answer and is denied after 2 minutes without one.",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "terminalEgressBanner.region": "이 터미널의 네트워크 승인",
  "terminalEgressBanner.blocked": "{target} 차단됨",
  "terminalEgressBanner.held": "연결은 응답을 기다리며, 2분 안에 응답이 없으면 거부됩니다.",
};
