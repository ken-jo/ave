/** Record the indexing fixture host calls: worker lifecycle, directory selection and secret resolution. */
export const createPlugin = async (context) => {
  const api = context.hostApi;
  const seen = { requests: [], notifications: [], stderr: [], exits: [] };
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
          control: "stdio-control-v1",
          stateDirectory: true,
        });
        held.worker.onRequest(async (method, params) => {
          seen.requests.push({ method, params });
          return { status: 200, body: "fetched for the worker" };
        });
        held.worker.onNotification((method, params) => seen.notifications.push({ method, params }));
        held.worker.onStderr((chunk) => seen.stderr.push(chunk));
        held.worker.onExit((info) => seen.exits.push(info));
        const status = await held.worker.request("index_status", { scope: "all" });
        await held.worker.notify("reindex_requested", { reason: "folders-changed" });
        return {
          folders,
          driveRoot,
          lease: { ok: held.lease.ok, vendor: held.lease.vendor, leaseId: held.lease.leaseId },
          worker: { control: held.worker.control, pid: held.worker.pid, status },
        };
      },
      report_host: async () => {
        held.lease.release();
        return seen;
      },
    },
  };
};
