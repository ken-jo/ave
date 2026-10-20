/**
 * The shell sandbox (`features.osToolSandbox`) and plugin-worker confinement
 * (`features.pluginWorkerConfinement`) are separate scopes over one ASRT
 * runtime. ASRT activates when either is requested; each spawn path asks its
 * own scope's gate, so turning one setting on never confines the other kind of
 * process.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  isPluginWorkerConfinementActive,
  isShellSandboxActive,
  resetAsrtSandbox,
} from "../asrt-sandbox.js";
import {
  __resetSandboxRequestedAtBootForTest,
  setPluginWorkerConfinementRequestedAtBoot,
  setShellSandboxRequestedAtBoot,
} from "../sandbox-capability.js";

// Gate state only: these tests do not claim OS confinement.
vi.mock("@anthropic-ai/sandbox-runtime", () => ({ SandboxManager: {
  setParentProxyRouter: () => undefined,
  initialize: async () => undefined,
  updateConfig: () => undefined,
  reset: async () => undefined,
  cleanupAfterCommand: () => undefined,
} }));

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  __resetSandboxRequestedAtBootForTest();
});

describe("scoped sandbox gates", () => {
  it.each([
    { shell: false, workers: false },
    { shell: true, workers: false },
    { shell: false, workers: true },
    { shell: true, workers: true },
  ])("with ASRT active, shell=$shell workers=$workers gates only the requested scopes", async ({ shell, workers }) => {
    setShellSandboxRequestedAtBoot(shell);
    setPluginWorkerConfinementRequestedAtBoot(workers);
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });

    expect(isAsrtSandboxActive()).toBe(true);
    expect(isShellSandboxActive()).toBe(shell);
    expect(isPluginWorkerConfinementActive()).toBe(workers);
  });

  it("neither scope is active while ASRT is not initialized, whatever was requested", () => {
    setShellSandboxRequestedAtBoot(true);
    setPluginWorkerConfinementRequestedAtBoot(true);

    expect(isAsrtSandboxActive()).toBe(false);
    expect(isShellSandboxActive()).toBe(false);
    expect(isPluginWorkerConfinementActive()).toBe(false);
  });
});

describe("each spawn path reads only its own scope's gate", () => {
  const srcRoot = join(__dirname, "..", "..");
  const source = (relative: string): string => readFileSync(join(srcRoot, relative), "utf8");

  // Extension processes: plugin workers, plugin children, plugin hooks, MCP
  // stdio servers, and the surfaces that tell the user whether hooks run
  // confined.
  const workerPaths = [
    "permissions/worker-spawn.ts",
    "permissions/confined-child.ts",
    "plugins/isolation/out-of-process-plugin.ts",
    "mcp/mcp-client.ts",
    "hooks/script-hook-runner.ts",
    "ipc/domains/plugin-studio.ts",
    "marketplace/app/service.ts",
  ];
  // Host shells outside the execution plan (the plan itself reads
  // `detectShellSandboxCapability`).
  const shellPaths = ["main/terminal/pty-manager.ts"];

  it.each(workerPaths)("%s gates on plugin-worker confinement, never the raw or shell gate", (file) => {
    const text = source(file);
    expect(text).toMatch(/\bisPluginWorkerConfinementActive\(\)/);
    expect(text).not.toMatch(/\bisAsrtSandboxActive\b/);
    expect(text).not.toMatch(/\bisShellSandboxActive\b/);
  });

  it.each(shellPaths)("%s gates on the shell sandbox, never the raw or worker gate", (file) => {
    const text = source(file);
    expect(text).toMatch(/\bisShellSandboxActive\(\)/);
    expect(text).not.toMatch(/\bisAsrtSandboxActive\b/);
    expect(text).not.toMatch(/\bisPluginWorkerConfinementActive\b/);
  });

  it("no source outside the ASRT runtime and its boot steps reads the raw gate", () => {
    // The inverse of the allow-lists above: a NEW spawn path that reaches for
    // the raw state would confine (or not) by the wrong scope.
    const allowed = new Set([
      "permissions/asrt-sandbox.ts",
      "boot/steps/marketplace-setup.ts",
      "boot/steps/sandbox-init.ts",
    ]);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mts)$/.test(entry.name)) continue;
        const rel = relative(srcRoot, full).split(sep).join("/");
        if (allowed.has(rel)) continue;
        const code = readFileSync(full, "utf8").split("\n").filter((line) => {
          const trimmed = line.trim();
          return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
        });
        if (code.some((line) => /\bisAsrtSandboxActive\b/.test(line))) offenders.push(rel);
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });

  it("the host-shell plan reads the shell-scoped capability and the shell seal", () => {
    const text = source("permissions/sandbox-capability.ts");
    const plan = text.slice(text.indexOf("export function getHostShellExecutionPlan"));
    const body = plan.slice(0, plan.indexOf("\n}\n"));
    expect(body).toContain("requestedSandbox: isShellSandboxRequestedAtBoot()");
    // MXC's per-command capability (Windows) or else the shell-scoped one;
    // never the process-wide or worker capability.
    expect(body).toContain("activeCapability: mxc ?? detectShellSandboxCapability()");
    expect(body).toContain("const mxc = detectMxcShellCapability();");
  });
});
