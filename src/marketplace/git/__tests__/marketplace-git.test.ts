import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { spawnManaged } from "../../../main/managed-child-processes.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: vi.fn(),
}));
vi.mock("../../../main/managed-child-processes.js", () => ({ spawnManaged: vi.fn() }));
vi.mock("../askpass.js", () => ({
  AskpassBroker: { start: async () => ({ launcherPath: "askpass", close: async () => {} }) },
}));

it.each([
  { code: "ENOENT", fallbackFails: false },
  { code: "EACCES", fallbackFails: false },
  { code: "EACCES", fallbackFails: true },
])("recovers from a cached marketplace launch reporting $code (fallback failure: $fallbackFails)", async ({ code, fallbackFails }) => {
  const root = await mkdtemp(join(tmpdir(), "ave-marketplace-cache-"));
  const binDirs = ["first", "second", "third"].map((name) => join(root, name));
  const candidates = binDirs.map((dir) => join(dir, process.platform === "win32" ? "git.exe" : "git"));
  try {
    vi.resetModules();
    vi.resetAllMocks();
    vi.stubEnv("PATH", binDirs.join(delimiter));
    await Promise.all(binDirs.map(async (dir, index) => {
      await mkdir(dir);
      await writeFile(candidates[index]!, "git fixture", { mode: 0o755 });
    }));
    const probes: string[] = [];
    vi.mocked(execFile).mockImplementation((file, args, _options, callback) => {
      if (Array.isArray(args) && args.includes("--version")) probes.push(file);
      callback?.(null, args?.includes("--version") ? "git version 2.56.0" : "", "");
      return {} as ReturnType<typeof execFile>;
    });
    let failLaunch = false;
    vi.mocked(spawnManaged).mockImplementation((file) => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
      queueMicrotask(() => {
        if (failLaunch && (file === candidates[0] || (fallbackFails && file === candidates[1]))) {
          child.emit("error", Object.assign(new Error("cannot start"), { code, path: file }));
        } else {
          child.stdout.write(file);
          child.emit("close", 0);
        }
      });
      return child as unknown as ReturnType<typeof spawnManaged>;
    });
    const { MarketplaceGit } = await import("../marketplace-git.js");
    const marketplace = new MarketplaceGit({ installerRoot: null, envRoot: join(root, "env"), getToken: async () => null });
    const run = () => marketplace.commands.run(["version"], { timeoutMs: 1_000 }).then(({ stdout }) => stdout.toString());
    try {
      await expect(run()).resolves.toBe(candidates[0]);
      failLaunch = true;
      if (fallbackFails) await expect(run()).rejects.toMatchObject({ code });
      else await expect(run()).resolves.toBe(candidates[1]);
      expect(probes).toEqual(candidates.slice(0, 2));
      expect(vi.mocked(spawnManaged).mock.calls.map(([file]) => file)).toEqual([candidates[0], ...candidates.slice(0, 2)]);
    } finally {
      await marketplace.close();
    }
  } finally {
    vi.unstubAllEnvs();
    await cleanupTmpDir(root);
  }
});
