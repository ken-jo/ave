import { killTerminal } from "../../../__tests__/support/terminal-agent-fixture.js";
// Exercise the real proxy, grant store, terminal spawn, and CONNECT traffic. A public address is routed to a local fixture by the trusted upstream;
// the sandbox still enforces its normal listener, identity, destination-class, and approval checks.
import { afterEach, beforeEach, describe, expect, it, type TestContext } from "vitest";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { shellQuote } from "../../../lib/shell-resolver.js";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { SandboxEgressDecisionAuditEntry, SandboxEgressDenyAuditEntry, SandboxEgressFailureAuditEntry } from "../../../audit/sandbox-audit.js";
import { initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox, subscribeAsrtViolations } from "../../../permissions/asrt-sandbox.js";
import {
  EGRESS_DENY_REASONS,
  type EgressApprovalAnswer,
  type EgressApprovalRequest,
} from "../../../permissions/egress-ask.js";
import { createEgressAskCallback } from "../../../__tests__/support/egress-permission.js";
import { startEgressDenyMonitor } from "../../../permissions/egress-deny-monitor.js";
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
import { requireSandboxCases, sandboxCasesRequired } from "../../../plugins/isolation/__tests__/sandbox-cases.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import {
  __resetTerminalsForTest,
  _setTerminalInspectionForTest,
} from "../pty-manager.js";
import { spawnTerminal, writeTerminal } from "../../../__tests__/support/terminal-agent-fixture.js";
import { setDestinationResolverForTesting } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js";

const CURL = "/usr/bin/curl";
const HOST = "terminal-egress.example.test";
const ADDRESS = "8.8.8.8";
const PORT = 443;
const TAB = "terminal:0e9a5c11-1";
const OTHER_TAB = "terminal:0e9a5c11-2";
const BODY = "terminal egress fixture response";

let dir: string | undefined;
// Each tab's output since the test began.
const outputs = new Map<string, string>();
let stopMonitor: (() => void) | undefined;
let proxyAudit: (SandboxEgressDecisionAuditEntry | SandboxEgressDenyAuditEntry | SandboxEgressFailureAuditEntry)[] = [];
let callbackAudit: SandboxEgressDecisionAuditEntry[] = [];
let stopReleaseListener: (() => void) | undefined;
let destination: Awaited<ReturnType<typeof startDestination>> | undefined;

async function startDestination(root: string) {
  const sockets = new Set<net.Socket>();
  const connects: string[] = [];
  const requests: string[] = [];
  const certificate = join(root, "destination.crt");
  const key = join(root, "destination.key");
  const config = join(root, "destination.cnf");
  writeFileSync(config, `[req]\ndistinguished_name=subject\n[subject]\n[fixture]\nsubjectAltName=DNS:${HOST}\nbasicConstraints=critical,CA:TRUE\nkeyUsage=digitalSignature,keyEncipherment,keyCertSign\n`);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${HOST}`,
    "-config", config, "-extensions", "fixture", "-keyout", key, "-out", certificate,
  ], { stdio: "ignore" });
  const origin = https.createServer({ key: readFileSync(key), cert: readFileSync(certificate) }, (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(200, { "Content-Length": Buffer.byteLength(BODY), Connection: "close" });
    response.end(BODY);
  });
  origin.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as net.AddressInfo).port;
  let connectMode: "tunnel" | "stall" | "upstream-deny" | "upstream-gateway" | "upstream-timeout" = "tunnel";
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => { socket.destroy(); });
    let buffered = "";
    const onHead = (chunk: Buffer) => {
      buffered += chunk.toString("latin1");
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buffered.slice(0, end);
      connects.push(head.split("\r\n")[0]!);
      socket.off("data", onHead);
      if (connects.at(-1) !== `CONNECT ${ADDRESS}:${PORT} HTTP/1.1`) {
        socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (connectMode === "stall") return;
      if (connectMode.startsWith("upstream-")) {
        const status = connectMode === "upstream-deny" ? "403 Forbidden" : connectMode === "upstream-gateway" ? "502 Bad Gateway" : "504 Gateway Timeout";
        socket.end(`HTTP/1.1 ${status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        return;
      }
      const upstream = net.connect(originPort, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const remaining = buffered.slice(end + 4);
        if (remaining) upstream.write(Buffer.from(remaining, "latin1"));
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream);
      upstream.once("close", () => { sockets.delete(upstream); socket.destroy(); });
      upstream.on("error", () => socket.destroy());
      socket.once("close", () => upstream.destroy());
    };
    socket.on("data", onHead);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  return {
    proxyUrl: `http://127.0.0.1:${address.port}`, certificate, connects, requests,
    setConnectMode: (mode: typeof connectMode) => { connectMode = mode; },
    stopAccepting: () => new Promise<void>((resolve) => server.close(() => resolve())),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    },
  };
}

async function requireNativeCase(context: TestContext): Promise<void> {
  await requireSandboxCases(context);
  if (!existsSync(CURL)) {
    if (sandboxCasesRequired()) throw new Error(`AVE_REQUIRE_SANDBOX_CASES=1 but ${CURL} is missing`);
    context.skip(`${CURL} is missing`);
  }
}

beforeEach(() => {
  outputs.clear();
  // The process-wide store retains its tail across resets; this monitor starts with this case.
  SandboxManager.getSandboxViolationStore().clear();
});

afterEach(async () => {
  setDestinationResolverForTesting(undefined);
  SandboxManager.setParentProxyRouter(undefined);
  killTerminal(TAB);
  __resetTerminalsForTest();
  _setTerminalInspectionForTest(() => {});
  stopMonitor?.();
  stopMonitor = undefined;
  stopReleaseListener?.();
  stopReleaseListener = undefined;
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
  await destination?.close();
  destination = undefined;
  setShellSandboxRequestedAtBoot(false);
  __resetActiveSandboxCapabilityForTest();
  if (dir !== undefined) await cleanupTmpDir(dir);
  dir = undefined;
});

interface Harness {
  readonly asked: EgressApprovalRequest[];
  readonly audit: SandboxEgressDecisionAuditEntry[];
  readonly proxyAudit: (SandboxEgressDecisionAuditEntry | SandboxEgressDenyAuditEntry | SandboxEgressFailureAuditEntry)[];
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
  callbackAudit = audit;
  proxyAudit = [];
  stopMonitor = await startEgressDenyMonitor({
    subscribe: subscribeAsrtViolations,
    emit: async (entry) => { proxyAudit.push(entry); },
    capability: () => ({ kind: "asrt", confidence: "verified" }),
  });
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
  destination = await startDestination(dir);
  setDestinationResolverForTesting(async (name) => {
    if (name !== HOST) throw new Error("Unexpected destination resolution");
    return [{ address: ADDRESS, family: 4 }];
  });
  await initializeAsrtSandbox({
    allowedDomains: [], strictAllowlist: false,
    upstreamProxy: { http: destination.proxyUrl, https: destination.proxyUrl },
  }, callback);
  // What boot publishes once ASRT is up (sandbox-init.ts): the terminal only opens on a host that contains filesystem and process.
  setActiveSandboxCapability({
    kind: "asrt",
    confidence: "verified",
    platform: process.platform,
    reason: "ASRT active (terminal egress acceptance)",
    confines: sandboxConfinementForPlatform(process.platform, "full"),
  });
  return { asked, audit, proxyAudit, grants };
}

async function openTab(tabId = TAB): Promise<void> {
  _setTerminalInspectionForTest((event, payload) => {
    if (event === "data" && "chunk" in payload) outputs.set(payload.tabId, (outputs.get(payload.tabId) ?? "") + payload.chunk);
  });
  const result = await spawnTerminal({ tabId, cols: 160, rows: 40, ownerWindowId: null });
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
}

// Type `curl` into the tab and wait for its exit status line.
async function curlInTab(marker: string, tabId = TAB, timeoutMs = 60_000, host = HOST, requestTimeoutSeconds = 30): Promise<{ status: number; text: string }> {
  const output = (): string => outputs.get(tabId) ?? "";
  const start = output().length;
  if (!destination) throw new Error("Destination fixture is not running");
  writeTerminal(tabId, `${CURL} -fsS --cacert ${shellQuote(destination.certificate)} --dump-header - -m ${requestTimeoutSeconds} https://${host}:${PORT}/ ; echo "${marker}=$?"\r`);
  const pattern = new RegExp(`${marker}=(\\d+)`, "u");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    // The echoed command line holds `${marker}=$?`; only the shell's own output carries a number after the `=`.
    const match = pattern.exec(output().slice(start));
    if (match !== null) {
      const result = { status: Number(match[1]), text: output().slice(start) };
      console.log("terminal egress evidence", JSON.stringify({ marker, ...result, callbackAudit, proxyAudit }));
      return result;
    }
    if (Date.now() > deadline) throw new Error(`no ${marker} line in the tab's output:\n${output().slice(start).slice(-2000)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const nativePlatform = process.platform === "darwin" || process.platform === "linux";

describe.runIf(nativePlatform)("workspace terminal egress banner (native, design F)", () => {
  it("reports a DNS transport failure after Allow once", async (context) => {
    await requireNativeCase(context);
    const harness = await startSandbox(async () => ({ allow: true, scope: "once" }));
    await openTab();
    setDestinationResolverForTesting(async () => []);
    SandboxManager.setParentProxyRouter(async () => ({ routes: [{ kind: "direct" }] }));
    const result = await curlInTab("RESOLUTION_REFUSED", TAB, 60_000, "unresolved.example.test");
    expect(result.status, result.text).not.toBe(0);
    expect(result.text).toContain("502");
    expect(result.text).toContain("transport-dns");
    expect(result.text).toContain("destination name did not resolve");
    expect(harness.asked).toHaveLength(1);
    expect(harness.audit).toEqual([]);
    expect(harness.proxyAudit).toMatchObject([{ entryKind: "egress-failure", failure: { kind: "dns", httpStatus: 502 } }]);
  });

  it("reports a refused connection after Allow once as a transport failure", async (context) => {
    await requireNativeCase(context);
    const harness = await startSandbox(async () => ({ allow: true, scope: "once" }));
    await destination!.stopAccepting();
    await openTab();
    const result = await curlInTab("CONNECT_FAILED");
    expect(result.status, result.text).not.toBe(0);
    expect(result.text).toContain("502");
    expect(result.text).toContain("transport-connect");
    expect(harness.audit).toMatchObject([{ decision: "allow", basis: "prompt", scope: "once" }]);
    expect(harness.proxyAudit).toMatchObject([{ entryKind: "egress-failure", failure: { kind: "connect", httpStatus: 502 } }]);
    expect(destination?.requests).toHaveLength(0);
  });

  it("reports a stalled CONNECT handshake after Allow once as a gateway timeout", async (context) => {
    await requireNativeCase(context);
    const harness = await startSandbox(async () => ({ allow: true, scope: "once" }));
    destination!.setConnectMode("stall");
    await openTab();
    // The client must outwait the proxy's handshake timer so the proxy supplies the failure.
    const result = await curlInTab("CONNECT_TIMED_OUT", TAB, 60_000, HOST, 40);
    expect(result.status, result.text).not.toBe(0);
    expect(result.text).toContain("504");
    expect(result.text).toContain("transport-timeout");
    expect(harness.audit).toMatchObject([{ decision: "allow", basis: "prompt", scope: "once" }]);
    expect(harness.proxyAudit).toMatchObject([{ entryKind: "egress-failure", failure: { kind: "timeout", httpStatus: 504 } }]);
    expect(destination?.requests).toHaveLength(0);
  });

  it("keeps an explicit policy denial as 403 with a denial audit", async (context) => {
    await requireNativeCase(context);
    const harness = await startSandbox(async () => ({ allow: false, reason: "denied by the user" }));
    await openTab();
    const result = await curlInTab("POLICY_DENIED");
    expect(result.status, result.text).not.toBe(0);
    expect(result.text).toContain("403");
    expect(result.text).toContain("blocked-by-allowlist");
    expect(harness.audit).toMatchObject([{ decision: "deny", basis: "prompt" }]);
    expect(harness.proxyAudit).toMatchObject([{ entryKind: "egress-deny", deny: { reason: "denied by the user" } }]);
    expect(destination?.connects).toHaveLength(0);
    expect(destination?.requests).toHaveLength(0);
  });

  it("attributes an upstream CONNECT refusal in response headers and the monitor audit", async (context) => {
    await requireNativeCase(context);
    const harness = await startSandbox(async () => ({ allow: true, scope: "once" }));
    destination!.setConnectMode("upstream-deny");
    await openTab();
    const result = await curlInTab("UPSTREAM_DENIED");
    expect(result.status, result.text).not.toBe(0);
    expect(result.text).toContain("403");
    expect(result.text).toContain("upstream proxy refused the connection (HTTP 403)");
    expect(harness.audit).toMatchObject([{ decision: "allow", basis: "prompt" }]);
    expect(harness.proxyAudit).toMatchObject([
      { entryKind: "egress-deny", deny: { reason: "upstream proxy refused the connection (HTTP 403)" } },
      { entryKind: "egress-decision", decision: "deny", basis: "sandbox", reason: "upstream proxy refused the connection (HTTP 403)" },
    ]);
    expect(destination?.requests).toHaveLength(0);
  });

  it.for([502, 504] as const)("keeps an upstream %s transport failure out of denial audits", async (status, context) => {
    await requireNativeCase(context);
    const harness = await startSandbox(async () => ({ allow: true, scope: "once" }));
    destination!.setConnectMode(status === 502 ? "upstream-gateway" : "upstream-timeout");
    await openTab();
    const result = await curlInTab("UPSTREAM_FAILURE");
    expect(result.status, result.text).not.toBe(0);
    expect(result.text).toContain(String(status));
    expect(result.text).toContain(`upstream proxy returned HTTP ${status}`);
    expect(harness.proxyAudit).toMatchObject([{ entryKind: "egress-failure", failure: { kind: status === 504 ? "timeout" : "connect", httpStatus: status } }]);
    expect(destination?.requests).toHaveLength(0);
  });

  it("pins a resolved public destination to the local CONNECT and HTTPS fixtures", async (context) => {
    await requireNativeCase(context);
    const harness = await startSandbox(async () => ({ allow: true, scope: "once" }));
    const resolved: string[] = [];
    setDestinationResolverForTesting(async (name) => {
      resolved.push(name);
      if (name !== HOST) throw new Error("Unexpected destination resolution");
      return [{ address: ADDRESS, family: 4 }];
    });
    await openTab();
    const result = await curlInTab("FIXTURE_ROUTE");
    expect(result.status, JSON.stringify({ ...result, audit: harness.audit })).toBe(0);
    expect(result.text).toContain(BODY);
    expect(resolved).toEqual([HOST]);
    expect(destination?.connects).toEqual([`CONNECT ${ADDRESS}:${PORT} HTTP/1.1`]);
    expect(destination?.requests).toHaveLength(1);
    expect(harness.audit).toMatchObject([{ decision: "allow", basis: "prompt", scope: "once" }]);
  });

  it("Allow once lets that one curl through; the next curl asks again", async (context) => {
    await requireNativeCase(context);
    const answers: EgressApprovalAnswer[] = [{ allow: true, scope: "once" }, { allow: false, reason: "denied by the user" }];
    const harness = await startSandbox(async () => answers.shift() ?? { allow: false, reason: "no more answers" });
    await openTab();
    const first = await curlInTab("ONCE_FIRST");
    expect(first.status, JSON.stringify({ ...first, audit: harness.audit })).toBe(0);
    expect(first.text).toContain(BODY);
    const second = await curlInTab("ONCE_SECOND");
    expect(second.status, second.text).not.toBe(0);
    expect(destination?.requests).toHaveLength(1);
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
