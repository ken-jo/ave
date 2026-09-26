/** Host declarations share the plugin alert pipeline and its opt-in rules. */
import type { AlertKindDeclaration } from "../plugins/public-contract.js";
import { en, ko } from "../i18n/messages/generated/alerts.js";

function text(key: keyof typeof en): { en: string; ko: string } {
  return { en: en[key], ko: ko[key] };
}

export const DUE_SOON_ALERT_KIND = "due-soon";
export const DUE_SOON_TITLE_MAX_LENGTH = 200;

export const HOST_ALERT_KINDS: readonly AlertKindDeclaration[] = [
  {
    id: DUE_SOON_ALERT_KIND,
    label: text("be_alerts.dueSoonLabel"),
    description: text("be_alerts.dueSoonBody"),
    defaultEnabled: false,
    visibility: "user-visible",
    osNotification: { defaultEnabled: false, body: text("be_alerts.dueSoonBody") },
    actionLabel: text("be_alerts.dueSoonAction"),
    slots: {
      title: { kind: "text", maxLength: DUE_SOON_TITLE_MAX_LENGTH },
      itemId: { kind: "ref" },
    },
    summary: text("be_alerts.dueSoonSummary"),
    prompt: text("be_alerts.dueSoonPrompt"),
  },
];
