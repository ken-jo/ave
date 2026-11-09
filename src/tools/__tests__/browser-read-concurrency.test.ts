import { deferred } from "../../__tests__/support/deferred.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { BrowserTabRegistry, type BrowserGuest } from "../../main/browser/browser-tab-registry.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { __resetSessionStoreForTest } from "../../permissions/user-approval-store.js";
import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { BROWSER_TOOL } from "../../shared/browser-tools.js";
import { createBrowserTools, type BrowserActionTab, type BrowserPageActions } from "../browser-tools.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { userPermissionContext } from "./tool-context-fixture.js";

class PageGuest implements BrowserGuest {
  constructor(readonly id: number, public url = "about:blank") {}
  isDestroyed() { return false; }
  getURL() { return this.url; }
  getTitle() { return "Read page"; }
}


const SESSION_ID = "read-conversation";

describe("browser read concurrency", () => {
  let directory: string;
  let previousAveHome: string | undefined;
  let auditLogger: AuditLogger;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "ave-browser-read-"));
    previousAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = directory;
    __resetSessionStoreForTest();
    auditLogger = new AuditLogger(join(directory, "audit"));
  });
  afterEach(async () => {
    await auditLogger.close();
    if (previousAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previousAveHome;
    __resetSessionStoreForTest();
    await cleanupTmpDir(directory);
  });

  async function harness() {
    const tabs = new BrowserTabRegistry<PageGuest>();
    let requestId: string | undefined;
    tabs.setRendererLink({ sendTabOp: (_window, op) => { if (op.op === "new") requestId = op.requestId; return true; }, sendControl: () => {} });
    const addTab = async (id: number) => {
      const opening = tabs.requestTabOp(1, { op: "new", url: "https://read.example/", actor: { sessionId: SESSION_ID } });
      const guest = new PageGuest(id);
      tabs.guestAttached(guest, 1);
      if (!requestId) throw new Error("Fixture tab request was not sent");
      const bound = tabs.bindTab(1, { tabId: `renderer-${id}`, webContentsId: id, requestId });
      if (!bound.ok) throw new Error(`Could not bind fixture tab: ${bound.error}`);
      const opened = await opening;
      if (!opened.ok) throw new Error("Could not open fixture tab");
      guest.url = "https://read.example/";
      const tab = tabs.liveTab(opened.tabId);
      if (!tab) throw new Error("Fixture tab was not registered");
      return tab;
    };
    const first = await addTab(101);
    const second = await addTab(102);
    const calls: string[] = [];
    let read = async (_target: BrowserActionTab<PageGuest>) => {};
    const record = async (target: BrowserActionTab<PageGuest>) => { calls.push(target.tab.handle); await read(target); };
    const pageUrl = (target: BrowserActionTab<PageGuest>) => {
      const guest = target.tab.guest;
      if (!guest) throw new Error("Fixture page is unavailable");
      return guest.getURL();
    };
    const actions: BrowserPageActions<PageGuest> = {
      prepare: async () => {},
      snapshot: async (target) => { await record(target); return { url: pageUrl(target), title: "Read", text: "- heading Read", truncated: false, refCount: 0, delta: false }; },
      screenshot: async (target) => { await record(target); return { data: "aW1hZ2U=", mimeType: "image/png", bytes: 5 }; },
      waitFor: async (target) => { await record(target); return { found: true, waitedMs: 1, reason: "text-found", loading: false }; },
      click: async () => { calls.push("mutation"); }, hover: async () => {}, drag: async () => {}, select: async () => {}, scroll: async () => {},
      upload: async () => ({ status: "cancelled", files: [], count: 0, bytes: 0 }), type: async () => {}, pressKey: async () => {},
      settle: async (target) => ({ url: pageUrl(target), loading: false }),
      navigate: async (_target, url) => ({ url, loading: false }),
    };
    const deps = {
      tabs, windowIdForHostedSession: (session: string) => session === SESSION_ID ? 1 : null,
      liveOriginSessionId: () => undefined, pickUploadFiles: async () => null, opensAgentTabs: () => true,
      loadActions: async () => actions,
    };
    const tools = createBrowserTools(deps);
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    const manager = new PermissionManager(join(directory, "permissions.json"));
    manager.setMode("allow");
    const sender = { isDestroyed: () => false, send: (channel: string, request: ApprovalRequest) => {
      if (channel !== "ave:approval:request") return;
      gate.resolveFromDesktopRenderer(request.id, { requestId: request.id, choice: "allow-once", nonce: request.nonce, hmac: request.hmac }, sender as never);
    } };
    const gate = new ApprovalGate(sender as never);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, auditLogger);
    const options = { sessionId: SESSION_ID, executionCwd: directory, permissionContext: userPermissionContext({ additionalDirectories: [directory] }) };
    const batch = (names: Array<{ name: string; tabId?: string }>) => executor.executeConversationBatch(names.map((item, index) => ({ id: `read-${index}`, name: item.name, input: { ...(item.tabId ? { tabId: item.tabId } : {}), ...(item.name === BROWSER_TOOL.wait ? { text: "Ready" } : {}), ...(item.name === BROWSER_TOOL.click ? { ref: "e1" } : {}) } })), options);
    const direct = (toolSet: typeof tools, name: string, tabId?: string, abortSignal?: AbortSignal) => {
      const selected = tabId ? tabs.liveTab(tabId) : first;
      if (!selected) throw new Error("Fixture target is unavailable");
      const tool = toolSet.find((item) => item.name === name);
      if (!tool) throw new Error("Fixture tool is not registered");
      return tool.execute({ ...(tabId ? { tabId } : {}), ...(name === BROWSER_TOOL.wait ? { text: "Ready" } : {}) }, {
        cwd: directory, extraAllowedDirectories: [], metadata: { sessionId: SESSION_ID, approvalMemoryScope: {
          kind: "browser-origin", origin: "https://read.example:443", tabOpener: "agent", tabId: selected.handle,
          documentId: selected.documentId, controlGeneration: selected.controlGeneration,
        } }, ...(abortSignal ? { abortSignal } : {}),
      });
    };
    return { denySnapshots: () => manager.setRules([{ pattern: BROWSER_TOOL.snapshot, action: "deny" }]), setContext: (context: typeof options.permissionContext) => { options.permissionContext = context; }, tabs, first, second, calls, tools, batch, direct, anotherTools: () => createBrowserTools(deps), setRead: (handler: typeof read) => { read = handler; } };
  }

  it.each(["revoked-while-queued", "refresh-denied", "revoked-during-refresh"] as const)("refuses a queued remote read when authority is %s", async (reason) => {
    const h = await harness();
    const started = deferred<void>();
    const pending = deferred<void>();
    h.setRead(async () => { started.resolve(); await pending.promise; });
    const first = h.direct(h.tools, BROWSER_TOOL.wait, h.first.handle);
    await started.promise;
    let current = true;
    let refreshAllowed = true;
    let revokeDuringRefresh = false;
    const authority = bindRemoteControllerToSession({
      kind: "tailnet-controller", actorId: "tailnet:read-fixture",
      pairedShare: { pairingId: "read-pair", pairingEpoch: 1, shareId: "read-share", shareEpoch: 1, scope: "read-scope" },
      pairedShareGuard: {
        isCurrent: () => current,
        refreshCurrent: async () => { if (revokeDuringRefresh) current = false; return refreshAllowed; },
      },
    }, SESSION_ID);
    h.setContext(userPermissionContext({ trustOrigin: "tailnet-surface", remoteControllerAuthority: authority, additionalDirectories: [directory] }));
    const tool = h.tools.find((item) => item.name === BROWSER_TOOL.snapshot);
    if (!tool) throw new Error("Fixture snapshot tool is not registered");
    const execute = vi.spyOn(tool, "execute");
    const queued = h.batch([{ name: BROWSER_TOOL.snapshot, tabId: h.first.handle }]);
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      if (reason === "revoked-while-queued") current = false;
      else if (reason === "refresh-denied") refreshAllowed = false;
      else revokeDuringRefresh = true;
    } finally { pending.resolve(); }
    await first;
    const outcome = await queued;
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome !== "completed") throw new Error("Unexpected batch suspension");
    const result = outcome.results[0];
    if (!result) throw new Error("Queued read result is missing");
    expect(result.is_error).toBe(true);
    expect(h.calls).toEqual([h.first.handle]);
  });

  it("refuses a queued read after a policy deny rule is installed", async () => {
    const h = await harness();
    const started = deferred<void>();
    const pending = deferred<void>();
    h.setRead(async () => { started.resolve(); await pending.promise; });
    const first = h.direct(h.tools, BROWSER_TOOL.wait, h.first.handle);
    await started.promise;
    const tool = h.tools.find((item) => item.name === BROWSER_TOOL.snapshot);
    if (!tool) throw new Error("Fixture snapshot tool is not registered");
    const execute = vi.spyOn(tool, "execute");
    const queued = h.batch([{ name: BROWSER_TOOL.snapshot, tabId: h.first.handle }]);
    try {
      await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
      h.denySnapshots();
    } finally { pending.resolve(); }
    await first;
    const outcome = await queued;
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome !== "completed") throw new Error("Unexpected batch suspension");
    const result = outcome.results[0];
    if (!result) throw new Error("Queued read result is missing");
    expect(result.is_error).toBe(true);
    expect(h.calls).toEqual([h.first.handle]);
  });

  it("declares only page observations parallel safe", async () => {
    const h = await harness();
    expect(h.tools.filter((tool) => tool.parallelSafe).map((tool) => tool.name)).toEqual([BROWSER_TOOL.snapshot, BROWSER_TOOL.screenshot, BROWSER_TOOL.wait]);
  });

  it("starts different physical guests in one executor batch before either read finishes", async () => {
    const h = await harness();
    const pending = deferred<void>();
    h.setRead(() => pending.promise);
    const running = h.batch([{ name: BROWSER_TOOL.wait, tabId: h.first.handle }, { name: BROWSER_TOOL.snapshot, tabId: h.second.handle }]);
    try { await vi.waitFor(() => expect(h.calls).toHaveLength(2), { timeout: 250 }); }
    finally { pending.resolve(); }
    const outcome = await running;
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome === "completed") expect(outcome.results.every((result) => !result.is_error)).toBe(true);
  });

  it("orders same-guest reads across fresh tool adapters and implicit aliases", async () => {
    const h = await harness();
    const started = deferred<void>();
    const pending = deferred<void>();
    h.setRead(async () => { started.resolve(); await pending.promise; });
    const first = h.direct(h.tools, BROWSER_TOOL.wait, h.first.handle);
    await started.promise;
    const second = h.direct(h.anotherTools(), BROWSER_TOOL.screenshot);
    await new Promise<void>((resolve) => setImmediate(resolve));
    try { expect(h.calls).toEqual([h.first.handle]); }
    finally { pending.resolve(); }
    expect((await Promise.all([first, second])).every((result) => !result.isError)).toBe(true);
    expect(h.calls).toEqual([h.first.handle, h.first.handle]);
  });

  it("cancels a queued read promptly without dispatching it later", async () => {
    const h = await harness();
    const started = deferred<void>();
    const pending = deferred<void>();
    h.setRead(async () => { started.resolve(); await pending.promise; });
    const first = h.direct(h.tools, BROWSER_TOOL.wait, h.first.handle);
    await started.promise;
    const controller = new AbortController();
    const queued = h.direct(h.tools, BROWSER_TOOL.snapshot, h.first.handle, controller.signal);
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("Read cancelled"));
    try { expect((await queued).isError).toBe(true); }
    finally { pending.resolve(); }
    await first;
    expect(h.calls).toEqual([h.first.handle]);
  });

  it("orders same-guest reads inside an executor parallel segment", async () => {
    const h = await harness();
    const pending = deferred<void>();
    h.setRead(() => pending.promise);
    const running = h.batch([{ name: BROWSER_TOOL.wait, tabId: h.first.handle }, { name: BROWSER_TOOL.screenshot, tabId: h.first.handle }]);
    await vi.waitFor(() => expect(h.calls).toHaveLength(1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    try { expect(h.calls).toEqual([h.first.handle]); }
    finally { pending.resolve(); }
    const outcome = await running;
    expect(h.calls).toEqual([h.first.handle, h.first.handle]);
    expect(outcome.outcome).toBe("completed");
    if (outcome.outcome === "completed") expect(outcome.results.every((result) => !result.is_error)).toBe(true);
  });

  it.each(["guest", "document"] as const)("refuses a queued read after its %s changes", async (change) => {
    const h = await harness();
    const started = deferred<void>();
    const pending = deferred<void>();
    h.setRead(async () => { started.resolve(); await pending.promise; });
    const first = h.direct(h.tools, BROWSER_TOOL.wait, h.first.handle);
    await started.promise;
    const queued = h.direct(h.tools, BROWSER_TOOL.snapshot, h.first.handle);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (change === "guest") h.first.guest = new PageGuest(103, "https://read.example/");
    else h.first.documentId += 1;
    pending.resolve();
    expect((await queued).isError).toBe(true);
    await first;
    expect(h.calls).toEqual([h.first.handle]);
  });

  it("refuses a read when its target was unavailable before dispatch", async () => {
    const h = await harness();
    vi.spyOn(h.tabs, "liveTabInWindow").mockReturnValueOnce(undefined);
    const result = await h.direct(h.tools, BROWSER_TOOL.snapshot, h.first.handle);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Browser target unavailable before read");
    expect(h.calls).toEqual([]);
  });

  it("releases a failed read's lane for the next read", async () => {
    const h = await harness();
    let count = 0;
    h.setRead(async () => { if (++count === 1) throw new Error("Read failed"); });
    const results = await Promise.all([h.direct(h.tools, BROWSER_TOOL.wait, h.first.handle), h.direct(h.tools, BROWSER_TOOL.snapshot, h.first.handle)]);
    expect(results.map((result) => result.isError)).toEqual([true, false]);
  });

  it("keeps a mutation between parallel read segments ordered", async () => {
    const h = await harness();
    const pending = deferred<void>();
    h.setRead(() => pending.promise);
    const running = h.batch([{ name: BROWSER_TOOL.snapshot, tabId: h.first.handle }, { name: BROWSER_TOOL.click, tabId: h.second.handle }, { name: BROWSER_TOOL.screenshot, tabId: h.second.handle }]);
    await vi.waitFor(() => expect(h.calls).toEqual([h.first.handle]));
    pending.resolve();
    await running;
    expect(h.calls).toEqual([h.first.handle, "mutation", h.second.handle]);
  });
});
