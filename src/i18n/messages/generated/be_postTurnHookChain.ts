// i18n fragment. Source: src/hooks/post-turn-hook-chain.ts.
export const en = {
  "be_postTurnHookChain.autoMemoryTitle": "auto-{title}",
  "be_postTurnHookChain.autoMemoryBody": "[User request]\n{input}\n\n[Assistant response]\n{output}",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_postTurnHookChain.autoMemoryTitle": "자동-{title}",
  "be_postTurnHookChain.autoMemoryBody": "[사용자 요청]\n{input}\n\n[어시스턴트 응답]\n{output}",
};
