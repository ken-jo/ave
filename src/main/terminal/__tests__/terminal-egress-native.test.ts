// Exercise real proxy, grant store, terminal spawn, and shell traffic against public HTTPS. Local destinations bypass or fail the proxy guard; required
// jobs fail the network precondition instead of repeating case failures.
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxEgressDecisionAuditEntry } from "../../../audit/sandbox-audit.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox } from "../../../permissions/asrt-sandbox.js";
import {
  createEgressAskCallback,
  EGRESS_DENY_REASONS,
  type EgressApprovalAnswer,
  type EgressApprovalRequest,
} from "../../../permissions/egress-ask.js";
import { EgressGrantStore } from "../../../permissions/egress-grants.js";
import { egressIdentityStrength } from "../../../permissions/egress-identity.js";
import {
  egressInvocationAbortSignal,
  egressInvocationOwner,
  onEgressInvocationReleased,
} from "../../../permissions/egress-invocations.js";
import {
  __resetActiveSandboxCapabilityForTest,
  setActiveSandboxCapability,
  setShellSandboxRequestedAtBoot,
} from "../../../permissions/sandbox-capability.js";
import { sandboxConfinementForPlatform } from "../../../shared/sandbox-capability-info.js";
import { sandboxCasesRequired, sandboxCasesRun } from "../../../plugins/isolation/__tests__/sandbox-cases.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import {
  __resetTerminalsForTest,
  killTerminal,
  setTerminalEmitter,
} from "../pty-manager.js";
import { spawnTerminal, writeTerminal } from "../../../__tests__/support/terminal-agent-fixture.js";

const CURL = "/usr/bin/curl";
// The IANA example domains serve the same page; the first one this runner reaches is the destination for every case.
const HOSTS = ["example.com", "example.net", "example.org"];
let HOST = HOSTS[0]!;
const PORT = 443;
const TAB = "terminal:0e9a5c11-1";
const OTHER_TAB = "terminal:0e9a5c11-2";
const BODY = "Example Domain";

let dir: string | undefined;
// Each tab's output since the test began.
const outputs = new Map<string, string>();
let stopReleaseListener: (() => void) | undefined;

// One probe per run: concurrent callers share the in-flight promise, so HOST is chosen once.
let reachable: Promise<boolean> | undefined;

async function requireNativeCase(context: TestContext): Promise<void> {
  if (!(await sandboxCasesRun())) context.skip("ASRT cannot initialize (sandbox dependencies missing)");
  if (!existsSync(CURL)) {
    if (sandboxCasesRequired()) throw new Error(`AVE_REQUIRE_SANDBOX_CASES=1 but ${CURL} is missing`);
    context.skip(`${CURL} is missing`);
  }
  // Control: unconfined, this machine reaches the host at all. Where it does not, the precondition case below reports it; the cases have nothing to measure.
  if (!(await hostReachable())) context.skip(networkUnreachable());
}

const unreachableReasons: string[] = [];
const networkUnreachable = () =>
  `network unreachable: none of ${HOSTS.map((host) => `https://${host}/`).join(", ")} can be fetched from this machine without the sandbox (${unreachableReasons.join("; ")}), so the terminal egress cases would measure nothing`;

// Hosted runners drop a fetch now and then, and one host can answer 5xx to a runner's address range for a while; one miss would fail the required precondition. Try each
// example domain a few times within the 45 s test timeout.
async function hostReachable(): Promise<boolean> {
  reachable ??= (async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
      for (const host of HOSTS) {
        const reason = await fetch(`https://${host}/`, { signal: AbortSignal.timeout(4_000) }).then((res) => (res.ok ? undefined : `${host} ${res.status}`), (error: unknown) => `${host} ${String(error)}`);
        if (reason === undefined) {
          HOST = host;
          return true;
        }
        unreachableReasons.push(reason);
      }
    }
    return false;
  })();
  return await reachable;
}

beforeEach(() => {
  outputs.clear();
});

afterEach(async () => {
  killTerminal(TAB);
  __resetTerminalsForTest();
  setTerminalEmitter(() => {});
  stopReleaseListener?.();
  stopReleaseListener = undefined;
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  setShellSandboxRequestedAtBoot(false);
  __resetActiveSandboxCapabilityForTest();
  if (dir !== undefined) await cleanupTmpDir(dir);
  dir = undefined;
});

interface Harness {
  readonly asked: EgressApprovalRequest[];
  readonly audit: SandboxEgressDecisionAuditEntry[];
  readonly grants: EgressGrantStore;
}

// Boot's network shape with this test's answers in place of the window: the same callback the app installs, over a grant store in a temp directory.
async function startSandbox(
  answer: (request: EgressApprovalRequest) => Promise<EgressApprovalAnswer>,
  terminalAskTimeoutMs?: number,
): Promise<Harness> {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "terminal-egress-native-")));
  const grants = new EgressGrantStore(join(dir, "shell-egress-hosts.json"));
  // As egress-runtime wires it: the tab's grants go with its shell.
  stopReleaseListener = onEgressInvocationReleased((token, { owner }) => {
    grants.releaseToken(token);
    if (owner.kind === "terminal") grants.releaseTab(owner.tabId);
  });
  const asked: EgressApprovalRequest[] = [];
  const audit: SandboxEgressDecisionAuditEntry[] = [];
  const callback = createEgressAskCallback({
    identityStrength: egressIdentityStrength,
    ownerOf: egressInvocationOwner,
    abortSignalOf: egressInvocationAbortSignal,
    workerAllowedDomains: () => [],
    grants,
    networkRule: async () => undefined,
    shellAskEnabled: () => true,
    requester: () => async (request) => {
      asked.push(request);
      return answer(request);
    },
    audit: (entry) => audit.push(entry),
    ...(terminalAskTimeoutMs === undefined ? {} : { terminalAskTimeoutMs }),
  });
  setShellSandboxRequestedAtBoot(true);
  await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: false }, callback);
  // What boot publishes once ASRT is up (sandbox-init.ts): the terminal only opens on a host that contains filesystem and process.
  setActiveSandboxCapability({
    kind: "asrt",
    confidence: "verified",
    platform: process.platform,
    reason: "ASRT active (terminal egress acceptance)",
    confines: sandboxConfinementForPlatform(process.platform, "full"),
  });
  return { asked, audit, grants };
}

async function openTab(tabId = TAB): Promise<void> {
  setTerminalEmitter((event, payload) => {
    if (event === "data" && "chunk" in payload) outputs.set(payload.tabId, (outputs.get(payload.tabId) ?? "") + payload.chunk);
  });
  const result = await spawnTerminal({ tabId, cols: 160, rows: 40, ownerWindowId: null });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

// Type `curl` into the tab and wait for its exit status line.
async function curlInTab(marker: string, tabId = TAB, timeoutMs = 60_000): Promise<{ status: number; text: string }> {
  const output = (): string => outputs.get(tabId) ?? "";
  const start = output().length;
  writeTerminal(tabId, `${CURL} -fsS -m 30 https://${HOST}/ ; echo "${marker}=$?"\r`);
  const pattern = new RegExp(`${marker}=(\\d+)`, "u");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The echoed command line holds `${marker}=$?`; only the shell's own output carries a number after the `=`.
    const match = pattern.exec(output().slice(start));
    if (match !== null) return { status: Number(match[1]), text: output().slice(start) };
    if (Date.now() > deadline) throw new Error(`no ${marker} line in the tab's output:\n${output().slice(start).slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const nativePlatform = process.platform === "darwin" || process.platform === "linux";

describe.runIf(nativePlatform)("workspace terminal egress banner (native, design F)", () => {
  it("can reach the destination at all without the sandbox (the cases' precondition)", async (context) => {
    if (!(await sandboxCasesRun())) context.skip("ASRT cannot initialize (sandbox dependencies missing)");
    const ok = await hostReachable();
    if (!ok && !sandboxCasesRequired()) context.skip(networkUnreachable());
    expect(ok, networkUnreachable()).toBe(true);
  });

  it("Allow once lets that one curl through; the next curl asks again", async (context) => {
    await requireNativeCase(context);
    const answers: EgressApprovalAnswer[] = [{ allow: true, scope: "once" }, { allow: false, reason: "denied by the user" }];
    const harness = await startSandbox(async () => answers.shift() ?? { allow: false, reason: "no more answers" });
    await openTab();
    const first = await curlInTab("ONCE_FIRST");
    expect(first.status, first.text).toBe(0);
    expect(first.text).toContain(BODY);
    const second = await curlInTab("ONCE_SECOND");
    expect(second.status, second.text).not.toBe(0);
    expect(harness.asked).toHaveLength(2);
    expect(harness.audit.map((row) => [row.decision, row.basis, row.scope])).toEqual([
      ["allow", "prompt", "once"],
      ["deny", "prompt", null],
    ]);
    expect(harness.grants.listTab()).toEqual([]);
  });

  it("This tab covers only its tab, and not a new shell in the same tab after exit", async (context) => {
    await requireNativeCase(context);
    const harness = await startSandbox(async () => ({ allow: true, scope: "tab" }));
    const askedTabs = (): Array<string | undefined> => harness.asked.map((request) => (request.origin === "terminal" ? request.tabId : undefined));
    try {
      await openTab(TAB);
      await openTab(OTHER_TAB);
      expect((await curlInTab("ISO_1", TAB)).status).toBe(0);
      expect((await curlInTab("ISO_2", TAB)).status).toBe(0);
      expect(askedTabs()).toEqual([TAB]);
      expect((await curlInTab("ISO_3", OTHER_TAB)).status).toBe(0);
      expect(askedTabs()).toEqual([TAB, OTHER_TAB]);
      // `exit` ends the tab's shell and its grants; the respawned shell (same tab id) is a new invocation and is asked again.
      writeTerminal(TAB, "exit\r");
      await expect.poll(() => harness.grants.listTab().map((grant) => grant.tabId), { timeout: 15_000 }).toEqual([OTHER_TAB]);
      await expect.poll(async () => (await spawnTerminal({ tabId: TAB, cols: 160, rows: 40, ownerWindowId: null })).ok, { timeout: 15_000 }).toBe(true);
      expect((await curlInTab("ISO_4", TAB)).status).toBe(0);
      expect(askedTabs()).toEqual([TAB, OTHER_TAB, TAB]);
    } finally {
      killTerminal(OTHER_TAB);
    }
  });

  it("asks the tab's banner, then curl succeeds after This tab, which covers the next curl; closing the tab drops it", async (context) => {
    await requireNativeCase(context);
    const harness = await startSandbox(async () => ({ allow: true, scope: "tab" }));
    await openTab();
    const first = await curlInTab("ALLOWED_FIRST");
    expect(first.status, first.text).toBe(0);
    expect(first.text).toContain(BODY);
    expect(harness.asked).toHaveLength(1);
    expect(harness.asked[0]).toMatchObject({
      origin: "terminal",
      tabId: TAB,
      destination: { host: HOST, port: PORT },
      network: "public",
      scopes: ["once", "tab", "always"],
    });
    expect(harness.grants.listTab()).toEqual([
      { scope: "tab", tabId: TAB, host: HOST, port: PORT, network: "public", grantedAt: expect.any(String) },
    ]);
    const second = await curlInTab("ALLOWED_SECOND");
    expect(second.status, second.text).toBe(0);
    expect(second.text).toContain(BODY);
    expect(harness.asked).toHaveLength(1);
    expect(harness.audit.map((row) => [row.invocation, row.decision, row.basis, row.scope])).toEqual([
      [{ kind: "terminal", tabId: TAB }, "allow", "prompt", "tab"],
      [{ kind: "terminal", tabId: TAB }, "allow", "grant", "tab"],
    ]);
    killTerminal(TAB);
    await expect.poll(() => harness.grants.listTab(), { timeout: 10_000 }).toEqual([]);
  });

  it("curl fails when the banner is denied", async (context) => {
    await requireNativeCase(context);
    const harness = await startSandbox(async () => ({ allow: false, reason: "denied by the user" }));
    await openTab();
    const result = await curlInTab("DENIED");
    expect(result.status, result.text).not.toBe(0);
    expect(result.text).not.toContain(BODY);
    expect(harness.asked).toHaveLength(1);
    expect(harness.audit.at(-1)).toMatchObject({
      invocation: { kind: "terminal", tabId: TAB }, decision: "deny", basis: "prompt", reason: "denied by the user",
    });
  });

  it("curl fails when nobody answers before the banner's deadline", async (context) => {
    await requireNativeCase(context);
    // Never answers on its own: only the deadline (or the tab closing) ends it.
    const harness = await startSandbox((request) => new Promise((resolve) => {
      request.abortSignal?.addEventListener("abort", () => resolve({ allow: false, reason: "network approval answer was rejected" }), { once: true });
    }), 3_000);
    await openTab();
    const result = await curlInTab("TIMED_OUT");
    expect(result.status, result.text).not.toBe(0);
    expect(result.text).not.toContain(BODY);
    expect(harness.asked).toHaveLength(1);
    expect(harness.audit.at(-1)).toMatchObject({
      invocation: { kind: "terminal", tabId: TAB }, decision: "deny", basis: "prompt", reason: EGRESS_DENY_REASONS.terminalTimeout,
    });
  });
});
