// Proxy refusals must reach the owning invocation's audit and shell annotation; an empty strict allowlist denies before DNS or any external connection.
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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
import { sandboxCasesRequired, sandboxCasesRun } from "../../plugins/isolation/__tests__/sandbox-cases.js";
import { spawnWithSandbox } from "../../tools/shell-tools.js";
import { prepareSandboxFixture } from "../../tools/__tests__/support/prepared-shell.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";

const CURL = "/usr/bin/curl";
const nativePlatform = process.platform === "darwin" || process.platform === "linux";

// Skip, with its reason, where ASRT cannot initialise or curl is absent; fail instead where a confinement job asks for real sandbox cases (AVE_REQUIRE_SANDBOX_CASES=1), so a green job is a measurement.
async function requireNativeCase(context: TestContext): Promise<void> {
  if (!(await sandboxCasesRun())) context.skip("ASRT cannot initialize (sandbox dependencies missing)");
  if (!existsSync(CURL)) {
    if (sandboxCasesRequired()) {
      throw new Error(`AVE_REQUIRE_SANDBOX_CASES=1 but ${CURL} is missing, so the proxy-deny cases would measure nothing`);
    }
    context.skip(`${CURL} is missing`);
  }
}

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
    emit: async (entry) => { if (entry.entryKind === "egress-deny") rows.push(entry); },
    capability: () => ({ kind: "asrt", confidence: "verified" }),
  });
  await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
  // Subscription replays retained records; observe only attempts started by this fixture.
  rows.length = 0;
  return rows;
}

describe.runIf(nativePlatform)("proxy deny attribution (native)", () => {
  for (const kind of ["direct", "literal shell", "opaque script"] as const) {
    it(`denies an actual ${kind} upload outside the host allowlist`, async (context) => {
      await requireNativeCase(context);
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), "egress-deny-upload-")));
      try {
        const payload = join(cwd, "upload.txt");
        writeFileSync(payload, "synthetic upload fixture\n");
        const rows = await startStrictSandboxWithMonitor();
        const upload = `${CURL} -q --noproxy '' -sS --fail --max-time 10 --upload-file ${shellQuote(payload)} --output /dev/null http://example.com/upload`;
        const script = join(cwd, "upload.sh");
        writeFileSync(script, `uploader=${shellQuote(upload)}\neval "$uploader"\n`);
        const invocation = kind === "direct" ? upload : kind === "literal shell"
          ? `/bin/sh -c ${shellQuote(upload)}`
          : `/bin/sh ${shellQuote(script)}`;
        const command = `${invocation}; printf '\\nupload-exit=%s\\n' "$?"`;
        const toolUseId = `toolu_native_upload_${kind.replaceAll(" ", "_")}`;
        const before = liveEgressInvocationCount();
        // Execute directly through the confined transport: no command-text permission screen supplies this denial.
        const result = await spawnWithSandbox(command, cwd, [cwd], 30,
          prepareSandboxFixture(command, cwd, { toolUseId }));
        expect(result.output).toMatch(/upload-exit=[1-9]\d*\b/);
        expect(result.output).toContain("<sandbox_violations>");
        expect(result.output).toMatch(/deny network-outbound example\.com:80 \(/);
        const row = rows.find(entry => entry.deny.host === "example.com");
        expect(row, JSON.stringify(rows)).toBeDefined();
        expect(row!.invocation).toEqual({ kind: "shell", toolName: "bash", toolUseId });
        expect(row!.sandbox.events).toEqual([{ type: "egress_attempted", blocked: true, target: "example.com:80" }]);
        expect(liveEgressInvocationCount()).toBe(before);
      } finally {
        await cleanupTmpDir(cwd);
      }
    }, 60_000);
  }

  it("audits a Bash call's refused host under its toolUseId and annotates the output", async (context) => {
    await requireNativeCase(context);
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
    await requireNativeCase(context);
    // Plugin-worker confinement is its own boot setting; without it the child would run unconfined and reach the network.
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
