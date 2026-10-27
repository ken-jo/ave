import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxViolationStore } from "@anthropic-ai/sandbox-runtime";
import { ObservationDaemon } from "../../observation/daemon.js";
import { TerminalObservationAdapter } from "../../observation/terminal-adapter.js";
import { setAgentTerminalObservationSink } from "../../tools/agent-terminal-observation.js";
import type { TerminalObservationEvent } from "../../shared/agent-observation.js";
import { createEgressAskCallback } from "../egress-ask.js";
import { EgressGrantStore } from "../egress-grants.js";
import { egressInvocationOwner, openEgressInvocation, type EgressInvocation } from "../egress-invocations.js";
import { startEgressDenyMonitor } from "../egress-deny-monitor.js";

let directory: string;
let daemon: ObservationDaemon;
let adapter: TerminalObservationAdapter;
let token: EgressInvocation;
let events: TerminalObservationEvent[];
let stop: (() => void) | undefined;
const identity = { sessionId: "egress-session", turnId: "egress-turn", toolUseId: "egress-tool" };

beforeEach(() => {
  vi.useFakeTimers();
  directory = realpathSync(mkdtempSync(join(tmpdir(), "terminal-egress-observation-")));
  daemon = new ObservationDaemon();
  adapter = new TerminalObservationAdapter(daemon);
  events = [];
  adapter.registerView("egress-view", identity.sessionId, () => true, (batch) => {
    events.push(...batch);
    adapter.acknowledge("egress-view", batch.at(-1)!.seq);
  });
  setAgentTerminalObservationSink({ start: (owner, input) => adapter.start(owner, input),
    egress: (key, decision) => adapter.recordEgress(key, decision), releaseSessions: (ended) => adapter.releaseSessions(ended) });
  token = openEgressInvocation({ kind: "shell", toolName: "bash", toolUseId: identity.toolUseId,
    context: { sessionId: identity.sessionId, workspaceRoot: directory, approvalSurface: "interactive" } });
});
afterEach(() => {
  stop?.(); stop = undefined;
  token.release();
  setAgentTerminalObservationSink(undefined);
  daemon.dispose();
  rmSync(directory, { recursive: true, force: true });
  vi.useRealTimers();
});

function command() {
  const lease = adapter.start(identity, { kind: "shell", command: "fetch data", cwd: directory,
    sandbox: { mode: "isolated", detail: "filesystem/process confinement" } });
  lease.bindEgress(token.token);
  return lease;
}
function callback(decision: "allow" | "deny") {
  return createEgressAskCallback({ identityStrength: () => "kernel-channel", ownerOf: egressInvocationOwner,
    abortSignalOf: () => undefined, workerAllowedDomains: () => [],
    grants: new EgressGrantStore(join(directory, "grants.json")), networkRule: async () => ({ decision, scope: "session", pattern: "downloads.example" }),
    shellAskEnabled: () => true, requester: () => undefined, audit: () => {} });
}
function latestCommands() {
  const latest = events.findLast((event) => event.kind === "snapshot");
  return latest?.kind === "snapshot" ? latest.after.commands : [];
}

describe("terminal observation egress correlation", () => {
  it("keeps a refused untrusted port out of the internal decision contract", async () => {
    command();
    const result = await callback("deny")({ host: "downloads.example", port: 0 },
      { attributionKey: token.token, identity: "listener", phase: "name" });
    expect(result).not.toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(latestCommands()[0].decisions).toMatchObject([{ decision: "deny", port: null }]);
  });

  it.each(["allow", "deny"] as const)("attaches only the final %s decision to its exact admitted invocation", async (decision) => {
    const lease = command();
    const ask = callback(decision);
    const connection = { attributionKey: token.token, identity: "listener" as const };
    await ask({ host: "downloads.example", port: 443 }, { ...connection, phase: "name" });
    if (decision === "allow") {
      await vi.advanceTimersByTimeAsync(100);
      expect(latestCommands()[0].decisions).toEqual([]);
      await ask({ host: "downloads.example", port: 443 }, { ...connection, phase: "resolved", addresses: ["8.8.8.8"], resolution: "pinned" });
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(latestCommands()[0].decisions).toMatchObject([{ kind: "egress", decision, host: "downloads.example", port: 443, attribution: "command" }]);
    expect(JSON.stringify(events)).not.toContain(token.token);
    lease.revoke();
    await ask({ host: "later.example", port: 443 }, { ...connection, phase: "resolved", addresses: ["8.8.8.8"], resolution: "pinned" });
    await vi.advanceTimersByTimeAsync(100);
    expect(latestCommands()[0].decisions).toHaveLength(1);
  });

  it("ignores user and worker egress with no admitted command lease", async () => {
    const ask = callback("deny");
    await ask({ host: "private.example", port: 443 }, { attributionKey: token.token, identity: "listener", phase: "name" });
    await vi.advanceTimersByTimeAsync(100);
    expect(latestCommands()).toEqual([]);
    expect(JSON.stringify(events)).not.toContain("private.example");
  });

  it("attaches sandbox refusals once without importing audit or output into a transcript", async () => {
    command();
    const store = new SandboxViolationStore();
    stop = await startEgressDenyMonitor({ subscribe: async (listener) => store.subscribe(listener),
      emit: async () => {}, capability: () => ({ kind: "asrt", confidence: "verified" }) });
    store.addViolation({ line: "deny network-outbound denied.example:443 (blocked by sandbox)",
      timestamp: new Date(), encodedCommand: Buffer.from(token.token).toString("base64") });
    await vi.advanceTimersByTimeAsync(100);
    expect(latestCommands()[0].decisions).toMatchObject([{ decision: "deny", basis: "sandbox", host: "denied.example" }]);
    store.addViolation({ line: "deny file-write-create /protected", timestamp: new Date() });
    await vi.advanceTimersByTimeAsync(100);
    expect(latestCommands()[0].decisions).toHaveLength(1);
  });
});
