/** Alert interface strings and the host's declared due-soon templates. */
export const en = {
  "alerts.builtInNotice": "Built-in notice",
  "be_alerts.builtInLabel": "Built-in",
  "be_alerts.reasoning": "Reminds you about upcoming Work Board deadlines.",
  "be_alerts.dueSoonLabel": "Work due soon",
  "be_alerts.dueSoonBody": "A Work Board item is due within 24 hours.",
  "be_alerts.dueSoonSummary": "Due soon: {title}",
  "be_alerts.dueSoonPrompt": "A Work Board item is due soon: {title}. Review the item and help me decide the next step.",
  "be_alerts.dueSoonAction": "Review work",
} as const;

export const ko: Record<keyof typeof en, string> = {
  "alerts.builtInNotice": "기본 기능 알림",
  "be_alerts.builtInLabel": "기본 기능",
  "be_alerts.reasoning": "워크 보드에서 마감이 다가오는 작업을 알려 줍니다.",
  "be_alerts.dueSoonLabel": "마감이 다가오는 작업",
  "be_alerts.dueSoonBody": "24시간 안에 마감되는 워크 보드 작업이 있습니다.",
  "be_alerts.dueSoonSummary": "마감이 다가오는 작업: {title}",
  "be_alerts.dueSoonPrompt": "워크 보드 작업의 마감이 다가옵니다: {title}. 작업을 검토하고 다음 단계를 결정할 수 있도록 도와주세요.",
  "be_alerts.dueSoonAction": "작업 검토",
};
