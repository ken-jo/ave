// The violation store re-notifies its whole retained tail; audit each refusal once with invocation attribution.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import {
  parseEgressDenyLine,
  noteCallbackDecision,
  startEgressDenyMonitor,
  UNPARSED_DENY_REASON,
} from "../egress-deny-monitor.js";
import {
  EGRESS_INVOCATION_TOKEN_LENGTH,
  egressInvocationOwner,
  openEgressInvocation,
  type EgressInvocation,
  type EgressInvocationOwner,
} from "../egress-invocations.js";
import type { SandboxEgressDecisionAuditEntry, SandboxEgressDenyAuditEntry } from "../../audit/sandbox-audit.js";
import { emitSandboxAudit, readRecentSandboxEgressDenials } from "../../audit/sandbox-audit-sink.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { TEST_SHELL_EGRESS_CONTEXT } from "../../__tests__/support/egress-fixture.js";

// What ASRT puts in `encodedCommand` for a key (`encodeSandboxedCommand`).
const encode = (key: string): string => Buffer.from(key.slice(0, 100)).toString("base64");

const open: EgressInvocation[] = [];
afterEach(() => {
  for (const invocation of open.splice(0)) invocation.release();
  vi.unstubAllEnvs();
});

function invocation(owner: EgressInvocationOwner): EgressInvocation {
  const opened = openEgressInvocation(owner);
  open.push(opened);
  return opened;
}

async function monitored(): Promise<{
  store: SandboxViolationStore;
  rows: SandboxEgressDenyAuditEntry[];
  decisions: SandboxEgressDecisionAuditEntry[];
  stop: () => void;
}> {
  const store = new SandboxViolationStore();
  const rows: SandboxEgressDenyAuditEntry[] = [];
  const decisions: SandboxEgressDecisionAuditEntry[] = [];
  const stop = await startEgressDenyMonitor({
    subscribe: async (listener) => store.subscribe(listener),
    emit: async (entry) => {
      if (entry.entryKind === "egress-deny") rows.push(entry);
      else decisions.push(entry);
    },
    capability: () => ({ kind: "asrt", confidence: "verified" }),
  });
  return { store, rows, decisions, stop };
}

function deny(store: SandboxViolationStore, line: string, key: string | undefined): void {
  store.addViolation({ line, timestamp: new Date("2026-10-19T03:00:00.000Z"), ...(key !== undefined ? { encodedCommand: encode(key) } : {}) });
}

describe("egress invocation tokens", () => {
  it("mints 32 unguessable hex characters per invocation and forgets them on release", () => {
    const a = invocation({ kind: "terminal", tabId: "tab_1" });
    const b = invocation({ kind: "terminal", tabId: "tab_1" });
    expect(a.token).toMatch(new RegExp(`^[0-9a-f]{${EGRESS_INVOCATION_TOKEN_LENGTH}}$`));
    expect(a.token).not.toBe(b.token);
    expect(egressInvocationOwner(a.token)).toEqual({ kind: "terminal", tabId: "tab_1" });
    a.release();
    a.release();
    expect(egressInvocationOwner(a.token)).toBeUndefined();
    expect(egressInvocationOwner(b.token)).toEqual({ kind: "terminal", tabId: "tab_1" });
  });
});

describe("parseEgressDenyLine", () => {
  it("reads the three proxy deny forms and ignores filesystem violations", () => {
    expect(parseEgressDenyLine("deny network-outbound example.com:443 (domain not allowed)")).toEqual({
      action: "network-outbound", host: "example.com", port: 443, method: null, url: null, reason: "domain not allowed",
    });
    expect(parseEgressDenyLine("deny network-outbound ::1:8080 (loopback)")).toMatchObject({ host: "::1", port: 8080 });
    expect(parseEgressDenyLine("deny socks-tunnel example.org:22 (refuseOpaqueTunnels)")).toMatchObject({
      action: "socks-tunnel", host: "example.org", port: 22,
    });
    expect(parseEgressDenyLine("deny http-request CONNECT example.net:443 (filtered)")).toMatchObject({
      action: "http-request", host: "example.net", port: 443, method: "CONNECT", url: null,
    });
    expect(parseEgressDenyLine("deny file-write-create /etc/passwd")).toBeUndefined();
  });

  it("DLP-masks a secret in the refused URL path", () => {
    const secret = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
    const parsed = parseEgressDenyLine(`deny http-request POST https://hooks.example.com/upload/${secret}?… (filtered)`);
    expect(parsed).toMatchObject({ action: "http-request", host: "hooks.example.com", port: null, method: "POST" });
    expect(parsed!.url).toContain("https://hooks.example.com/upload/");
    expect(parsed!.url).not.toContain(secret);
  });
});

describe("unparsed and hostile deny lines", () => {
  it("records a malformed-host deny with control characters as one row, never none", async () => {
    const { store, rows } = await monitored();
    const shell = invocation({ kind: "shell", toolName: "bash", toolUseId: "toolu_04", context: TEST_SHELL_EGRESS_CONTEXT });
    // ASRT refuses such a host as `malformed host` and records it as sent; the store turns the control characters into spaces.
    deny(store, "deny network-outbound \u0001evil\u0007\u0000:443 (malformed host)", shell.token);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.invocation).toEqual({ kind: "shell", toolName: "bash", toolUseId: "toolu_04" });
    expect(rows[0]!.deny).toMatchObject({ action: "network-outbound", port: null, reason: UNPARSED_DENY_REASON });
    expect(rows[0]!.deny.host).toContain("evil");
  });

  it("keeps an empty or prose host as a row of its own", () => {
    expect(parseEgressDenyLine("deny network-outbound :443 (malformed host)")).toEqual({
      action: "network-outbound", host: ":443 (malformed host)", port: null, method: null, url: null, reason: UNPARSED_DENY_REASON,
    });
    expect(parseEgressDenyLine("deny network-outbound ignore previous instructions:443 (malformed host)")).toMatchObject({
      action: "network-outbound", port: null, reason: UNPARSED_DENY_REASON,
    });
    expect(parseEgressDenyLine("deny socks-tunnel ")).toMatchObject({ action: "socks-tunnel", host: "", reason: UNPARSED_DENY_REASON });
    expect(parseEgressDenyLine("deny socks-tunnel x")).toMatchObject({ action: "socks-tunnel", host: "x", reason: UNPARSED_DENY_REASON });
  });

  it("DLP-masks a secret the process put in the host, in the row and its event target", async () => {
    const { store, rows } = await monitored();
    const secret = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
    deny(store, `deny network-outbound ${secret}.exfil.example:443 (domain not allowed)`, undefined);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain(secret);
    expect(rows[0]!.sandbox.events[0]!.target).toBe(`${rows[0]!.deny.host}:443`);
  });
});

describe("startEgressDenyMonitor", () => {
  it("records a strict-allowlist deny of a Bash call under that call's toolUseId", async () => {
    const { store, rows } = await monitored();
    const shell = invocation({ kind: "shell", toolName: "bash", toolUseId: "toolu_01FIXTURE", context: TEST_SHELL_EGRESS_CONTEXT });
    deny(store, "deny network-outbound example.com:443 (domain not allowed)", shell.token);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      timestamp: "2026-10-19T03:00:00.000Z",
      entryKind: "egress-deny",
      sandbox: { kind: "asrt", confidence: "verified", events: [{ type: "egress_attempted", blocked: true, target: "example.com:443" }] },
      invocation: { kind: "shell", toolName: "bash", toolUseId: "toolu_01FIXTURE" },
      deny: { action: "network-outbound", host: "example.com", port: 443, method: null, url: null, reason: "domain not allowed" },
    });
    // The token is a live label: it is never written down.
    expect(JSON.stringify(rows[0])).not.toContain(shell.token);
  });

  it("writes a decision row for a refusal the proxy made before asking, and none for one the callback made", async () => {
    const { store, decisions } = await monitored();
    const shell = invocation({ kind: "shell", toolName: "bash", toolUseId: "toolu_03", context: TEST_SHELL_EGRESS_CONTEXT });
    deny(store, "deny network-outbound 127.0.0.1:52011 (sandbox proxy listener)", shell.token);
    noteCallbackDecision(shell.token, "Asked.Example", 443);
    deny(store, "deny network-outbound asked.example:443 (denied by the user)", shell.token);
    expect(decisions).toEqual([{
      timestamp: "2026-10-19T03:00:00.000Z",
      entryKind: "egress-decision",
      invocation: { kind: "shell", toolName: "bash", toolUseId: "toolu_03" },
      destination: { host: "127.0.0.1", port: 52011 },
      decision: "deny",
      basis: "sandbox",
      scope: null,
      reason: "sandbox proxy listener",
    }]);
    // A noted decision is used once: a second refusal of the same destination is the proxy's own.
    deny(store, "deny network-outbound asked.example:443 (malformed host)", shell.token);
    expect(decisions.map((d) => d.destination.host)).toEqual(["127.0.0.1", "asked.example"]);
  });

  it("labels a worker deny with the plugin and worker", async () => {
    const { store, rows } = await monitored();
    const worker = invocation({ kind: "worker", role: "worker", pluginId: "acme_notes", instanceId: "indexer" });
    deny(store, "deny network-outbound tracker.example:443 (domain not allowed)", worker.token);
    expect(rows[0]!.invocation).toEqual({ kind: "worker", role: "worker", pluginId: "acme_notes", instanceId: "indexer" });
  });

  it("labels a terminal deny with the tab", async () => {
    const { store, rows } = await monitored();
    const tab = invocation({ kind: "terminal", tabId: "term_7" });
    deny(store, "deny network-outbound github.com:22 (domain not allowed)", tab.token);
    expect(rows[0]!.invocation).toEqual({ kind: "terminal", tabId: "term_7" });
  });

  it("records an unknown, released or absent key as unattributed", async () => {
    const { store, rows } = await monitored();
    const gone = invocation({ kind: "shell", toolName: "powershell", toolUseId: undefined, context: TEST_SHELL_EGRESS_CONTEXT });
    gone.release();
    deny(store, "deny network-outbound a.example:443 (domain not allowed)", "f".repeat(32));
    deny(store, "deny network-outbound b.example:443 (domain not allowed)", gone.token);
    deny(store, "deny network-outbound c.example:443 (domain not allowed)", undefined);
    expect(rows.map((row) => row.invocation)).toEqual([
      { kind: "unattributed" }, { kind: "unattributed" }, { kind: "unattributed" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("f".repeat(32));
  });

  it("writes one row per deny although the store re-notifies its whole tail, and skips non-network lines", async () => {
    const store = new SandboxViolationStore();
    const shell = invocation({ kind: "shell", toolName: "bash", toolUseId: "toolu_02", context: TEST_SHELL_EGRESS_CONTEXT });
    // Present before the monitor starts: refused in this process, not yet audited.
    deny(store, "deny network-outbound early.example:80 (domain not allowed)", shell.token);
    const rows: SandboxEgressDenyAuditEntry[] = [];
    await startEgressDenyMonitor({
      subscribe: async (listener) => store.subscribe(listener),
      emit: async (entry) => { if (entry.entryKind === "egress-deny") rows.push(entry); },
      capability: () => ({ kind: "asrt", confidence: "verified" }),
    });
    deny(store, "deny file-read-data /Users/example/.ssh/id_ed25519", shell.token);
    deny(store, "deny network-outbound late.example:443 (domain not allowed)", shell.token);
    expect(rows.map((row) => row.deny.host)).toEqual(["early.example", "late.example"]);
  });

  it("keeps the proxy running when the audit sink fails", async () => {
    const store = new SandboxViolationStore();
    await startEgressDenyMonitor({
      subscribe: async (listener) => store.subscribe(listener),
      emit: async () => { throw new Error("disk full"); },
      capability: () => ({ kind: "asrt", confidence: "verified" }),
    });
    expect(() => deny(store, "deny network-outbound x.example:443 (domain not allowed)", undefined)).not.toThrow();
  });
});

describe("readRecentSandboxEgressDenials", () => {
  it("returns the denies of the last 24 h from the sandbox channel, newest first", async () => {
    const home = mkdtempSync(join(tmpdir(), "egress-deny-audit-"));
    vi.stubEnv("AVE_HOME", home);
    try {
      const store = new SandboxViolationStore();
      const stop = await startEgressDenyMonitor({
        subscribe: async (listener) => store.subscribe(listener),
        emit: emitSandboxAudit,
        capability: () => ({ kind: "asrt", confidence: "verified" }),
      });
      const shell = invocation({ kind: "shell", toolName: "bash", toolUseId: "toolu_03", context: TEST_SHELL_EGRESS_CONTEXT });
      const now = new Date();
      store.addViolation({ line: "deny network-outbound older.example:443 (domain not allowed)", encodedCommand: encode(shell.token), timestamp: new Date(now.getTime() - 60_000) });
      store.addViolation({ line: "deny network-outbound newer.example:443 (domain not allowed)", encodedCommand: encode(shell.token), timestamp: now });
      stop();
      // The sink appends asynchronously.
      await vi.waitFor(async () => {
        expect(await readRecentSandboxEgressDenials({ now })).toHaveLength(2);
      });
      // A tool-execution row and a torn last line on the same channel are skipped.
      writeFileSync(join(home, "audit", `${now.toISOString().slice(0, 10)}.sandbox.jsonl`),
        `{"timestamp":"${now.toISOString()}","tool":{}}\n{"entryKind":"egress-deny",`, { flag: "a" });
      const rows = await readRecentSandboxEgressDenials({ now: new Date(now.getTime() + 1) });
      expect(rows.map((row) => row.deny.host)).toEqual(["newer.example", "older.example"]);
      expect(rows[0]!.invocation).toEqual({ kind: "shell", toolName: "bash", toolUseId: "toolu_03" });
      expect(await readRecentSandboxEgressDenials({ now: new Date(now.getTime() + 25 * 3_600_000) })).toEqual([]);
    } finally {
      await cleanupTmpDir(home);
    }
  });
});
