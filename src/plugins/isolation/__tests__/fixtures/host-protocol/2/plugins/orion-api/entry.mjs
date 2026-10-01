/**
 * The hostApi surface `orion-api` reaches (plugin-hostapi-protocol.md §9.2) — both
 * forms of the auth window, the partition cookies, three workers and the
 * private-network probe — so the golden transcript beside this file shows every
 * frame that surface puts on the wire.
 */
const SIGN_IN = {
  url: "https://portal.example.com/login",
  completionUrlPatterns: ["https://portal.example.com/home*"],
  cookieHosts: ["portal.example.com"],
  persistPartition: "orion-api-sso",
  show: false,
};

export const createPlugin = async (context) => {
  const api = context.hostApi;
  const seen = { stdout: [] };
  return {
    handlers: {
      exercise_host: async () => {
        const onPrivateNetwork = await api.probePrivateHost("portal.example.com", { timeoutMs: 1_500 });
        const cookies = await api.openAuthWindow(SIGN_IN);
        const signIn = await api.openAuthWindow({ ...SIGN_IN, returnFinalUrl: true });
        const partitionCookies = await api.getAuthPartitionCookies({
          partitionSub: "orion-api-sso",
          urls: ["https://portal.example.com/"],
        });
        const workers = [];
        for (const workerId of ["directory-lookup", "session-keeper", "profile-reader"]) {
          const worker = await api.spawnWorker({ workerId, command: "/usr/bin/true" });
          worker.onStdout((chunk) => seen.stdout.push(chunk));
          workers.push({ socketPath: worker.socketPath, pid: worker.pid });
        }
        return { onPrivateNetwork, cookies, signIn, partitionCookies, workers };
      },
      report_host: async () => seen,
    },
  };
};
