import { AsyncResource } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWithInvocationOrigin } from "../../plugins/runtime/origin-chain.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../agent-observation-context.js";
import { runAdmittedAgentWork } from "../../__tests__/support/agent-observation-admission.js";
import { observeAgentBrowserCommand, setAgentBrowserObservationSink, type AgentBrowserObservationSink } from "../agent-browser-observation.js";
import type { BrowserGuest, BrowserTabRecord } from "../../main/browser/browser-tab-registry.js";
const identity = { sessionId: "browser-session", turnId: "turn", toolUseId: "tool" };
let tab: BrowserTabRecord<BrowserGuest>;
let destroyed: boolean;
const complete = vi.fn();
const dispose = vi.fn();
const target = vi.fn();
let sink: AgentBrowserObservationSink;
beforeEach(() => {
  destroyed = false;
  tab = { handle: "tab-1", rendererTabId: "browser-one", windowId: 1, guest: { id: 10, isDestroyed: () => destroyed, getURL: () => "https://example.test/", getTitle: () => "Example" },
    opener: "agent", documentId: 1, agentOrigin: "https://example.test", controlMode: "agent-active", controlGeneration: 1,
    targetKind: "embedded", openerTabId: null, owner: { sessionId: identity.sessionId },
    lease: { id: "lease", actor: { sessionId: identity.sessionId }, lifetime: "owned" }, actions: new AbortController() };
  complete.mockClear(); dispose.mockClear(); target.mockClear();
  sink = { begin: vi.fn(() => ({ complete, dispose, target })), endSessions: vi.fn() };
  setAgentBrowserObservationSink(sink);
});
afterEach(() => setAgentBrowserObservationSink(undefined));

describe("agent browser command admission", () => {
  it("requires both the model turn and admitted invocation rather than supplied tab metadata", async () => {
    await observeAgentBrowserCommand(tab, "click", async () => 1);
    await runWithAgentObservationTurn(identity, () => observeAgentBrowserCommand(tab, "click", async () => 1));
    expect(sink.begin).not.toHaveBeenCalled();
    expect(await runAdmittedAgentWork(identity, () => observeAgentBrowserCommand(tab, "click", async () => 42))).toBe(42);
    expect(sink.begin).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
  });
  it.each(["ui", "mcp-app"] as const)("excludes %s-origin tool calls even inside a model turn", async (origin) => {
    await runWithAgentObservationTurn(identity, () => runWithInvocationOrigin(origin, undefined,
      () => runWithAgentObservationInvocation(identity, () => observeAgentBrowserCommand(tab, "click", async () => 1))));
    expect(sink.begin).not.toHaveBeenCalled();
  });
  it.each(["human", "human-paused"] as const)("excludes an uncontrolled %s tab", async (mode) => {
    tab.controlMode = mode;
    await runAdmittedAgentWork(identity, () => observeAgentBrowserCommand(tab, "click", async () => 1));
    expect(sink.begin).not.toHaveBeenCalled();
  });
  it("excludes another session's lease", async () => {
    tab.lease = { ...tab.lease!, actor: { sessionId: "other-session" } };
    await runAdmittedAgentWork(identity, () => observeAgentBrowserCommand(tab, "click", async () => 1));
    expect(sink.begin).not.toHaveBeenCalled();
  });
  it.each(["pause", "replace", "abort", "failed-result", "throw"])("does not record a command after %s", async (failure) => {
    const controller = new AbortController();
    const work = runAdmittedAgentWork(identity, () => observeAgentBrowserCommand(tab, "click", async () => {
      if (failure === "pause") tab.controlMode = "human-paused";
      if (failure === "replace") tab.guest = { ...tab.guest!, id: 11 };
      if (failure === "abort") controller.abort();
      if (failure === "throw") throw new Error("Action failed");
      return { isError: failure === "failed-result" };
    }, controller.signal));
    if (failure === "throw") await expect(work).rejects.toThrow("Action failed"); else await work;
    expect(complete).not.toHaveBeenCalled(); expect(dispose).toHaveBeenCalledOnce();
  });
  it("captures invocation validity independently of native callback async context", async () => {
    const foreign = new AsyncResource("native-download");
    let valid: (() => boolean) | undefined;
    sink.begin = vi.fn((_identity, _tab, _action, isCurrent) => {
      valid = isCurrent;
      return { complete, dispose, target };
    });
    await runAdmittedAgentWork(identity, () => observeAgentBrowserCommand(tab, "click", async () => {
      expect(foreign.runInAsyncScope(() => valid!())).toBe(true);
    }));
    expect(foreign.runInAsyncScope(() => valid!())).toBe(false);
    foreign.emitDestroy();
  });
  it("observes authorized owned close after original destruction without inventing a new guest", async () => {
    tab.lease = null; tab.controlMode = "human";
    await runAdmittedAgentWork(identity, () => observeAgentBrowserCommand(tab, "tab-close", async () => { destroyed = true; tab.guest = null; }));
    expect(complete).toHaveBeenCalledOnce();
  });
  it("does not turn release of a human tab into a close observation", async () => {
    tab.opener = "user"; tab.owner = null; tab.lease = null; tab.controlMode = "human";
    await runAdmittedAgentWork(identity, () => observeAgentBrowserCommand(tab, "tab-close", async () => 1));
    expect(sink.begin).not.toHaveBeenCalled();
  });
});
