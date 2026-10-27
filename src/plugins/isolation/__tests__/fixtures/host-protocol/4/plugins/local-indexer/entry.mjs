/** Record the indexing fixture host calls: worker lifecycle, directory selection and secret resolution. */
export const createPlugin = async (context) => {
  const api = context.hostApi;
  const seen = { stdout: [], stderr: [], exits: [] };
  const held = {};
  return {
    handlers: {
      exercise_host: async () => {
        const folders = await api.pickFolders();
        const driveRoot = await api.resolveMappedDriveRoot("Z:");
        held.lease = await api.resolveApiKey({ purpose: "embedding", vendor: "openai" });
        held.worker = await api.spawnWorker({
          workerId: "indexer",
          command: "/usr/bin/python3",
          args: ["-u", "worker.py"],
          udsArgName: { env: "AVE_CONTROL_SOCKET" },
        });
        held.worker.onStdout((chunk) => seen.stdout.push(chunk));
        held.worker.onStderr((chunk) => seen.stderr.push(chunk));
        held.worker.onExit((info) => seen.exits.push(info));
        return {
          folders,
          driveRoot,
          lease: { ok: held.lease.ok, vendor: held.lease.vendor, leaseId: held.lease.leaseId },
          worker: { socketPath: held.worker.socketPath, pid: held.worker.pid },
        };
      },
      report_host: async () => {
        held.lease.release();
        return seen;
      },
    },
  };
};
