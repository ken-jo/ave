import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { githubExpression as expr, readRepoFile } from "../../src/__tests__/test-helpers.js";
const workflow = parse(readRepoFile(".github/workflows/ci.yml"));
const jobIds = ["build", "vitest", "gate-core", "mxc-pins", "windows-permission-tests", "macos-permission-tests", "linux-confinement-tests"];
const cacheAction = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";
const workspace = expr("github.workspace");
const uvArchives = `${workspace}/.cache/uv-archives`;
const installerPath = createRequire(import.meta.url).resolve("electron/install.js");
const installerRequire = createRequire(installerPath);
interface InstallerDownloadOptions {
  version: string;
  cacheRoot?: string;
  force?: boolean;
  checksums?: Record<string, string>;
  unsafelyDisableChecksums?: boolean;
}

function installerDownloadOptions(env: NodeJS.ProcessEnv): InstallerDownloadOptions {
  let options: InstallerDownloadOptions | undefined;
  runInNewContext(fs.readFileSync(installerPath, "utf8"), {
    __dirname: dirname(installerPath),
    process: { env, platform: "win32", arch: "x64" },
    require: (id: string) => {
      if (id === "fs") return { ...fs, readFileSync: () => { throw new Error("Dependency is not installed"); } };
      if (id === "@electron/get") return {
        downloadArtifact: (details: InstallerDownloadOptions) => {
          options = details;
          // Stop before extraction; the real downloader is exercised below.
          return new Promise(() => {});
        },
      };
      return installerRequire(id);
    },
  });
  if (!options) throw new Error("Installer did not request its dependency archive");
  return options;
}

const installerWorkflow = parse(readRepoFile(".github/workflows/build-installers.yml"));
const installerJobs = [
  ...jobIds.map((id) => ({ id, job: workflow.jobs[id] })),
  { id: "installers", job: installerWorkflow.jobs.installers },
];

describe("dependency installer archive cache behavior", () => {
  it.each(installerJobs)("uses the restored directory and verifies cached bytes in $id", async ({ job }) => {
    const root = fs.mkdtempSync(join(tmpdir(), "installer-cache-"));
    try {
      const restored = job.steps
        .filter((step: { uses?: string }) => step.uses === cacheAction)
        .flatMap((step: { with: { path: string } }) => step.with.path.trim().split("\n"))
        .find((path: string) => /^\.cache\/electron(?:-win)?$/.test(path));
      if (!restored) throw new Error("Restored archive directory is missing");
      const restoredPath = join(root, restored);
      const env = Object.fromEntries(Object.entries(job.env as Record<string, string>)
        .map(([key, value]) => [key, value.replace(workspace, root)]));
      const options = installerDownloadOptions(env);
      if (!options.cacheRoot) throw new Error("Installer cache directory is missing");
      expect(resolve(options.cacheRoot)).toBe(restoredPath);
      expect(options.force).toBe(false);
      expect(options.unsafelyDisableChecksums).not.toBe(true);
      expect(options.checksums).toEqual(installerRequire("./checksums.json"));

      const { downloadArtifact: download } = installerRequire("@electron/get");
      const payload = "dependency archive fixture";
      let downloads = 0;
      let corrupt = false;
      const details = {
        ...options,
        // Fixture bytes use a fixture pin; installer pins are checked above.
        checksums: { [`electron-v${options.version}-win32-x64.zip`]: createHash("sha256").update(payload).digest("hex") },
        downloader: { download: async (_url: string, target: string) => {
          downloads++;
          fs.writeFileSync(target, corrupt ? "corrupt" : payload);
        } },
      };
      const archive = await download(details);
      expect(dirname(dirname(archive))).toBe(restoredPath);
      expect(basename(archive)).toBe(`electron-v${options.version}-win32-x64.zip`);
      expect(await download(details)).toBe(archive);
      expect(downloads).toBe(1);
      fs.writeFileSync(archive, "corrupt");
      corrupt = true;
      await expect(download(details)).rejects.toThrow(/checksum/i);
      expect(downloads).toBe(2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runtime download cache wiring", () => {
  it.each(jobIds)("restores fetched tools and archive downloads before %s installs dependencies", (id) => {
    const job = workflow.jobs[id];
    const steps = job.steps;
    const install = steps.findIndex((step: { run?: string }) => step.run === "bun install --frozen-lockfile");
    const tools = steps.findIndex((step: { uses?: string }) => step.uses === "./ave/.github/actions/cache-runtime-tools");
    expect(tools).toBeGreaterThan(-1);
    expect(tools).toBeLessThan(install);
    expect(steps[tools].with.repository).toBe("ave");
    expect(steps[tools].if).toBe(steps[install].if);
    expect(job.env.AVE_UV_DOWNLOAD_CACHE_DIR).toBe(uvArchives);
    const directory = job.env.ELECTRON_CACHE.replace(`${workspace}/`, "");
    const archives = steps.findIndex((step: { uses?: string; with?: { path?: string } }) => step.uses === cacheAction && step.with?.path === directory);
    expect(archives).toBeGreaterThan(-1);
    expect(archives).toBeLessThan(install);
    expect(steps[archives].with.key).toContain("hashFiles('ave/bun.lock')");
  });
  it("invalidates fetched tools when target pins or verification rules change", () => {
    const steps = parse(readRepoFile(".github/actions/cache-runtime-tools/action.yml")).runs.steps;
    expect(steps).toHaveLength(1);
    expect(steps[0].uses).toBe(cacheAction);
    const cache = steps[0].with;
    expect(cache.path.trim().split("\n")).toEqual([".cache/uv-archives", `${expr("inputs.repository")}/resources/mxc`]);
    for (const field of ["runner.os", "runner.arch", "scripts/uv-targets.mjs", "scripts/fetch-uv.mjs", "src/permissions/mxc-launcher-pins.json", "scripts/fetch-mxc.mjs"]) {
      expect(cache.key).toContain(field);
    }
    expect(cache["restore-keys"]).toBeUndefined();
  });
  it("restores installer tools before the install and retains installer download caches", () => {
    const job = parse(readRepoFile(".github/workflows/build-installers.yml")).jobs.installers;
    expect(job.env.AVE_UV_DOWNLOAD_CACHE_DIR).toBe(uvArchives);
    const steps = job.steps;
    const tools = steps.findIndex((step: { uses?: string }) => step.uses === "./.github/actions/cache-runtime-tools");
    const install = steps.findIndex((step: { run?: string }) => step.run?.includes("bun install --frozen-lockfile"));
    expect(tools).toBeGreaterThan(-1);
    expect(tools).toBeLessThan(install);
    const archives = steps.find((step: { name?: string }) => step.name === "Restore package manager and installer caches");
    expect(archives.with.path).toContain(".cache/electron\n");
    expect(archives.with.path).toContain(".cache/electron-builder");
  });
});
