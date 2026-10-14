// i18n fragment. Source: src/ipc/domains/chat.ts.
export const en = {
  "be_chatDomain.exportHeading": "# Ave Conversation Export",
  "be_chatDomain.exportSessionLine": "- Session: {sessionId}",
  "be_chatDomain.exportTimeLine": "- Exported at: {exportedAt}",
} as const;
export const ko: Record<keyof typeof en, string> = {
  "be_chatDomain.exportHeading": "# Ave 대화 내보내기",
  "be_chatDomain.exportSessionLine": "- 세션: {sessionId}",
  "be_chatDomain.exportTimeLine": "- 내보낸 시각: {exportedAt}",
};
