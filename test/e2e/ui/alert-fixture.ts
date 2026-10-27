export const ALERT_FIXTURE_MANIFEST = {
  id: "alert-fixture",
  name: "Alert Fixture",
  version: "1.0.0",
  description: "Declared alerts for Settings and delivery checks.",
  entry: "dist/hostPlugin.js",
  requires: { minAppVersion: "0.12.0", hostProtocol: "4" },
  tools: [{
    name: "alert_fixture_raise",
    description: "Raise a declared fixture alert.",
    inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"], additionalProperties: false },
    _meta: { ui: { visibility: ["app", "model"] } },
  }],
  alerts: {
    reasoning: "Lets you review messages that need a reply without automatically starting a conversation.",
    kinds: [{
      id: "reply",
      label: { en: "Messages needing your reply and review", ko: "확인과 답장이 필요한 메시지" },
      description: { en: "Review the message, choose whether to reply, and keep control of when the conversation starts.", ko: "메시지를 검토하고 답장 여부와 대화를 시작할 시점을 직접 선택합니다." },
      defaultEnabled: false,
      visibility: "user-visible",
      osNotification: { defaultEnabled: false, body: { en: "A message needs your reply.", ko: "답장이 필요한 메시지가 있습니다." } },
      actionLabel: { en: "Review message", ko: "메시지 검토" },
      slots: { subject: { kind: "text", maxLength: 80 }, items: { kind: "list", maxItems: 3, maxLength: 40 }, messageId: { kind: "ref" } },
      summary: { en: "Reply needed: {subject}. Topics: {items}" },
      prompt: { en: "Review {subject} and address {items}." },
    }],
  },
};

export const ALERT_FIXTURE_SOURCE = `export default function createPlugin(context) {
  return {
    handlers: {
      alert_fixture_raise: async ({ key }) => context.hostApi.raiseAlert({
        kind: "reply", key,
        slots: { subject: "Quarterly review", items: ["Budget", "Schedule"], messageId: "fixture-message-42" }
      })
    },
    start() {},
    stop() {}
  };
}\n`;
