/** Call each host method through the real child stub so golden frames record its marshalling. */
const CALLS = {
  "storage.read": (api) => api.storage.read("notes/today.bin"),
  "storage.readText": (api) => api.storage.readText("notes/today.txt", "utf-8"),
  "storage.readJson": (api) => api.storage.readJson("state.json"),
  "storage.list": (api) => api.storage.list("notes"),
  "storage.exists": (api) => api.storage.exists("state.json"),
  "storage.write": (api) => api.storage.write("notes/today.bin", new Uint8Array([0x00, 0x80, 0xff])),
  "storage.writeJson": (api) => api.storage.writeJson("state.json", { cursor: 3 }, 2),
  "storage.rm": (api) => api.storage.rm("notes", { recursive: true }),
  "storage.mkdir": (api) => api.storage.mkdir("notes"),
  "storage.writeEncrypted": (api) => api.storage.writeEncrypted("tokens/cache.bin", "the token cache"),
  "storage.readEncrypted": (api) => api.storage.readEncrypted("tokens/cache.bin"),
  "config.set": (api) => api.config.set("region", "south"),
  "config.onChange": (api) => api.config.onChange("region", () => undefined),
  getSecret: (api) => api.getSecret("service.token"),
  hasRoutineBySource: (api) => api.hasRoutineBySource("golden:daily"),
  proposeWork: (api) =>
    api.proposeWork({
      kind: "follow-up",
      key: "mail-1",
      title: "Reply to the report",
      summary: "The report asks for a decision by Friday.",
      state: "open",
      taskBrief: "Draft a reply that states the decision.",
    }),
  withdrawWorkProposal: (api) => api.withdrawWorkProposal("follow-up", "mail-1"),
  probePrivateHost: (api) => api.probePrivateHost("intranet.example.com", { timeoutMs: 1_500 }),
  resolveApiKey: (api) => api.resolveApiKey({ purpose: "llm", vendor: "openai" }),
  emitEvent: (api) => api.emitEvent("golden.ready", { ok: true }),
  onEvent: (api) => api.onEvent("golden.ping", () => undefined),
  onPluginsChanged: (api) => api.onPluginsChanged(() => undefined),
  onShutdown: (api) => api.onShutdown(async () => undefined),
  logEvent: (api) => api.logEvent("info", "golden: an event", { step: 1 }),
  callLlm: (api) => api.callLlm("say hello", { maxTokens: 16 }),
  hostFetch: (api) =>
    api.hostFetch("https://api.example.com/ping", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "ping",
    }),
  spawnWorker: (api) => api.spawnWorker({ workerId: "golden", command: "/usr/bin/true", args: ["--version"] }),
  openExternalUrl: (api) => api.openExternalUrl("https://example.com/help"),
  openAuthWindow: (api) =>
    api.openAuthWindow({
      url: "https://login.example.com/authorize",
      completionUrlPatterns: ["https://login.example.com/done*"],
      cookieHosts: ["login.example.com"],
      returnFinalUrl: true,
    }),
  openAuthPartitionViewer: (api) =>
    api.openAuthPartitionViewer({ url: "https://mail.example.com/", windowTitle: "Mail" }),
  clearAuthPartition: (api) => api.clearAuthPartition("golden-auth"),
  "authRedirect.open": (api) => api.authRedirect.open(),
  "authRedirect.wait": (api) => api.authRedirect.wait({ handle: "redirect-1", timeoutMs: 1_000 }),
  "authRedirect.close": (api) => api.authRedirect.close({ handle: "redirect-1" }),
  pickFolders: (api) => api.pickFolders(),
  resolveMappedDriveRoot: (api) => api.resolveMappedDriveRoot("Z:"),
  listAudioInputDevices: (api) => api.listAudioInputDevices(),
  startAudioCapture: (api) =>
    api.startAudioCapture({ sampleRate: 16_000, frameMs: 200, microphone: true, systemAudio: false }),
  resizeFloatingPanel: (api) => api.resizeFloatingPanel("panel-1", 200),
  attachFloatingPanel: (api) => api.attachFloatingPanel({ extensionId: "golden-card", height: 240 }),
  getAuthPartitionCookies: (api) =>
    api.getAuthPartitionCookies({ partitionSub: "golden-auth", urls: ["https://portal.example.com/"] }),
  triggerConversation: (api) => api.triggerConversation({ prompt: "hello", source: "golden:trigger" }),
  "agentApproval.request": (api) =>
    api.agentApproval.request({ toolName: "golden_tool", args: {}, reason: "needs approval", scope: "once" }),
  "agentApproval.respond": (api) => api.agentApproval.respond("request-1", "allow-once", "nonce-1", "hmac-1"),
  raiseAlert: (api) =>
    api.raiseAlert({
      kind: "mail-reply",
      key: "mail-1",
      slots: { subject: "Quarterly report" },
      priority: "high",
    }),
  withdrawAlert: (api) => api.withdrawAlert("mail-reply", "mail-1"),
};

/** Project live handles to their data members for JSON observations. */
function describe(value) {
  if (value === undefined) return { undefined: true };
  if (typeof value === "function") return { function: true };
  if (value instanceof Uint8Array) return { bytes: Array.from(value) };
  if (value instanceof Response) return { status: value.status };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).filter(([, member]) => typeof member !== "function"),
    );
  }
  return value;
}

export const createPlugin = async (context) => {
  const api = context.hostApi;
  const disposers = [];
  return {
    handlers: {
      invoke_member: async ({ path }) => {
        const call = CALLS[path];
        if (!call) throw new Error(`the invoker has no call for '${path}'`);
        try {
          const value = await call(api);
          if (typeof value === "function") disposers.push(value);
          return { value: describe(value) };
        } catch (error) {
          return { error: { name: error.name, code: error.code ?? null, message: error.message } };
        }
      },
      invoke_cancelled: async () => {
        const controller = new AbortController();
        const answer = api.callLlm("an answer the plugin stops waiting for", { signal: controller.signal });
        // Cancel only after the request reaches the wire.
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.abort(new Error("the plugin stopped waiting"));
        try {
          return { value: await answer };
        } catch (error) {
          return { error: { name: error.name, code: error.code ?? null, message: error.message } };
        }
      },
      write_log: async () => {
        context.log("golden: a log line", { step: 2 });
        return {};
      },
      dispose_all: async () => {
        for (const dispose of disposers.splice(0)) dispose();
        return {};
      },
    },
    start: async () => undefined,
    onPublished: async () => undefined,
    stop: async () => undefined,
  };
};
