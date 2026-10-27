import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithInvocationOrigin } from "../../plugins/runtime/origin-chain.js";
import { ObservationDaemon } from "../../observation/daemon.js";
import { TerminalObservationAdapter } from "../../observation/terminal-adapter.js";
import type { TerminalObservationEvent } from "../../shared/agent-observation.js";
import {
  beginAgentTerminalObservation,
  observeAgentTerminalEgressDecision,
  releaseAgentTerminalObservationSessions,
  setAgentTerminalObservationSink,
  type AgentTerminalObservationInput,
  type AgentTerminalObservationLease,
  type AgentTerminalObservationSink,
} from "../agent-terminal-observation.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../agent-observation-context.js";
import { agentObservationFixture } from "../../__tests__/support/agent-observation.js";

const TURN = { sessionId: "terminal-session", turnId: "terminal-turn" };
const INVOCATION = { sessionId: TURN.sessionId, toolUseId: "terminal-tool" };
const admitted = agentObservationFixture({ ...TURN, ...INVOCATION });
const COMMAND: AgentTerminalObservationInput = {
  kind: "shell", command: "printf progress", cwd: "/workspace/project",
  sandbox: { mode: "isolated", detail: "filesystem and process confinement" },
};
let daemon: ObservationDaemon;
let adapter: TerminalObservationAdapter;
let sink: AgentTerminalObservationSink;
let events: TerminalObservationEvent[];

beforeEach(() => {
  vi.useFakeTimers();
  daemon = new ObservationDaemon();
  adapter = new TerminalObservationAdapter(daemon);
  events = [];
  adapter.registerView("terminal-view", TURN.sessionId, () => true, (batch) => {
    events.push(...batch);
    adapter.acknowledge("terminal-view", batch.at(-1)!.seq);
  });
  sink = {
    start: vi.fn((identity, input) => adapter.start(identity, input)),
    egress: vi.fn((token, decision) => adapter.recordEgress(token, decision)),
    releaseSessions: vi.fn((ended) => adapter.releaseSessions(ended)),
  };
  setAgentTerminalObservationSink(sink);
});

afterEach(() => {
  setAgentTerminalObservationSink(undefined);
  daemon.dispose();
  vi.useRealTimers();
});


async function commands() {
  await vi.advanceTimersByTimeAsync(100);
  const latest = events.findLast((event) => event.kind === "snapshot");
  if (!latest || latest.kind !== "snapshot") throw new Error("Expected terminal observation snapshot.");
  return latest.after.commands;
}

describe("agent terminal observation authority", () => {
  it("does not record ordinary user commands even when input carries agent-looking metadata", async () => {
    const untrusted = { ...COMMAND, ...TURN, ...INVOCATION, actor: "agent", lane: "agent" };
    expect(beginAgentTerminalObservation(untrusted)).toBeUndefined();
    expect(sink.start).not.toHaveBeenCalled();
    expect(await commands()).toEqual([]);
  });

  it("requires both a host model turn and a matching admitted invocation", async () => {
    await runWithAgentObservationInvocation(INVOCATION, async () => {
      expect(beginAgentTerminalObservation(COMMAND)).toBeUndefined();
    });
    await runWithAgentObservationTurn(TURN, async () => {
      expect(beginAgentTerminalObservation(COMMAND)).toBeUndefined();
      await runWithAgentObservationInvocation({ ...INVOCATION, sessionId: "another-session" }, async () => {
        expect(beginAgentTerminalObservation(COMMAND)).toBeUndefined();
      });
    });
    expect(sink.start).not.toHaveBeenCalled();
    expect(await commands()).toEqual([]);
  });

  it.each(["ui", "mcp-app"] as const)("never promotes a %s-origin invocation to agent observation", async (origin) => {
    await runWithAgentObservationTurn(TURN, () => runWithInvocationOrigin(origin, undefined, () =>
      runWithAgentObservationInvocation(INVOCATION, async () => {
        expect(beginAgentTerminalObservation(COMMAND)).toBeUndefined();
      })));
    expect(sink.start).not.toHaveBeenCalled();
    expect(await commands()).toEqual([]);
  });

  it("does not observe independent plugin calls without a host model invocation", async () => {
    await runWithInvocationOrigin("plugin", undefined, async () => {
      expect(beginAgentTerminalObservation(COMMAND)).toBeUndefined();
    });
    expect(sink.start).not.toHaveBeenCalled();
    expect(await commands()).toEqual([]);
  });

  it("does not inherit outer agent authority through nested user and plugin calls", async () => {
    await admitted(() => runWithInvocationOrigin("ui", undefined, () => runWithInvocationOrigin("plugin", undefined, async () => {
      expect(beginAgentTerminalObservation(COMMAND)).toBeUndefined();
    })));
    expect(sink.start).not.toHaveBeenCalled();
    expect(await commands()).toEqual([]);
  });

  it("derives the recorded identity from the admitted host context", async () => {
    await admitted(async () => {
      const lease = beginAgentTerminalObservation(COMMAND);
      expect(lease).toBeDefined();
      lease!.write("agent result\n");
      lease!.finish(0);
    });
    expect(sink.start).toHaveBeenCalledExactlyOnceWith({ ...TURN, toolUseId: INVOCATION.toolUseId }, COMMAND);
    expect(await commands()).toMatchObject([{ status: "completed", command: COMMAND.command,
      toolUseId: INVOCATION.toolUseId, turnId: TURN.turnId, outputTail: "agent result\n" }]);
  });

  it("lets a bound child finish after its invocation without granting a new command authority", async () => {
    let lease: AgentTerminalObservationLease | undefined;
    let resume!: () => void;
    let later!: Promise<AgentTerminalObservationLease | undefined>;
    await admitted(async () => {
      lease = beginAgentTerminalObservation(COMMAND);
      later = new Promise<void>((resolve) => { resume = resolve; }).then(() => beginAgentTerminalObservation({ ...COMMAND, command: "printf forbidden" }));
    });
    resume();
    expect(await later).toBeUndefined();
    expect(beginAgentTerminalObservation(COMMAND)).toBeUndefined();
    lease!.write("continued child result\n");
    lease!.finish(0);
    expect(sink.start).toHaveBeenCalledTimes(1);
    expect(await commands()).toMatchObject([{ command: COMMAND.command, status: "completed", outputTail: "continued child result\n" }]);
  });

  it("denies new command observation immediately when the invocation is cancelled", async () => {
    const controller = new AbortController();
    await runWithAgentObservationTurn(TURN, () => runWithAgentObservationInvocation(INVOCATION, async () => {
      const lease = beginAgentTerminalObservation(COMMAND)!;
      controller.abort();
      expect(beginAgentTerminalObservation({ ...COMMAND, command: "printf late" })).toBeUndefined();
      lease.finish(null, "cancelled");
    }, undefined, controller.signal));
    expect(sink.start).toHaveBeenCalledTimes(1);
    expect(await commands()).toMatchObject([{ status: "cancelled", exitCode: null }]);
  });

  it("does not install a substitute observer outside the local desktop owner", async () => {
    setAgentTerminalObservationSink(undefined);
    await admitted(async () => { expect(beginAgentTerminalObservation(COMMAND)).toBeUndefined(); });
    expect(sink.start).not.toHaveBeenCalled();
    expect(await commands()).toEqual([]);
  });

  it("forwards live-token decisions and session deletion through the installed local owner", async () => {
    const token = "d".repeat(32);
    await admitted(async () => {
      const lease = beginAgentTerminalObservation(COMMAND)!;
      lease.bindEgress(token);
      observeAgentTerminalEgressDecision(undefined, { host: "unattributed.test", port: 443,
        decision: "deny", basis: "sandbox", scope: null, reason: "refused" });
      observeAgentTerminalEgressDecision(token, { host: "example.test", port: 443,
        decision: "allow", basis: "grant", scope: "session", reason: null });
    });
    expect(sink.egress).toHaveBeenCalledTimes(1);
    expect((await commands())[0].decisions).toMatchObject([{ host: "example.test", decision: "allow", attribution: "command" }]);
    const ended = (sessionId: string): boolean => sessionId === TURN.sessionId;
    releaseAgentTerminalObservationSessions(ended);
    expect(sink.releaseSessions).toHaveBeenCalledExactlyOnceWith(ended);
  });

  it("propagates local observer contract failures instead of silently recording nothing", async () => {
    sink.start = vi.fn(() => { throw new Error("terminal observation refused"); });
    await expect(admitted(async () => beginAgentTerminalObservation(COMMAND))).rejects.toThrow("terminal observation refused");
    expect(sink.start).toHaveBeenCalledTimes(1);
  });
});
