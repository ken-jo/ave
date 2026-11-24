// The container route for plugin workers: one holder per run, never the account grant path. A changed grant is a new
// run; in-flight calls of the ended one are refused, never replayed.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { MxcProcessCleanupError } from "../mxc-extension-errors.js";

interface FakeHolder {
  readonly input: Record<string, unknown>;
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly release: ReturnType<typeof vi.fn>;
  finishRelease(error?: Error): void;
}

const holders: FakeHolder[] = [];
let selected = true;
let startFailure: Error | undefined;
const spawnMxcBundledHolder = vi.fn(async (input: Record<string, unknown>) => {
  if (startFailure) throw startFailure;
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let settle!: { resolve: () => void; reject: (error: Error) => void };
  let complete!: (result: { exitCode: number; timedOut: boolean }) => void;
  const completion = new Promise<{ exitCode: number; timedOut: boolean }>((resolve) => { complete = resolve; });
  const released = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
  const release = vi.fn(() => released);
  const holder: FakeHolder = {
    input, stdin, stdout, stderr, release,
    finishRelease(error) {
      if (error) return settle.reject(error);
      stdout.end();
      stderr.end();
      complete({ exitCode: 0, timedOut: false });
      settle.resolve();
    },
  };
  holders.push(holder);
  stdin.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf-8").split("\n").filter(Boolean)) {
      const frame = JSON.parse(line) as { method?: string };
      if (frame.method === "$/ai.agent-connector.ave/hello") {
        stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, result: { protocol: "ave-worker-stdio-control", version: "1" } })}\n`);
      }
    }
  });
  return { process: { id: 4242, stdin, stdout, stderr, completion }, confinement: "windows-mxc", release, quarantined: false };
});
vi.mock("../../sandbox/wrap-bundled-command.js", () => ({
  isMxcExtensionBackendSelected: () => selected,
  spawnMxcBundledHolder: (input: Record<string, unknown>) => spawnMxcBundledHolder(input),
}));

const accountRoute = {
  startWindowsAclGrantHolder: vi.fn(() => { throw new Error("account grant holder reached"); }),
  grantWindowsWorkerFilesystemAccess: vi.fn(() => { throw new Error("account grant reached"); }),
  spawnConfinedChild: vi.fn(() => { throw new Error("account launcher reached"); }),
};
vi.mock("../windows-acl-grant-holder.js", () => ({
  startWindowsAclGrantHolder: () => accountRoute.startWindowsAclGrantHolder(),
  stopWindowsAclGrantHolder: () => {},
  terminateChildBestEffort: () => {},
}));
vi.mock("../confined-child.js", () => ({ spawnConfinedChild: () => accountRoute.spawnConfinedChild() }));
vi.mock("../asrt-sandbox.js", () => ({
  assertExtensionStartAllowed: () => {},
  isPluginWorkerConfinementActive: () => true,
  cleanupAsrtSandboxAfterCommand: async () => {},
  grantWindowsWorkerFilesystemAccess: () => accountRoute.grantWindowsWorkerFilesystemAccess(),
}));
const marks = { mark: vi.fn(), unmark: vi.fn() };
vi.mock("../sandbox-capability.js", () => ({
  markPluginWorkerWrapped: (...ids: unknown[]) => marks.mark(...ids),
  unmarkPluginWorkerWrapped: (...ids: unknown[]) => marks.unmark(...ids),
}));
vi.mock("../../main/managed-child-processes.js", () => ({
  assertManagedChildProcessAdmissionOpen: () => {},
  trackManagedChildProcess: () => () => {},
}));

import { __resetActiveWrappedWorkersForTest, spawnWorker, WorkerAlreadyRunningError } from "../worker-spawn.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeAll(() => { Object.defineProperty(process, "platform", { value: "win32" }); });
afterAll(() => { Object.defineProperty(process, "platform", platform); });
beforeEach(() => {
  holders.length = 0;
  selected = true;
  startFailure = undefined;
  vi.clearAllMocks();
  __resetActiveWrappedWorkersForTest();
});

const spec = (write: string) => ({
  pluginId: "example-plugin",
  workerId: "indexer",
  command: "D:\\payload\\worker.exe",
  args: ["--serve"],
  env: { EXAMPLE_MODE: "1" },
  allowReadPaths: ["D:\\payload"],
  allowWritePaths: [write],
});

describe("contained plugin worker", () => {
  it("starts in its own holder with the spec's grants and never reaches the account route", async () => {
    const worker = await spawnWorker({ ...spec("D:\\work\\a"), control: "output-only-v1" });

    expect(holders).toHaveLength(1);
    expect(holders[0]!.input).toMatchObject({
      label: "worker:example-plugin:indexer",
      command: "D:\\payload\\worker.exe",
      args: ["--serve"],
      holderEnv: { EXAMPLE_MODE: "1" },
      allowRead: ["D:\\payload"],
      allowWrite: ["D:\\work\\a"],
      ownedReadRoots: ["D:\\payload"],
      egressOwner: { kind: "worker", role: "worker", pluginId: "example-plugin", instanceId: "indexer" },
      workerTransport: "output-only-v1",
    });
    expect(worker.pid).toBe(4242);
    expect(marks.mark).toHaveBeenCalledWith("example-plugin", "indexer");
    for (const reached of Object.values(accountRoute)) expect(reached).not.toHaveBeenCalled();
  });

  it("ends the run on stop: in-flight calls are refused, the exit is reported, and changed grants start a new holder", async () => {
    const worker = await spawnWorker({ ...spec("D:\\work\\a"), control: "stdio-control-v1" });
    const exits: unknown[] = [];
    worker.onExit((info) => exits.push(info));
    const inFlight = worker.request("slow", {});
    const refused = expect(inFlight).rejects.toMatchObject({ code: "worker-incarnation-ended" });

    worker.stop();
    await refused;
    expect(holders[0]!.release).toHaveBeenCalledTimes(1);
    // Still stopping: the identity is not free, so the new grants cannot start beside the old run.
    await expect(spawnWorker({ ...spec("D:\\work\\b"), control: "stdio-control-v1" })).rejects.toBeInstanceOf(WorkerAlreadyRunningError);
    expect(holders).toHaveLength(1);

    holders[0]!.finishRelease();
    await vi.waitFor(() => expect(exits).toEqual([{ code: 0, signal: null, reason: "stopped" }]));
    expect(marks.unmark).toHaveBeenCalledWith("example-plugin", "indexer");
    await expect(worker.request("late", {})).rejects.toMatchObject({ code: "worker-incarnation-ended" });

    const next = await spawnWorker({ ...spec("D:\\work\\b"), control: "stdio-control-v1" });
    expect(holders).toHaveLength(2);
    expect(holders[1]!.input.allowWrite).toEqual(["D:\\work\\b"]);
    expect(holders[1]!.stdin).not.toBe(holders[0]!.stdin);
    next.stop();
    holders[1]!.finishRelease();
  });

  it("refuses a respawn after an unverified termination", async () => {
    const worker = await spawnWorker({ ...spec("D:\\work\\a"), control: "output-only-v1" });
    worker.stop();
    holders[0]!.finishRelease(new Error("termination unverified"));
    await vi.waitFor(() => expect(marks.unmark).toHaveBeenCalled());

    await expect(spawnWorker({ ...spec("D:\\work\\a"), control: "output-only-v1" })).rejects.toBeInstanceOf(WorkerAlreadyRunningError);
    expect(holders).toHaveLength(1);
  });

  it("keeps the identity reserved when startup cleanup is unverified, and frees it on any other refusal", async () => {
    startFailure = new Error("refused before creation");
    await expect(spawnWorker({ ...spec("D:\\work\\a"), control: "output-only-v1" })).rejects.toThrow("refused before creation");
    startFailure = Object.assign(Object.create(MxcProcessCleanupError.prototype) as Error, { message: "cleanup unverified" });
    await expect(spawnWorker({ ...spec("D:\\work\\a"), control: "output-only-v1" })).rejects.toBeInstanceOf(MxcProcessCleanupError);
    startFailure = undefined;
    await expect(spawnWorker({ ...spec("D:\\work\\a"), control: "output-only-v1" })).rejects.toBeInstanceOf(WorkerAlreadyRunningError);
    for (const reached of Object.values(accountRoute)) expect(reached).not.toHaveBeenCalled();
  });

  it("keeps the account route when the container backend is not selected", async () => {
    selected = false;
    await expect(spawnWorker({ ...spec("D:\\work\\a"), control: "output-only-v1" })).rejects.toThrow("account grant holder reached");
    expect(spawnMxcBundledHolder).not.toHaveBeenCalled();
  });
});
