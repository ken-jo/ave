import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_OBSERVATION_LIMITS,
  type ObservationIdentity,
  type TerminalObservationEvent,
  type TerminalObservedCommand,
} from "../../shared/agent-observation.js";
import type { AgentTerminalEgressDecision, AgentTerminalObservationInput } from "../../tools/agent-terminal-observation.js";
import { ObservationDaemon } from "../daemon.js";
import { TerminalObservationAdapter } from "../terminal-adapter.js";

const IDENTITY: ObservationIdentity = { sessionId: "session-one", turnId: "turn-one", toolUseId: "tool-one" };
const COMMAND: AgentTerminalObservationInput = {
  kind: "shell", command: "printf ready", cwd: "/workspace/project",
  sandbox: { mode: "isolated", detail: "filesystem and process confinement" },
};
const TOKEN = "a".repeat(32);
const SECRET = `sk-${"abcdef0123456789".repeat(3)}`;
const DECISION: AgentTerminalEgressDecision = {
  host: "example.test", port: 443, decision: "deny", basis: "policy", scope: null, reason: "destination refused",
};
const daemons: ObservationDaemon[] = [];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.dispose();
  vi.useRealTimers();
});

function fixture(autoAcknowledge = true) {
  const daemon = new ObservationDaemon();
  daemons.push(daemon);
  const adapter = new TerminalObservationAdapter(daemon);
  const events: TerminalObservationEvent[] = [];
  const addView = (id = "terminal-view", sessionId = IDENTITY.sessionId, isCurrent = () => true): void => {
    adapter.registerView(id, sessionId, isCurrent, (batch) => {
      events.push(...batch);
      if (autoAcknowledge) adapter.acknowledge(id, batch.at(-1)!.seq);
    });
  };
  const commands = (sessionId = IDENTITY.sessionId): TerminalObservedCommand[] => {
    const event = events.findLast((entry) => entry.sessionId === sessionId && entry.kind === "snapshot");
    if (!event || event.kind !== "snapshot") throw new Error("Expected terminal observation snapshot.");
    return event.after.commands;
  };
  return { daemon, adapter, events, addView, commands };
}

async function flush(): Promise<void> { await vi.advanceTimersByTimeAsync(100); }

describe("terminal observation adapter", () => {
  it("preserves upstream omission even when the delivered suffix fits the local tail", async () => {
    const { adapter, addView, commands } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, { ...COMMAND, outputAvailability: "on-completion" });
    lease.write("short suffix\n", { truncated: true });
    lease.finish(0);
    await flush();
    expect(commands()[0]).toMatchObject({ outputTail: "short suffix\n", outputTruncated: true });
  });

  it("applies bounded carriage-return and backspace line rewrites before masking", async () => {
    const { adapter, addView, commands } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    lease.write("working 10%\rworking ");
    lease.write("20%\nwrong\b\b\b\b\bright\n");
    lease.finish(0);
    await flush();
    expect(commands()[0].outputTail).toBe("working 20%\nright\n");
  });

  it.each(["\x1bP", "\x1bX", "\x1b^", "\x1b_", "\x90", "\x98", "\x9e", "\x9f"])(
    "discards split ST-terminated control carriers started by %j including an embedded BEL", async (start) => {
      const { adapter, addView, commands } = fixture();
      addView();
      const lease = adapter.start(IDENTITY, COMMAND);
      lease.write(`visible${start}hidden-control\x07still-hidden`);
      lease.write("\x1b");
      lease.write("\\after\n");
      lease.finish(0);
      await flush();
      expect(commands()[0].outputTail).toBe("visibleafter\n");
    });

  it("accepts C1 ST and OSC BEL without retaining their control payloads", async () => {
    const { adapter, addView, commands } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    lease.write("one\x90hidden\x9ctwo\x9dhidden\x07three\n");
    lease.finish(0);
    await flush();
    expect(commands()[0].outputTail).toBe("onetwothree\n");
  });

  it.each(["\x1b", "\x1b["])("lets fresh control strings interrupt an unfinished %j escape", async (prefix) => {
    const { adapter, addView, commands } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    lease.write(`visible${prefix}`);
    lease.write("\x1bPhidden-control\x1b\\after");
    lease.write(`${prefix}\x90hidden-control\x9ctail\n`);
    lease.finish(0);
    await flush();
    expect(commands()[0].outputTail).toBe("visibleaftertail\n");
  });

  it("uses the daemon envelope and records actual completion, duration and selected sandbox", async () => {
    const { adapter, addView, commands, events } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    expect(lease.signal.aborted).toBe(false);
    lease.write("first result\n");
    await flush();
    expect(events.at(-1)).toMatchObject({ source: "terminal", actor: "agent", sessionId: IDENTITY.sessionId,
      target: { id: "terminal-view", path: "terminal-activity" }, kind: "snapshot", before: null });
    expect(commands()).toMatchObject([{ command: COMMAND.command, cwd: COMMAND.cwd, toolUseId: IDENTITY.toolUseId,
      turnId: IDENTITY.turnId, startedAt: 1_000, status: "running", finishedAt: null, exitCode: null,
      outputTail: "first result\n", sandbox: COMMAND.sandbox, outputAvailability: "streaming" }]);
    vi.advanceTimersByTime(1_150);
    lease.finish(7);
    expect(lease.signal.aborted).toBe(true);
    await flush();
    expect(commands()).toMatchObject([{ status: "failed", exitCode: 7, finishedAt: 2_250, durationMs: 1_250 }]);
    const seq = events.map((event) => event.seq);
    expect(seq).toEqual([...seq].sort((left, right) => left - right));
    expect(new Set(seq).size).toBe(seq.length);
  });

  it("retains completed commands for a later same-session view without replaying another session", async () => {
    const { adapter, addView, commands } = fixture();
    adapter.start(IDENTITY, COMMAND).finish(0);
    adapter.start({ ...IDENTITY, sessionId: "session-two" }, { ...COMMAND, command: "printf second" }).finish(0);
    addView();
    addView("second-view", "session-two");
    await flush();
    expect(commands().map((command) => command.command)).toEqual(["printf ready"]);
    expect(commands("session-two").map((command) => command.command)).toEqual(["printf second"]);
  });

  it("never mutates an already delivered snapshot while a command continues", async () => {
    const { adapter, addView, commands } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    lease.write("before\n");
    await flush();
    const delivered = commands()[0];
    lease.write("after\n");
    lease.finish(0);
    await flush();
    expect(delivered).toMatchObject({ status: "running", outputTail: "before\n" });
    expect(commands()[0]).toMatchObject({ status: "completed", outputTail: "before\nafter\n" });
  });

  it("redacts command, cwd, sandbox and fragmented output before any snapshot", async () => {
    const { adapter, addView, commands, events } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, { ...COMMAND, command: `printf --api-key ${SECRET}`,
      cwd: `/workspace/${SECRET}`, sandbox: { mode: "unconfined", detail: `token=${SECRET}` } });
    lease.write(`ready\nAuthorization: Bearer ${SECRET.slice(0, 14)}`);
    await flush();
    expect(JSON.stringify(events)).not.toContain(SECRET.slice(0, 14));
    lease.write(`${SECRET.slice(14)}\nPASSWORD=fixture-sensitive-value\n`);
    lease.finish(0);
    await flush();
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain("fixture-sensitive-value");
    expect(commands()[0].outputTail).toContain("REDACTED");
    expect(commands()[0].command).toContain("REDACTED");
  });

  it("strips split terminal control carriers before detecting credential text", async () => {
    const { adapter, addView, commands } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    lease.write(`visible\n\x1b]0;private terminal title`);
    lease.write(`\x1b\\sk-\x1b[3`);
    lease.write(`1m${SECRET.slice(3)}\x1b[0m\n`);
    lease.finish(0);
    await flush();
    expect(commands()[0].outputTail).toContain("visible");
    expect(commands()[0].outputTail).toContain("REDACTED");
    expect(commands()[0].outputTail).not.toContain("private terminal title");
    expect(commands()[0].outputTail).not.toContain(SECRET.slice(3));
    expect(commands()[0].outputTail).not.toContain("\x1b");
  });

  it("masks whole display fields before applying their character bounds", async () => {
    const { adapter, addView, commands, events } = fixture();
    addView();
    const secret = "fixture-sensitive-material".repeat(500);
    adapter.start(IDENTITY, { ...COMMAND,
      command: `printf --password '${secret}'`, cwd: `/workspace/token=${secret}`,
    }).finish(0);
    await flush();
    expect(commands()[0].command).toContain("REDACTED");
    expect(commands()[0].cwd).toContain("REDACTED");
    expect(commands()[0].command.length).toBeLessThanOrEqual(TERMINAL_OBSERVATION_LIMITS.maxCommandChars);
    expect(commands()[0].cwd.length).toBeLessThanOrEqual(TERMINAL_OBSERVATION_LIMITS.maxCwdChars);
    expect(JSON.stringify(events)).not.toContain("fixture-sensitive-material");
  });

  it("masks an unfinished private key at command completion", async () => {
    const { adapter, addView, commands, events } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    const body = "fixture-private-material-never-published";
    lease.write("ready\n-----BEGIN PRIVATE ");
    lease.write(`KEY-----\n${body}\n`);
    await flush();
    expect(JSON.stringify(events)).not.toContain(body);
    lease.finish(null, "failed");
    await flush();
    expect(commands()[0].outputTail).toContain("[REDACTED:PRIVATE_KEY]");
    expect(JSON.stringify(events)).not.toContain(body);
  });

  it("drops oversize private-key bodies through a split footer and resumes the safe tail", async () => {
    const { adapter, addView, commands, events } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    const material = "private-material".repeat(TERMINAL_OBSERVATION_LIMITS.maxPendingChars);
    lease.write(`-----BEGIN PRIVATE KEY-----\n${material}`);
    lease.write("-----END PRIVATE ");
    lease.write("KEY-----\nfinished safely\n");
    lease.finish(0);
    await flush();
    expect(commands()[0].outputTail).toContain("[REDACTED:PRIVATE_KEY]");
    expect(commands()[0].outputTail).toContain("finished safely");
    expect(JSON.stringify(events)).not.toContain("private-material");
    expect(commands()[0].outputTail.length).toBeLessThanOrEqual(TERMINAL_OBSERVATION_LIMITS.maxOutputChars);
  });

  it("rotates the output tail after the retained prefix is exhausted", async () => {
    const { adapter, addView, commands } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    lease.write("first line that must expire\n");
    for (let index = 0; index < 600; index += 1) lease.write(`progress line ${index}\n`);
    lease.write("newest result\n");
    lease.finish(0);
    await flush();
    expect(commands()[0].outputTail.length).toBe(TERMINAL_OBSERVATION_LIMITS.maxOutputChars);
    expect(commands()[0].outputTruncated).toBe(true);
    expect(commands()[0].outputTail).toContain("newest result");
    expect(commands()[0].outputTail).not.toContain("first line that must expire");
  });

  it("discards unmasked partial output and egress bindings when user input revokes a lease", async () => {
    const { adapter, addView, commands, events } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    lease.bindEgress(TOKEN, "terminal-session");
    lease.write("verified agent result\nprivate unfinished agent line");
    lease.revoke();
    expect(lease.signal.aborted).toBe(true);
    lease.write("user-typed-password\n");
    lease.finish(0);
    adapter.recordEgress(TOKEN, DECISION);
    await flush();
    expect(commands()[0]).toMatchObject({ status: "interrupted", exitCode: null, outputTail: "verified agent result\n", decisions: [] });
    expect(JSON.stringify(events)).not.toContain("private unfinished agent line");
    expect(JSON.stringify(events)).not.toContain("user-typed-password");
  });

  it("attaches bounded egress decisions only to the exact live private token", async () => {
    const { adapter, addView, commands } = fixture();
    addView();
    const first = adapter.start(IDENTITY, COMMAND);
    const second = adapter.start({ ...IDENTITY, toolUseId: "tool-two" }, { ...COMMAND, command: "printf other" });
    first.bindEgress(TOKEN);
    second.bindEgress("b".repeat(32), "terminal-session");
    adapter.recordEgress("c".repeat(32), DECISION);
    for (let index = 0; index < TERMINAL_OBSERVATION_LIMITS.maxDecisions + 5; index += 1) {
      adapter.recordEgress(TOKEN, { ...DECISION, host: `host-${index}.test`, reason: `password=${SECRET}` });
    }
    adapter.recordEgress("b".repeat(32), { ...DECISION, decision: "allow", scope: "tab" });
    first.finish(0);
    adapter.recordEgress(TOKEN, { ...DECISION, host: "late.test" });
    await flush();
    expect(commands()[0].decisions).toHaveLength(TERMINAL_OBSERVATION_LIMITS.maxDecisions);
    expect(commands()[0].decisions[0].host).toBe("host-5.test");
    expect(commands()[0].decisions.every((decision) => decision.attribution === "command")).toBe(true);
    expect(JSON.stringify(commands()[0].decisions)).not.toContain(SECRET);
    expect(JSON.stringify(commands()[0].decisions)).not.toContain("late.test");
    expect(commands()[1].decisions).toMatchObject([{ decision: "allow", attribution: "terminal-session", scope: "tab" }]);
  });

  it("coalesces pending snapshots while a renderer withholds acknowledgement", async () => {
    const { adapter, addView, commands, events } = fixture(false);
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    await flush();
    expect(events).toHaveLength(1);
    for (let index = 0; index < 20; index += 1) {
      lease.write(`line ${index}\n`);
      await flush();
    }
    expect(events).toHaveLength(1);
    expect(commands()).toEqual([]);
    adapter.acknowledge("terminal-view", events[0].seq);
    await flush();
    expect(events).toHaveLength(2);
    expect(commands()[0].outputTail).toContain("line 19");
    expect(events[1].seq).toBeGreaterThan(events[0].seq + 1);
    expect(() => adapter.acknowledge("terminal-view", events[1].seq + 1)).toThrow("Invalid observation acknowledgement.");
  });

  it("evicts completed commands before admitting another and never drops a running command silently", async () => {
    const { adapter, addView, commands } = fixture();
    addView();
    for (let index = 0; index < TERMINAL_OBSERVATION_LIMITS.maxCommands + 4; index += 1) {
      adapter.start({ ...IDENTITY, toolUseId: `tool-${index}` }, { ...COMMAND, command: `printf ${index}` }).finish(0);
    }
    await flush();
    expect(commands()).toHaveLength(TERMINAL_OBSERVATION_LIMITS.maxCommands);
    expect(commands()[0].command).toBe("printf 4");
    adapter.releaseSessions((sessionId) => sessionId === IDENTITY.sessionId);
    for (let index = 0; index < TERMINAL_OBSERVATION_LIMITS.maxCommands; index += 1) {
      adapter.start({ ...IDENTITY, toolUseId: `active-${index}` }, COMMAND);
    }
    expect(() => adapter.start(IDENTITY, COMMAND)).toThrow("Terminal observation command limit exceeded.");
  });

  it("evicts only idle unviewed sessions and explicitly refuses active session capacity", async () => {
    const { adapter, addView, commands } = fixture();
    for (let index = 0; index < TERMINAL_OBSERVATION_LIMITS.maxSessions; index += 1) {
      adapter.start({ ...IDENTITY, sessionId: `session-${index}` }, COMMAND).finish(0);
    }
    adapter.start({ ...IDENTITY, sessionId: "new-session" }, COMMAND).finish(0);
    addView("evicted-view", "session-0");
    await flush();
    expect(commands("session-0")).toEqual([]);
    adapter.releaseSessions(() => true);
    for (let index = 0; index < TERMINAL_OBSERVATION_LIMITS.maxSessions; index += 1) {
      adapter.start({ ...IDENTITY, sessionId: `active-session-${index}` }, COMMAND);
    }
    expect(() => adapter.start({ ...IDENTITY, sessionId: "overflow-session" }, COMMAND))
      .toThrow("Terminal observation session limit exceeded.");
  });

  it("purges deleted session buffers, pending delivery and retained producer leases", async () => {
    const { adapter, addView, commands, events } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, COMMAND);
    lease.bindEgress(TOKEN);
    lease.write("before deletion\n");
    adapter.releaseSessions((sessionId) => sessionId === IDENTITY.sessionId);
    expect(lease.signal.aborted).toBe(true);
    lease.write("after deletion\n");
    lease.finish(0);
    adapter.recordEgress(TOKEN, DECISION);
    await flush();
    expect(events).toEqual([]);
    addView("replacement-view");
    await flush();
    expect(commands()).toEqual([]);
  });

  it("releases stale views and all observation work on disposal", async () => {
    const { daemon, adapter, addView, events } = fixture();
    let current = true;
    addView("stale-view", IDENTITY.sessionId, () => current);
    const lease = adapter.start(IDENTITY, COMMAND);
    current = false;
    lease.write("no longer visible\n");
    await flush();
    expect(events).toEqual([]);
    expect(() => adapter.acknowledge("stale-view", 0)).toThrow("Terminal observation view is unavailable.");
    daemon.dispose();
    expect(lease.signal.aborted).toBe(true);
    lease.write("after disposal\n");
    lease.finish(0);
    await flush();
    expect(events).toEqual([]);
    expect(() => adapter.start(IDENTITY, COMMAND)).toThrow("Terminal observation is disposed.");
  });

  it("rejects malformed host contracts rather than selecting a fallback", () => {
    const { adapter } = fixture();
    expect(() => adapter.start(IDENTITY, { ...COMMAND, kind: "terminal" })).toThrow("Invalid terminal observation command.");
    const first = adapter.start(IDENTITY, COMMAND);
    const second = adapter.start({ ...IDENTITY, toolUseId: "other-tool" }, COMMAND);
    expect(() => first.bindEgress("not-a-host-token")).toThrow("Invalid terminal observation egress binding.");
    first.bindEgress(TOKEN);
    expect(() => second.bindEgress(TOKEN)).toThrow("Terminal observation egress binding already active.");
    expect(() => first.finish(1.5)).toThrow("Invalid observed terminal exit code.");
    expect(() => adapter.recordEgress(TOKEN, { ...DECISION, port: -1 })).toThrow("Invalid observed terminal egress decision.");
    expect(() => adapter.start(IDENTITY, { ...COMMAND, outputAvailability: "partial" as never })).toThrow("Invalid terminal observation command.");
    // Only an agent terminal the user typed into withholds; a shell tool run has no user input to attribute.
    expect(() => adapter.start(IDENTITY, { ...COMMAND, outputAvailability: "withheld-user-input" })).toThrow("Invalid terminal observation command.");
  });

  it("records a withheld command's metadata and refuses any output or egress for it", async () => {
    const { adapter, addView, commands } = fixture();
    addView();
    const lease = adapter.start(IDENTITY, { ...COMMAND, kind: "terminal", tabId: "tab", terminalSessionId: "terminal-session",
      outputAvailability: "withheld-user-input" });
    expect(() => lease.write("USER_PRIVATE\n")).toThrow("Terminal observation output is withheld for this command.");
    expect(() => lease.bindEgress(TOKEN, "terminal-session")).toThrow("Terminal observation egress is withheld for this command.");
    adapter.recordEgress(TOKEN, DECISION);
    lease.finish(0);
    await flush();
    expect(commands()[0]).toMatchObject({ command: "printf ready", status: "completed", exitCode: 0,
      outputAvailability: "withheld-user-input", outputTail: "", decisions: [] });
  });
});
