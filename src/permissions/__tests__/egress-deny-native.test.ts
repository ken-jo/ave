/**
 * Proxy-deny attribution against the real sandbox (macOS Seatbelt, Linux
 * bwrap): a host off the strict allow-list is refused by ASRT's proxy, and the
 * refusal reaches the audit row under the invocation that opened it — a Bash
 * tool call by its toolUseId, a plugin worker by its plugin and worker — and
 * the Bash output carries the `<sandbox_violations>` annotation.
 *
 * The policy is the shipped one: `strictAllowlist: true`, nothing allowed, no
 * ask callback. Nothing leaves the machine: the proxy refuses before any DNS
 * lookup or connection.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  isPluginWorkerConfinementActive,
  resetAsrtSandbox,
  subscribeAsrtViolations,
  cleanupAsrtSandboxAfterCommand,
} from "../asrt-sandbox.js";
import { startEgressDenyMonitor } from "../egress-deny-monitor.js";
import { liveEgressInvocationCount } from "../egress-invocations.js";
import { spawnConfinedChild } from "../confined-child.js";
import { setPluginWorkerConfinementRequestedAtBoot } from "../sandbox-capability.js";
import type { SandboxEgressDenyAuditEntry } from "../../audit/sandbox-audit.js";
import { asrtCanInitialize } from "./test-helpers.js";
import { spawnWithSandbox } from "../../tools/shell-tools.js";
import { prepareSandboxFixture } from "../../tools/__tests__/support/prepared-shell.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const CURL = "/usr/bin/curl";
const nativeCapable = (process.platform === "darwin" || process.platform === "linux") && existsSync(CURL);

let stopMonitor: (() => void) | undefined;
afterEach(async () => {
  stopMonitor?.();
  stopMonitor = undefined;
  setPluginWorkerConfinementRequestedAtBoot(false);
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
});

async function startStrictSandboxWithMonitor(): Promise<SandboxEgressDenyAuditEntry[]> {
  const rows: SandboxEgressDenyAuditEntry[] = [];
  stopMonitor = await startEgressDenyMonitor({
    subscribe: subscribeAsrtViolations,
    emit: async (entry) => { rows.push(entry); },
    capability: () => ({ kind: "asrt", confidence: "verified" }),
  });
  await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
  return rows;
}

describe.runIf(nativeCapable)("proxy deny attribution (native)", () => {
  it("audits a Bash call's refused host under its toolUseId and annotates the output", async (context) => {
    if (!(await asrtCanInitialize())) return context.skip();
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "egress-deny-bash-")));
    try {
      const rows = await startStrictSandboxWithMonitor();
      const command = `${CURL} -sS -m 10 -o /dev/null http://example.com/ ; echo curl-done`;
      const before = liveEgressInvocationCount();
      const result = await spawnWithSandbox(command, cwd, [cwd], 30,
        prepareSandboxFixture(command, cwd, { toolUseId: "toolu_native_fixture" }));
      expect(result.output).toContain("curl-done");
      expect(result.output).toContain("<sandbox_violations>");
      expect(result.output).toMatch(/deny network-outbound example\.com:80 \(/);
      const row = rows.find((entry) => entry.deny.host === "example.com");
      expect(row, JSON.stringify(rows)).toBeDefined();
      expect(row!.invocation).toEqual({ kind: "shell", toolName: "bash", toolUseId: "toolu_native_fixture" });
      expect(row!.sandbox.events).toEqual([{ type: "egress_attempted", blocked: true, target: "example.com:80" }]);
      // The token was released with the process.
      expect(liveEgressInvocationCount()).toBe(before);
    } finally {
      await cleanupTmpDir(cwd);
    }
  }, 60_000);

  it("audits a plugin worker's refused host under the worker", async (context) => {
    if (!(await asrtCanInitialize())) return context.skip();
    // Plugin-worker confinement is its own boot setting; without it the child
    // would run unconfined and reach the network.
    setPluginWorkerConfinementRequestedAtBoot(true);
    const rows = await startStrictSandboxWithMonitor();
    expect(isPluginWorkerConfinementActive()).toBe(true);
    const { child, confinement } = await spawnConfinedChild({
      command: CURL,
      args: ["-sS", "-m", "10", "-o", "/dev/null", "http://example.org/"],
      label: "worker:native_fixture:indexer:asrt",
      egressOwner: { kind: "worker", role: "worker", pluginId: "native_fixture", instanceId: "indexer" },
      grantMode: "allow-list",
      tempPrincipal: { kind: "plugin", id: "native_fixture" },
      baseEnv: { PATH: "/usr/bin:/bin" },
    });
    expect(confinement).not.toBe("unconfined");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    await cleanupAsrtSandboxAfterCommand();
    const row = rows.find((entry) => entry.deny.host === "example.org");
    expect(row, JSON.stringify(rows)).toBeDefined();
    expect(row!.invocation).toEqual({ kind: "worker", role: "worker", pluginId: "native_fixture", instanceId: "indexer" });
  }, 60_000);
});
