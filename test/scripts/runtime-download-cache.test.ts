import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { readRepoFile } from "../../src/__tests__/test-helpers.js";
const workflow = parse(readRepoFile(".github/workflows/ci.yml"));
const jobIds = ["build", "vitest", "gate-core", "mxc-pins", "windows-permission-tests", "macos-permission-tests", "linux-confinement-tests"];
const cacheAction = "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9";

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
    expect(job.env.AVE_UV_DOWNLOAD_CACHE_DIR).toBe("${{ github.workspace }}/.cache/uv-archives");
    const directory = job.env.ELECTRON_CACHE.replace("${{ github.workspace }}/", "");
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
    expect(cache.path.trim().split("\n")).toEqual([".cache/uv-archives", "${{ inputs.repository }}/resources/mxc"]);
    for (const field of ["runner.os", "runner.arch", "scripts/uv-targets.mjs", "scripts/fetch-uv.mjs", "src/permissions/mxc-launcher-pins.json", "scripts/fetch-mxc.mjs"]) {
      expect(cache.key).toContain(field);
    }
    expect(cache["restore-keys"]).toBeUndefined();
  });
  it("restores installer tools before the install and retains installer download caches", () => {
    const job = parse(readRepoFile(".github/workflows/build-installers.yml")).jobs.installers;
    expect(job.env.AVE_UV_DOWNLOAD_CACHE_DIR).toBe("${{ github.workspace }}/.cache/uv-archives");
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
