import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { readAdminPolicyFile } from "../lib/admin-policy-file.js";
import { getAdminPolicyPath } from "../permissions/policy-store.js";
import { checkAdminPolicyPath } from "../shared/ave-home-test-guard.js";
import { readWindowsAdminPolicy } from "../shared/windows-admin-policy.js";
import { useScratchLinks, useTempDirs } from "./test-helpers.js";
import { setProcessPlatform } from "./support/process-platform.js";
import * as policyHome from "../shared/policy-home.js";
import { configureHostResources } from "../main/host-resources.js";

const scratch = useTempDirs("program-data-guard-");
const link = useScratchLinks();
const refusal = /refusing to access admin policy at .* from a test process; it is under the real /;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe.runIf(process.platform === "win32")("machine policy isolation", () => {
  it("inherits the global setup fixture in workers and their child processes", () => {
    const fixture = join(tmpdir(), "program-data");
    expect(fixture).not.toBe(inject("realProgramData"));
    expect(process.env.ProgramData).toBe(fixture);
    expect(process.env.PROGRAMDATA).toBe(fixture);
    expect(process.env.ALLUSERSPROFILE).toBe(fixture);
    expect(existsSync(join(fixture, "Ave"))).toBe(true);
    expect(getAdminPolicyPath()).toBe(join(fixture, "Ave", "policy.json"));
    const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
    const child = spawnSync(node, ["-e", "console.log(JSON.stringify([process.env.ProgramData, process.env.PROGRAMDATA, process.env.ALLUSERSPROFILE]))"], {
      encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([fixture, fixture, fixture]);
  });

  it("refuses the captured machine root after a test restores ProgramData or drops it", () => {
    const real = inject("realProgramData")!;
    expect(real).toBeTypeOf("string");
    vi.stubEnv("ProgramData", real);
    expect(() => getAdminPolicyPath()).toThrow(refusal);
    expect(() => checkAdminPolicyPath(join(real, "test-tmp", "Ave", "policy.json"))).toThrow(refusal);
    vi.stubEnv("ProgramData", undefined);
    expect(() => getAdminPolicyPath()).toThrow(refusal);
  });

  it("refuses explicit machine-policy reads before filesystem or native reader access", async () => {
    const path = join(inject("realProgramData")!, "Ave", "policy.json");
    await expect(readAdminPolicyFile(path)).rejects.toThrow(refusal);
    await expect(readWindowsAdminPolicy(path)).rejects.toThrow(refusal);
  });

  it("still refuses the machine root when a test simulates another platform", async () => {
    const platform = process.platform;
    try {
      setProcessPlatform("linux");
      const path = join(inject("realProgramData")!.toUpperCase(), "Ave", "policy.json");
      expect(() => checkAdminPolicyPath(path)).toThrow(refusal);
      await expect(readAdminPolicyFile(path)).rejects.toThrow(refusal);
    } finally {
      setProcessPlatform(platform);
    }
  });

  it("refuses restored machine policy before native sandbox initialization", async () => {
    vi.spyOn(policyHome, "policyHomeAnchors").mockReturnValue([scratch()]);
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const initialize = vi.spyOn(SandboxManager, "initialize").mockRejectedValue(new Error("Native initialization must not run"));
    const { initializeAsrtSandbox } = await import("../permissions/asrt-sandbox.js");
    vi.stubEnv("ProgramData", inject("realProgramData")!);
    await expect(initializeAsrtSandbox({ windows: { externalConfinement: true } })).rejects.toThrow(refusal);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("refuses machine paths in another case and accepts disjoint fixture roots", () => {
    const real = inject("realProgramData")!;
    expect(() => checkAdminPolicyPath(join(real.toUpperCase(), "Ave", "policy.json"))).toThrow(refusal);
    expect(() => checkAdminPolicyPath(join(scratch(), "Ave", "policy.json"))).not.toThrow();
  });

  it("refuses fixture junctions that resolve into the machine root", () => {
    const alias = link(inject("realProgramData")!, join(scratch(), "machine-link"));
    expect(() => checkAdminPolicyPath(join(alias, "Ave", "missing", "policy.json"))).toThrow(refusal);
  });

  it("accepts a fixture junction that stays outside the machine root", () => {
    const root = scratch();
    mkdirSync(join(root, "Ave"));
    const alias = link(root, join(scratch(), "fixture-link"));
    expect(() => checkAdminPolicyPath(join(alias, "Ave", "policy.json"))).not.toThrow();
  });
});
