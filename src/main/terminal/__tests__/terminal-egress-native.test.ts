/**
 * A workspace terminal tab's egress ask, EXECUTED (proxy-egress design F, PR 5
 * acceptance): the real ASRT proxy in boot's network shape (non-strict,
 * nothing pre-allowed), the real ask callback and grant store, the real
 * `spawnTerminal` (node-pty, the terminal wrap, its per-invocation listener),
 * and `curl` typed into the tab's shell.
 *
 *   - Allow: the tab's banner is asked (origin terminal, its tab id, This tab
 *     offered), curl gets the page, and This tab covers the next curl without
 *     another banner. Closing the tab drops the grant.
 *   - Deny: curl fails.
 *   - No answer: the banner's deadline denies and curl fails.
 *
 * The destination is a real public HTTPS host (example.com, through a CONNECT
 * tunnel), so the banner offers every scope. A server on this machine cannot
 * stand in for it: a loopback literal skips the proxy (ASRT's NO_PROXY) and
 * is refused by the sandbox, and a name resolving to this host is refused by
 * the proxy's resolved-address guard before any ask. The local and
 * unverified classes are covered by the unit tests (egress-ask.test.ts).
 * Without a route to the host the cases are skipped with that reason.
 */
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
  spawnTerminal,
  writeTerminal,
} from "../pty-manager.js";

const CURL = "/usr/bin/curl";
const HOST = "example.com";
const PORT = 443;
const TAB = "terminal:0e9a5c11-1";
const BODY = "Example Domain";

let dir: string | undefined;
let output = "";
let stopReleaseListener: (() => void) | undefined;

let reachable: boolean | undefined;

async function requireNativeCase(context: TestContext): Promise<void> {
  if (!(await sandboxCasesRun())) context.skip("ASRT cannot initialize (sandbox dependencies missing)");
  if (!existsSync(CURL)) {
    if (sandboxCasesRequired()) throw new Error(`AVE_REQUIRE_SANDBOX_CASES=1 but ${CURL} is missing`);
    context.skip(`${CURL} is missing`);
  }
  // Control: unconfined, this machine reaches the host at all.
  reachable ??= await fetch(`https://${HOST}/`, { signal: AbortSignal.timeout(10_000) }).then((res) => res.ok, () => false);
  if (!reachable) context.skip(`https://${HOST}/ is not reachable from this machine`);
}

beforeEach(() => {
  output = "";
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

/**
 * Boot's network shape with this test's answers in place of the window: the
 * same callback the app installs, over a grant store in a temp directory.
 */
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
  // What boot publishes once ASRT is up (sandbox-init.ts): the terminal only
  // opens on a host that contains filesystem and process.
  setActiveSandboxCapability({
    kind: "asrt",
    confidence: "verified",
    platform: process.platform,
    reason: "ASRT active (terminal egress acceptance)",
    confines: sandboxConfinementForPlatform(process.platform, "full"),
  });
  return { asked, audit, grants };
}

async function openTab(): Promise<void> {
  setTerminalEmitter((event, payload) => {
    if (event === "data" && "chunk" in payload && payload.tabId === TAB) output += payload.chunk;
  });
  const result = await spawnTerminal({ tabId: TAB, cols: 160, rows: 40, ownerWindowId: null });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

/** Type `curl` into the tab and wait for its exit status line. */
async function curlInTab(marker: string, timeoutMs = 60_000): Promise<{ status: number; text: string }> {
  const start = output.length;
  writeTerminal(TAB, `${CURL} -fsS -m 30 https://${HOST}/ ; echo "${marker}=$?"\r`);
  const pattern = new RegExp(`${marker}=(\\d+)`, "u");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The echoed command line holds `${marker}=$?`; only the shell's own
    // output carries a number after the `=`.
    const match = pattern.exec(output.slice(start));
    if (match !== null) return { status: Number(match[1]), text: output.slice(start) };
    if (Date.now() > deadline) throw new Error(`no ${marker} line in the tab's output:\n${output.slice(start).slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const nativePlatform = process.platform === "darwin" || process.platform === "linux";

describe.runIf(nativePlatform)("workspace terminal egress banner (native, design F)", () => {
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
      scopes: ["once", "tab", "workspace", "always"],
    });
    expect(harness.grants.listTab()).toEqual([
      { scope: "tab", tabId: TAB, host: HOST, port: PORT, grantedAt: expect.any(String) },
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
