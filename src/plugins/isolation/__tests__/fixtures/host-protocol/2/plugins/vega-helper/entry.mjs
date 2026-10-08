/**
 * The hostApi surface `vega-helper` reaches (plugin-hostapi-protocol.md §9.2),
 * each member called once so the golden transcript beside this file shows every
 * frame that surface puts on the wire.
 */
export const createPlugin = async (context) => {
  const api = context.hostApi;
  const seen = { events: [], pluginsChanged: [], configChanges: [] };
  const disposers = [];
  return {
    handlers: {
      exercise_host: async () => {
        disposers.push(api.onEvent("lyra-mail.snapshot.ready", (data) => seen.events.push(data)));
        disposers.push(api.onPluginsChanged((event) => seen.pluginsChanged.push(event)));
        disposers.push(
          api.config.onChange("osNotificationsEnabled", (value) => seen.configChanges.push(value ?? null)),
        );
        const installed = api.getInstalledPluginIds();
        const notificationsBefore = api.config.get("osNotificationsEnabled") ?? null;
        await api.config.set("osNotificationsEnabled", false);
        const notificationsAfter = api.config.get("osNotificationsEnabled") ?? null;
        const hasRoutine = await api.hasRoutineBySource("vega-helper:daily-briefing");
        const briefing = await api.callLlm("summarise the unread mail", { maxTokens: 64 });
        const trigger = await api.triggerConversation({
          prompt: "prepare the next meeting",
          source: "vega-helper:meeting-prep",
          visibility: "summary-only",
        });
        return { installed, notificationsBefore, notificationsAfter, hasRoutine, briefing, trigger };
      },
      report_host: async () => {
        for (const dispose of disposers.splice(0)) dispose();
        return seen;
      },
    },
  };
};
