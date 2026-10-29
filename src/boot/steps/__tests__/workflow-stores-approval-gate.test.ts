import { createBootHostFixture } from "../../../__tests__/support/host-runtime.js";
/** Drive setupWorkflowStores to verify first-use approval shares the executor’s gate instance. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

// Create temp directories atomically so existing paths or planted symlinks cannot be followed.
const TEST_HOME = mkdtempSync(join(tmpdir(), "ave-wf-gate-"));
process.env.AVE_HOME = TEST_HOME;

// Record transport wiring without DNS requests; SSRF behavior is covered separately.
const guardCalls: { fetchImpl: unknown }[] = [];
vi.mock("../../../core/network-guard.js", () => ({
  fetchPublicHttpResponse: async (_url: string, opts: { fetchImpl: unknown }) => {
    guardCalls.push({ fetchImpl: opts.fetchImpl });
    return new Response("<html><body>ok</body></html>", { status: 200 });
  },
}));

const { setupWorkflowStores } = await import("../workflow-stores.js");
const { ToolRegistry } = await import("../../../tools/registry.js");
import type { BootContext } from "../../context.js";
import type { ToolExecutionContext } from "../../../tools/types.js";

function toolCtx(sessionId: string): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    metadata: { sessionId },
  };
}

beforeEach(() => {
  mkdirSync(join(TEST_HOME, "skills", "demo"), { recursive: true });
  writeFileSync(
    join(TEST_HOME, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: A user-authored skill\n---\ndemo body",
    "utf-8",
  );
});

afterEach(async () => {
  await cleanupTmpDir(TEST_HOME);
});

interface GateProbe {
  requests: { toolName?: string; args?: unknown }[];
}

function makeCtx(): { ctx: BootContext; registry: InstanceType<typeof ToolRegistry>; probe: GateProbe } {
  const registry = new ToolRegistry();
  const probe: GateProbe = { requests: [] };
  const approvalGate = {
    setConversationTitleResolver: vi.fn(),
    requestAndWait: async (req: { toolName?: string; args?: unknown }) => {
      probe.requests.push({ toolName: req.toolName, args: req.args });
      return { choice: "allow" };
    },
  };
  const ctx = {
      host: createBootHostFixture(),
    routinesStore: undefined,
    getMainWindow: () => null,
    notificationService: undefined,
    approvalGate,
    networkFetch: undefined,
    toolRegistry: registry,
    settingsService: { get: () => undefined, getAll: () => ({}) },
  } as unknown as BootContext;
  return { ctx, registry, probe };
}

describe("setupWorkflowStores — tool and idle-scheduler wiring", () => {
  it("names a child approval from its owning root conversation", async () => {
    const { ctx } = makeCtx();
    const rootSessionId = "5b2e9248-42cd-4c68-87eb-c4f3cb940613";
    const childSessionId = "f0f9dcf5-c2c6-4789-804b-6edf7b0e7a86";
    const titleResolver = vi.fn();
    ctx.approvalGate.setConversationTitleResolver = titleResolver;
    ctx.findLoopBySessionId = vi.fn((sessionId) => ({
      getHistory: () => ({ getMessages: () => [{ role: "user", content: sessionId === rootSessionId
        ? "그래 두개 진행해보자" : "Internal child task" }] }),
    })) as unknown as BootContext["findLoopBySessionId"];
    const store = { hasSessionTranscript: () => false, hasSessionMetadataFile: () => false,
      loadSessionMetadata: () => null, loadSession: vi.fn(() => null) };
    await setupWorkflowStores(ctx, [store as never]);
    ctx.subAgentRunnerRef.fn = {
      resolveOriginSessionId: (sessionId: string) => sessionId === childSessionId ? rootSessionId : undefined,
    } as never;
    const resolveTitle = titleResolver.mock.calls[0][0] as (id: string) => string;
    expect(resolveTitle(childSessionId)).toBe("그래 두개 진행해보자");
    expect(ctx.findLoopBySessionId).toHaveBeenCalledWith(rootSessionId);
    expect(ctx.findLoopBySessionId).not.toHaveBeenCalledWith(childSessionId);
    ctx.idleScheduler?.stop();
  });

  it("names an approval from the live first turn before its transcript is flushed", async () => {
    const { ctx } = makeCtx();
    const sessionId = "live-session";
    const titleResolver = vi.fn();
    ctx.approvalGate.setConversationTitleResolver = titleResolver;
    ctx.findLoopBySessionId = vi.fn(() => ({
      getHistory: () => ({ getMessages: () => [{ role: "user", content: "그래 두개 진행해보자" }] }),
    })) as unknown as BootContext["findLoopBySessionId"];
    const store = { hasSessionTranscript: () => false, hasSessionMetadataFile: () => false,
      loadSessionMetadata: () => null, loadSession: vi.fn(() => null) };
    await setupWorkflowStores(ctx, [store as never]);
    const resolveTitle = titleResolver.mock.calls[0][0] as (id: string) => string;
    expect(resolveTitle(sessionId)).toBe("그래 두개 진행해보자");
    expect(store.loadSession).not.toHaveBeenCalled();
    ctx.idleScheduler?.stop();
  });
  it("registers skill_load and routes its first-use modal to ctx.approvalGate", async () => {
    const { ctx, registry, probe } = makeCtx();

    await setupWorkflowStores(ctx, []);

    const tool = registry.findByName("skill_load");
    expect(tool, "skill_load must be registered by the boot step").toBeDefined();

    const result = await tool!.execute({ skillName: "demo" }, toolCtx("sess-gate"));

    expect(result.isError).toBe(false);
    expect(result.output.startsWith('<ave-skill name="demo"')).toBe(true);
    expect(probe.requests).toHaveLength(1);
    expect(probe.requests[0]?.toolName).toBe("skill_load");
    expect(probe.requests[0]?.args).toEqual({ skillName: "demo" });
    ctx.idleScheduler?.stop();
  });

  it("starts the idle scheduler with no plugin installed", async () => {
    // Build the idle scheduler independently of plugin input; its absence disables idle consumers.
    const { ctx } = makeCtx();

    await setupWorkflowStores(ctx, []);

    expect(ctx.idleScheduler).toBeDefined();
    ctx.idleScheduler?.stop();
  });

  it("blocks the skill body when the user denies at that same gate", async () => {
    const registry = new ToolRegistry();
    const ctx = {
      host: createBootHostFixture(),
      getMainWindow: () => null,
      approvalGate: { setConversationTitleResolver: vi.fn(), requestAndWait: async () => ({ choice: "deny-once" }) },
      toolRegistry: registry,
      settingsService: { get: () => undefined, getAll: () => ({}) },
    } as unknown as BootContext;

    await setupWorkflowStores(ctx, []);

    const tool = registry.findByName("skill_load");
    const result = await tool!.execute({ skillName: "demo" }, toolCtx("sess-deny"));

    expect(result.isError).toBe(true);
    expect(result.output).toContain("user denied skill load");
    expect(result.output).not.toContain("demo body");
    ctx.idleScheduler?.stop();
  });
});

/** A headless launch can have a window; argv must decide whether anyone can answer approvals. */
describe("setupWorkflowStores — ask_user_question on a headless turn", () => {
  const CARD = {
    questions: [{ question: "Which way?", choices: ["left", "right"] }],
  };

  function ctxWithWindow(): {
    ctx: BootContext;
    registry: InstanceType<typeof ToolRegistry>;
    sent: string[];
  } {
    const registry = new ToolRegistry();
    const sent: string[] = [];
    const ctx = {
      host: createBootHostFixture(),
      getMainWindow: () => ({
        webContents: {
          send: (channel: string) => {
            sent.push(channel);
          },
        },
      }),
      approvalGate: { setConversationTitleResolver: vi.fn(), requestAndWait: async () => ({ choice: "allow" }) },
      toolRegistry: registry,
      settingsService: { get: () => undefined, getAll: () => ({}) },
    } as unknown as BootContext;
    return { ctx, registry, sent };
  }

  let realArgv: string[];
  beforeEach(() => {
    realArgv = process.argv;
  });
  afterEach(() => {
    process.argv = realArgv;
  });

  it("hands the card to the window on an interactive launch", async () => {
    process.argv = ["electron", "main.js"];
    const { ctx, registry, sent } = ctxWithWindow();

    await setupWorkflowStores(ctx, []);
    const tool = registry.findByName("ask_user_question");
    expect(tool, "ask_user_question must be registered by the boot step").toBeDefined();

    // Abort the parked interactive gate so its timer does not outlive the test.
    const abort = new AbortController();
    const pending = tool!.execute(CARD, { ...toolCtx("sess-ask"), abortSignal: abort.signal });
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0));
    abort.abort();
    await pending;

    ctx.idleScheduler?.stop();
  });

  it("answers a headless turn itself instead of opening a gate no one can close", async () => {
    process.argv = ["electron", "main.js", "--exec"];
    const { ctx, registry, sent } = ctxWithWindow();

    await setupWorkflowStores(ctx, []);
    const tool = registry.findByName("ask_user_question");

    const result = await tool!.execute(CARD, toolCtx("sess-headless"));

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output).dismissed).toBe(true);
    expect(sent, "no card may reach a renderer nobody is watching").toHaveLength(0);

    ctx.idleScheduler?.stop();
  });
});

/** Per-hop guards need single-hop transport; the desktop fetch API throws on visible redirects. */
describe("setupWorkflowStores — web_fetch transport", () => {
  beforeEach(() => {
    guardCalls.length = 0;
  });

  it("builds web_fetch on the transport that returns a redirect hop", async () => {
    const registry = new ToolRegistry();
    const plain = (async () => new Response("plain")) as unknown as typeof fetch;
    const singleHop = (async () => new Response("single-hop")) as unknown as typeof fetch;
    const ctx = {
      host: createBootHostFixture(),
      getMainWindow: () => null,
      approvalGate: { setConversationTitleResolver: vi.fn(), requestAndWait: async () => ({ choice: "allow" }) },
      networkFetch: plain,
      singleHopNetworkFetch: singleHop,
      toolRegistry: registry,
      settingsService: { get: () => undefined, getAll: () => ({}) },
    } as unknown as BootContext;

    await setupWorkflowStores(ctx, []);
    const tool = registry.findByName("web_fetch");
    expect(tool, "web_fetch must be registered by the boot step").toBeDefined();

    await tool!.execute({ url: "https://example.com/" }, toolCtx("sess-fetch"));

    expect(guardCalls).toHaveLength(1);
    expect(
      guardCalls[0]?.fetchImpl,
      "web_fetch must guard hops on the single-hop transport, not net.fetch",
    ).toBe(singleHop);
    expect(guardCalls[0]?.fetchImpl).not.toBe(plain);

    ctx.idleScheduler?.stop();
  });
});
