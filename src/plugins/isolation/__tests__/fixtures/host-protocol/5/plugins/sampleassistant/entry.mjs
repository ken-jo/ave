/** Call each assistant host member once to record its actual wire frames. */
export const createPlugin = async (context) => {
  const api = context.hostApi;
  const seen = { events: [], configChanges: [] };
  const disposers = [];
  return {
    handlers: {
      exercise_host: async () => {
        disposers.push(api.onEvent("host.theme.changed", (data) => seen.events.push(data)));
        disposers.push(
          api.config.onChange("osNotificationsEnabled", (value) => seen.configChanges.push(value ?? null)),
        );
        const notificationsBefore = api.config.get("osNotificationsEnabled") ?? null;
        await api.config.set("osNotificationsEnabled", false);
        const notificationsAfter = api.config.get("osNotificationsEnabled") ?? null;
        const hasRoutine = await api.hasRoutineBySource("sampleassistant:daily-briefing");
        const briefing = await api.callLlm("summarise the unread mail", { maxTokens: 64 });
        const trigger = await api.triggerConversation({
          prompt: "prepare the next meeting",
          source: "sampleassistant:meeting-prep",
          visibility: "summary-only",
        });
        return { notificationsBefore, notificationsAfter, hasRoutine, briefing, trigger };
      },
      report_host: async () => {
        for (const dispose of disposers.splice(0)) dispose();
        return seen;
      },
    },
  };
};
