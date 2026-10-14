/**
 * `--serve` drives the real `main()` of the headless host against a stubbed
 * boot: the question is only what the serve sequence does when the optional
 * Tailnet surface fails to start, so everything beneath the windowless host is
 * replaced and the listener, the Tailnet start and the shutdown are observed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startTailnetSurface = vi.fn<() => Promise<unknown>>();
const startLocalApi = vi.fn(async () => ({ port: 47_001 }));

vi.mock("../boot/node-host-runtime.js", () => ({ createNodeBootHost: vi.fn(async () => ({})) }));
vi.mock("../boot/dev-flags.js", () => ({ getIsPackaged: () => false }));
vi.mock("../main/main-paths.js", () => ({ projectRoot: "/project" }));
vi.mock("../main/ensure-workspace-cwd.js", () => ({ ensureWorkspaceCwd: vi.fn() }));
vi.mock("../main/project-root-authorization.js", () => ({ isAuthorizedWorkspaceProjectRoot: vi.fn(() => true) }));
vi.mock("../main/host-instance-lock.js", () => ({ acquireHostInstanceLock: vi.fn(async () => undefined) }));
vi.mock("../main/host-runtime-probe.js", () => ({ probeHostRuntimeResources: vi.fn() }));
vi.mock("../main/managed-child-processes.js", () => ({ sealManagedChildProcessAdmission: vi.fn() }));
vi.mock("../main/app-state.js", () => ({ setAppShutdownStarted: vi.fn() }));
vi.mock("../main/app-shutdown.js", () => ({
  runAppShutdownCleanup: vi.fn(async () => "completed"),
  runIncompleteBootShutdown: vi.fn(async () => "completed"),
  runShutdownHooks: vi.fn(),
}));
vi.mock("../workload/runtime.js", () => ({
  initializeWorkloadBroker: vi.fn(),
  isActiveWorkloadBrokerCwd: vi.fn(() => false),
}));
vi.mock("../main/windowless-host.js", () => ({
  createWindowlessHost: vi.fn(async () => ({
    services: { conversationLoop: { abortCurrentTurn: vi.fn() } },
    conversationSurfaceRuntime: { sharedProjection: { stop: vi.fn() } },
    startLocalApi,
    startTailnetSurface,
  })),
}));

const originalArgv = process.argv;
const originalLocalApi = process.env.AVE_LOCAL_API;
let stdout: string[] = [];
let stderr: string[] = [];

beforeEach(() => {
  process.argv = ["node", "headless", "--serve", "--user-data-dir=/tmp/ave-headless-serve-test"];
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout.push(String(chunk)); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr.push(String(chunk)); return true; });
});

afterEach(() => {
  process.argv = originalArgv;
  if (originalLocalApi === undefined) delete process.env.AVE_LOCAL_API;
  else process.env.AVE_LOCAL_API = originalLocalApi;
  process.exitCode = undefined;
  vi.restoreAllMocks();
  startTailnetSurface.mockReset();
});

/** Run `--serve` until it reports ready, then stop it the way an operator would. */
async function serveUntilReady(): Promise<number> {
  const { main } = await import("../headless-host.js");
  const exit = main();
  await vi.waitFor(() => expect(stdout.join("")).toContain("server-ready"));
  process.emit("SIGTERM");
  return await exit;
}

describe("headless --serve", () => {
  it("keeps serving the local API when the Tailnet surface fails to start", async () => {
    startTailnetSurface.mockRejectedValue(new Error("tailnet-observer-config-unreadable: /Users/example/.ave/tailnet.json"));

    const code = await serveUntilReady();

    expect(code).toBe(0);
    // The CLI contract is unchanged: one ready line naming the listener.
    expect(JSON.parse(stdout.join("").trim())).toMatchObject({ type: "server-ready", port: 47_001 });
    expect(stderr.join("")).toBe("headless: tailnet surface failed to start; serving the local API without it\n");
    // A fixed line: a start error can carry configuration paths.
    expect(stderr.join("")).not.toContain("/Users/");
  });

  it("serves silently when the Tailnet surface starts or stays off", async () => {
    startTailnetSurface.mockResolvedValue(null);

    const code = await serveUntilReady();

    expect(code).toBe(0);
    expect(stdout.join("")).toContain("server-ready");
    expect(stderr).toEqual([]);
  });
});
