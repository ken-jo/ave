/** Record both auth-window forms, cookie reads, external URLs and host preferences through the child stub. */
const SIGN_IN = {
  url: "https://portal.example.com/login",
  completionUrlPatterns: ["https://portal.example.com/home*"],
  cookieHosts: ["portal.example.com"],
  persistPartition: "sampleportal-sso",
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
          partitionSub: "sampleportal-sso",
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
