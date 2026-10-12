/** Loading and failure copy for persisted child transcripts. */
export const en = {
  "subAgentCard.transcriptLoading": "Loading transcript…",
  "subAgentCard.transcriptLoadFailed": "Couldn't load transcript.",
} as const;

export const ko: Record<keyof typeof en, string> = {
  "subAgentCard.transcriptLoading": "대화 기록을 불러오는 중…",
  "subAgentCard.transcriptLoadFailed": "대화 기록을 불러오지 못했습니다.",
};
