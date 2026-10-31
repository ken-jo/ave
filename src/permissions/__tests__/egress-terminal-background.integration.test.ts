import { killTerminal } from "../../__tests__/support/terminal-agent-fixture.js";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { sentApprovalCards } from "../../__tests__/test-helpers.js";
import { initializeRequiredSandbox, shouldSkipNativeSandboxTests } from "../../__tests__/support/native-sandbox.js";
import { getTerminalBlockTracker, spawnTerminal, writeTerminal } from "../../__tests__/support/terminal-agent-fixture.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { __resetTerminalsForTest, __terminalSessionCountForTest, forceKillAllTerminalsForShutdown, _setTerminalInspectionForTest } from "../../main/terminal/pty-manager.js";
import type { TerminalBlockTracker } from "../../main/terminal/terminal-blocks.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { ApprovalGate, type ApprovalRequest } from "../approval-gate.js";
import { isAsrtSandboxActive, resetAsrtSandbox, useAppOwnedSandboxTempRoot } from "../asrt-sandbox.js";
import { liveEgressInvocationCount } from "../egress-invocations.js";
import { createEgressAskRuntimeCallback, listEgressGrants, revokeEgressGrant, setWorkerEgressAllowlists } from "../egress-runtime.js";
import { __resetActiveSandboxCapabilityForTest, setActiveSandboxCapability, setShellSandboxRequestedAtBoot } from "../sandbox-capability.js";
import { scrubShortError } from "../../shared/dlp.js";

const TAB_ID = "terminal:0a1b2c3d-3";
const OWNER_WINDOW_ID = 1;

describe.skipIf(shouldSkipNativeSandboxTests())("terminal background egress through the native terminal producer", () => {
  let root: string;
  let server: Server;
  let port: number;
  let received: number;
  let streamClosed: number;
  let shown: string;
  let gate: ApprovalGate;
  let callback: Mock<ReturnType<typeof createEgressAskRuntimeCallback>>;
  let wc: { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean };

  const cards = () => sentApprovalCards<ApprovalRequest>(wc);
  const target = () => ({ scope: "tab" as const, tabId: TAB_ID, host: "127.0.0.1", port, network: "local" as const });

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "terminal-egress-")));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    received = 0;
    streamClosed = 0;
    shown = "";
    wc = { send: vi.fn(), isDestroyed: () => false };
    gate = new ApprovalGate(wc as never, undefined, 15_000, { log: vi.fn() } as never);
    server = createServer((request, response) => {
      received += 1;
      if (request.url === "/stream") {
        response.writeHead(200, { "Content-Length": "100000" });
        response.write("stream-connected\n");
        response.once("close", () => { streamClosed += 1; });
      } else response.end("background-connected\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    vi.stubEnv("SHELL", process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
    vi.stubEnv("EGRESS_TEST_API_KEY", "host-secret-must-not-reach-terminal");
    vi.stubEnv("CLAUDE_CODE_TMPDIR", process.env.CLAUDE_CODE_TMPDIR);
    vi.stubEnv("CLAUDE_TMPDIR", process.env.CLAUDE_TMPDIR);
    _setTerminalInspectionForTest((event, payload) => {
      if (event === "data") shown += (payload as { chunk: string }).chunk;
    });
    // Even a host present in both worker sources must still ask in the terminal.
    setWorkerEgressAllowlists({ byExtension: new Map([["fixture-plugin", ["127.0.0.1"]]]), modelEndpointHosts: ["127.0.0.1"] });
    useAppOwnedSandboxTempRoot();
    callback = vi.fn(createEgressAskRuntimeCallback({ approvalGate: gate, shellAskEnabled: () => true }));
    const { SandboxManager } = await import("@anthropic-ai/sandbox-runtime");
    const reportProbeFailure = (phase: string, error: unknown) => {
      let message = error instanceof Error ? error.message.split(/[\r\n]/, 1)[0]! : "non-error failure";
      message = message.replace(/[\[({].*/, "[DETAILS REDACTED]");
      for (const value of Object.values(process.env)) if (value && value.length >= 4) message = message.split(value).join("[ENV]");
      message = scrubShortError(message).replace(/\b(command|profile|config)\s*[:=].*/gi, "$1=[REDACTED]");
      const rawCode = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      const code = typeof rawCode === "string" && /^[a-z0-9_-]{1,40}$/i.test(rawCode) ? rawCode : "unclassified";
      console.error("native-runtime-probe-diagnostic", JSON.stringify({ phase, code, message }));
    };
    const openListener = SandboxManager.openInvocationListener.bind(SandboxManager);
    // Observe rejection separately; the caller keeps the original promise and error.
    vi.spyOn(SandboxManager, "openInvocationListener").mockImplementation((...args) => {
      try {
        const pending = openListener(...args);
        void pending.catch(error => { reportProbeFailure("open-listener", error); });
        return pending;
      } catch (error) {
        reportProbeFailure("open-listener", error);
        throw error;
      }
    });
    const wrap = SandboxManager.wrapWithSandboxArgv.bind(SandboxManager);
    vi.spyOn(SandboxManager, "wrapWithSandboxArgv").mockImplementation((...args) => {
      try {
        const pending = wrap(...args);
        void pending.catch(error => { reportProbeFailure("prepare-wrapper", error); });
        return pending;
      } catch (error) {
        reportProbeFailure("prepare-wrapper", error);
        throw error;
      }
    });
    await initializeRequiredSandbox({ allowedDomains: [] }, callback);
    // The terminal reads the shell scope, which the boot gate seals.
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      kind: "asrt", confidence: "verified", platform: process.platform,
      reason: "native integration fixture", confines: { filesystem: true, process: true, network: true },
    });
  });

  afterEach(async () => {
    try {
      killTerminal(TAB_ID);
      await vi.waitFor(() => expect(__terminalSessionCountForTest()).toBe(0), { timeout: 10_000 });
      expect(liveEgressInvocationCount()).toBe(0);
    } finally {
      await forceKillAllTerminalsForShutdown();
      __resetTerminalsForTest();
      for (const grant of await listEgressGrants()) await revokeEgressGrant(grant);
      setWorkerEgressAllowlists({ byExtension: new Map(), modelEndpointHosts: [] });
      if (isAsrtSandboxActive()) await resetAsrtSandbox();
      __resetActiveSandboxCapabilityForTest();
      setShellSandboxRequestedAtBoot(false);
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (root) await cleanupTmpDir(root);
    }
  });

  async function startTerminal(): Promise<TerminalBlockTracker> {
    // This fixture only reserves logical tab ownership; spawnTerminal still owns its native wrapper, stripped environment, node-pty and invocation lifecycle.
    const spawned = await spawnTerminal({ tabId: TAB_ID, ownerWindowId: OWNER_WINDOW_ID, cwd: root, cols: 100, rows: 30 });
    expect(spawned, JSON.stringify(spawned)).toMatchObject({ ok: true, session: { lane: "agent", substrate: "asrt" } });
    const tracker = getTerminalBlockTracker(TAB_ID)!;
    await vi.waitFor(() => expect(tracker.promptEndCount(), shown).toBeGreaterThan(0), { timeout: 20_000 });
    await vi.waitFor(() => expect(["ready", "not-found-handler"]).toContain(tracker.promptState()), { timeout: 8_000 });
    expect(liveEgressInvocationCount()).toBe(1);
    return tracker;
  }

  async function runBackground(tracker: TerminalBlockTracker, path = "/"): Promise<number> {
    await vi.waitFor(() => expect(["ready", "not-found-handler"]).toContain(tracker.promptState()), { timeout: 8_000 });
    const blockId = tracker.nextBlockId();
    const line = `(test -z "\${EGRESS_TEST_API_KEY+x}" || exit 91; sleep 0.15; curl --no-buffer --silent --show-error --fail --max-time 20 --noproxy "" http://127.0.0.1:${port}${path}) & background=$!; printf 'background-started\\n'; wait "$background"`;
    writeTerminal(TAB_ID, `${line}\r`);
    await vi.waitFor(() => expect(tracker.nextBlockId(), shown).toBeGreaterThan(blockId));
    return blockId;
  }

  async function answerNext(tracker: TerminalBlockTracker, blockId: number, count: number, scope: "once" | "tab" | "deny", expectedReceived: number): Promise<void> {
    await vi.waitFor(() => expect(cards(), `${shown}; callback ${JSON.stringify(callback.mock.calls)}`).toHaveLength(count), { timeout: 10_000 });
    expect(received).toBe(expectedReceived);
    const card = cards()[count - 1]!;
    expect(tracker.get(blockId)?.output).toContain("background-started");
    expect(card).toMatchObject({
      kind: "egress-host", toolName: "terminal", args: { host: "127.0.0.1", port, tabId: TAB_ID },
      egressHost: { host: "127.0.0.1", port, terminalTabId: TAB_ID, network: "local", scopes: ["once", "tab"] },
    });
    gate.resolveFromDesktopRenderer(card.id, {
      requestId: card.id, nonce: card.nonce, hmac: card.hmac,
      choice: scope === "deny" ? "deny-once" : "allow-once",
      ...(scope === "deny" ? {} : { egressScope: scope }),
    }, wc as never);
  }

  async function completed(tracker: TerminalBlockTracker, blockId: number): Promise<ReturnType<TerminalBlockTracker["get"]>> {
    await vi.waitFor(() => expect(tracker.get(blockId)?.status, shown).toBe("done"), { timeout: 10_000 });
    return tracker.get(blockId);
  }

  async function runDetached(tracker: TerminalBlockTracker, name: string): Promise<{ blockId: number; outputPath: string; statusPath: string }> {
    await vi.waitFor(() => expect(["ready", "not-found-handler"]).toContain(tracker.promptState()), { timeout: 8_000 });
    const blockId = tracker.nextBlockId();
    const prompts = tracker.promptEndCount();
    const outputPath = join(root, `${name}.output`);
    const statusPath = join(root, `${name}.status`);
    const line = `(sleep 1; curl --silent --show-error --fail --max-time 20 --noproxy "" http://127.0.0.1:${port}/ > ${shellQuote(outputPath)} 2>&1; printf '%s\\n' "$?" > ${shellQuote(statusPath)}) & printf 'background-started\\n'`;
    writeTerminal(TAB_ID, `${line}\r`);
    await vi.waitFor(() => expect(tracker.nextBlockId(), shown).toBeGreaterThan(blockId));
    expect(await completed(tracker, blockId)).toMatchObject({ exitCode: 0 });
    await vi.waitFor(() => expect(tracker.promptEndCount(), shown).toBeGreaterThan(prompts));
    expect(existsSync(statusPath)).toBe(false);
    expect(__terminalSessionCountForTest()).toBe(1);
    expect(liveEgressInvocationCount()).toBe(1);
    return { blockId, outputPath, statusPath };
  }

  it("attributes background descendants to the owning tab, permits one connection, then denies the next without a server hit", async () => {
    const tracker = await startTerminal();
    const allowedId = await runBackground(tracker);
    await answerNext(tracker, allowedId, 1, "once", 0);
    const allowed = await completed(tracker, allowedId);
    expect(allowed).toMatchObject({ exitCode: 0 });
    expect(allowed?.output).toContain("background-connected");
    expect(received).toBe(1);
    expect(await listEgressGrants()).toEqual([]);
    expect(callback.mock.calls).toEqual(expect.arrayContaining([
      [expect.objectContaining({ host: "127.0.0.1", port }), expect.objectContaining({ identity: "listener", phase: "resolved" })],
    ]));

    const deniedId = await runBackground(tracker);
    await answerNext(tracker, deniedId, 2, "deny", 1);
    const denied = await completed(tracker, deniedId);
    expect(denied?.exitCode).not.toBe(0);
    expect(denied?.output).toMatch(/403|denied/iu);
    expect(received).toBe(1);
  }, 60_000);

  it("asks for detached background requests after the foreground block finishes and the prompt returns", async () => {
    const tracker = await startTerminal();
    const allowed = await runDetached(tracker, "allowed");
    await answerNext(tracker, allowed.blockId, 1, "once", 0);
    await vi.waitFor(() => expect(existsSync(allowed.statusPath)).toBe(true), { timeout: 10_000 });
    expect(readFileSync(allowed.statusPath, "utf8").trim()).toBe("0");
    expect(readFileSync(allowed.outputPath, "utf8")).toContain("background-connected");
    expect(received).toBe(1);
    expect(await listEgressGrants()).toEqual([]);

    const denied = await runDetached(tracker, "denied");
    await answerNext(tracker, denied.blockId, 2, "deny", 1);
    await vi.waitFor(() => expect(existsSync(denied.statusPath)).toBe(true), { timeout: 10_000 });
    expect(readFileSync(denied.statusPath, "utf8").trim()).not.toBe("0");
    expect(readFileSync(denied.outputPath, "utf8")).toMatch(/403|denied/iu);
    expect(received).toBe(1);
  }, 60_000);

  it("reuses a tab grant, revokes its live connection, and removes a renewed grant when that terminal closes", async () => {
    const tracker = await startTerminal();
    const firstId = await runBackground(tracker);
    await answerNext(tracker, firstId, 1, "tab", 0);
    expect(await completed(tracker, firstId)).toMatchObject({ exitCode: 0 });
    expect(await listEgressGrants()).toContainEqual(expect.objectContaining(target()));

    const streamId = await runBackground(tracker, "/stream");
    await vi.waitFor(() => expect(tracker.get(streamId)?.output, shown).toContain("stream-connected"), { timeout: 10_000 });
    expect(cards()).toHaveLength(1);
    expect(received).toBe(2);
    expect(await revokeEgressGrant(target())).toMatchObject({ removed: true, closed: 1 });
    await vi.waitFor(() => expect(streamClosed).toBe(1));
    expect((await completed(tracker, streamId))?.exitCode).not.toBe(0);

    const renewedId = await runBackground(tracker);
    await answerNext(tracker, renewedId, 2, "tab", 2);
    expect(await completed(tracker, renewedId)).toMatchObject({ exitCode: 0 });
    expect(received).toBe(3);
    killTerminal(TAB_ID);
    await vi.waitFor(() => expect(__terminalSessionCountForTest()).toBe(0), { timeout: 10_000 });
    expect(liveEgressInvocationCount()).toBe(0);
    expect(await listEgressGrants()).not.toContainEqual(expect.objectContaining(target()));

    const replacement = await startTerminal();
    const deniedId = await runBackground(replacement);
    await answerNext(replacement, deniedId, 3, "deny", 3);
    expect((await completed(replacement, deniedId))?.exitCode).not.toBe(0);
    expect(received).toBe(3);
  }, 60_000);
});
