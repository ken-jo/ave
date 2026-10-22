import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { carryPluginSocketDirs } from "../../plugins/plugin-storage-layout.js";
import { aveHome } from "../../shared/ave-home.js";
import { spawnWorker } from "../worker-spawn.js";

const allocation = vi.hoisted(() => ({
  workerDir: "",
  mkdirEntered: false,
  beforeMove: undefined as { to: string; wait: () => Promise<void> } | undefined,
  ready: () => {},
  finishSpawn: undefined as Promise<never> | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (String(args[0]) === allocation.workerDir) allocation.mkdirEntered = true;
      return actual.mkdir(...args);
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (String(args[1]) === allocation.beforeMove?.to) {
        const pause = allocation.beforeMove;
        allocation.beforeMove = undefined;
        await pause.wait();
      }
      return actual.rename(...args);
    },
  };
});

vi.mock("../asrt-sandbox.js", () => ({
  assertExtensionStartAllowed: () => undefined,
  isAsrtSandboxActive: () => true,
  isPluginWorkerConfinementActive: () => true,
  registerWorkerUnixSocketDir: async () => {},
  unregisterWorkerUnixSocketDir: async () => {},
  cleanupAsrtSandboxAfterCommand: async () => {},
}));
vi.mock("../confined-child.js", () => ({
  spawnConfinedChild: async () => {
    allocation.ready();
    return allocation.finishSpawn;
  },
}));
vi.mock("../sandbox-process-home.js", () => ({
  createSandboxProcessHome: () => ({ path: allocation.workerDir, env: {}, cleanup: () => {} }),
}));

describe("worker allocation during runtime-directory carry", () => {
  it.skipIf(process.platform === "win32")("queues a worker mkdir requested between preflight and the entry move", async () => {
    const root = await mkdtemp("/tmp/lwsc-");
    vi.stubEnv("AVE_HOME", root);
    const pluginId = "socket-carry-allocation";
    const live = join(aveHome(), "plugins", pluginId);
    const backup = join(root, "backup");
    const workerDir = join(live, "run", "worker");
    await mkdir(join(live, "run"), { recursive: true });
    await mkdir(join(backup, "run", "worker"), { recursive: true });
    const runtimeInode = statSync(join(live, "run")).ino;
    const leafInode = statSync(join(backup, "run", "worker")).ino;
    let resumeMove!: () => void;
    let reachedMove!: () => void;
    let rejectSpawn!: (error: Error) => void;
    const moveReached = new Promise<void>((resolve) => { reachedMove = resolve; });
    const moveResumed = new Promise<void>((resolve) => { resumeMove = resolve; });
    const workerReady = new Promise<void>((resolve) => { allocation.ready = resolve; });
    allocation.finishSpawn = new Promise<never>((_, reject) => { rejectSpawn = reject; });
    allocation.finishSpawn.catch(() => {});
    allocation.workerDir = workerDir;
    allocation.mkdirEntered = false;
    allocation.beforeMove = { to: workerDir, wait: async () => { reachedMove(); await moveResumed; } };
    const carry = carryPluginSocketDirs(live, backup, { onConflict: "reject" });
    let worker: Promise<unknown> | undefined;
    try {
      await moveReached;
      worker = spawnWorker({ pluginId, workerId: "worker", command: process.execPath }).catch((error: Error) => error);
      // Let the independently requested host operation reach its queue. Without
      // exclusion it calls the real mkdir before the paused rename resumes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(allocation.mkdirEntered).toBe(false);
      expect(statSync(join(backup, "run", "worker")).ino).toBe(leafInode);
      resumeMove();
      await carry;
      await Promise.race([workerReady, worker.then((error) => { throw error; })]);
      expect(allocation.mkdirEntered).toBe(true);
      expect(statSync(join(backup, "run")).ino).toBe(runtimeInode);
      expect(statSync(join(backup, "run", "worker")).ino).toBe(leafInode);
    } finally {
      resumeMove();
      await carry.catch(() => {});
      rejectSpawn(new Error("worker allocation inspected"));
      await worker;
      allocation.beforeMove = undefined;
      allocation.finishSpawn = undefined;
      vi.unstubAllEnvs();
      await rm(live, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
