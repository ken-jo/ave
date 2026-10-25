/** Call each mail UI-action member once to record its actual wire frames. */
export const createPlugin = async (context) => {
  const api = context.hostApi;
  return {
    handlers: {
      exercise_host: async () => {
        const redirect = await api.authRedirect.open();
        const redirectParams = await api.authRedirect.wait({ handle: redirect.handle, timeoutMs: 120_000 });
        await api.authRedirect.close({ handle: redirect.handle });
        const signIn = await api.openAuthWindow({
          url: "https://login.example.com/authorize",
          completionUrlPatterns: ["https://login.example.com/done*"],
          cookieHosts: ["login.example.com"],
          persistPartition: "samplemail-auth",
          returnFinalUrl: true,
        });
        await api.openAuthPartitionViewer({ url: "https://mail.example.com/", windowTitle: "Mail" });
        await api.storage.writeEncrypted("tokens/cache.bin", "the token cache");
        const tokenCache = await api.storage.readEncrypted("tokens/cache.bin");
        const onCorporateNetwork = await api.probePrivateHost("intranet.example.com", { timeoutMs: 1_500 });
        await api.clearAuthPartition("samplemail-auth");
        return { redirect, redirectParams, signIn, tokenCache, onCorporateNetwork };
      },
      report_host: async () => ({}),
    },
  };
};
