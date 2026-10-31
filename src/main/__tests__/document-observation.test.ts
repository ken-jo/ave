import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { DocumentObservationEvent, DocumentObservationEngine } from "../../shared/agent-observation.js";
import type { PreviewTableDocument } from "../../shared/preview-document.js";
import { observeAgentDocumentMutation, runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../../tools/agent-observation-context.js";
import { createSandboxProcessHome } from "../../permissions/sandbox-process-home.js";
import { parseObservedTextDocument } from "../../observation/text-document.js";
import type { ObservationDaemon } from "../../observation/daemon.js";
import { OBSERVATION_LIMITS, type TerminalObservationEvent } from "../../shared/agent-observation.js";

const state = vi.hoisted(() => ({ defaultSession: {}, holder: null as unknown, root: "", registered: true }));
vi.mock("electron", () => ({ session: { defaultSession: state.defaultSession } }));
vi.mock("../app-state.js", () => ({ findSessionMainWindowContents: (id: string) => id === "session-one" ? state.holder : null }));
vi.mock("../../permissions/permission-settings-store.js", () => ({ readPermissionSettings: () => ({ permissions: { additionalDirectories: [state.root] } }) }));
import { DocumentObservationRuntime } from "../document-observation.js";

function table(value: string): PreviewTableDocument {
  return { format: "csv", needsRecalculation: false, sheetNames: ["Sheet1"], totalSheets: 1, sheetsTruncated: false,
    sheet: { index: 0, name: "Sheet1", rows: [[value]], firstRow: 0, firstColumn: 0, totalRows: 1, totalColumns: 1,
      rowsTruncated: false, columnsTruncated: false, cellsTruncated: false, clippedCells: [] } };
}
const engine: DocumentObservationEngine = { id: "table-reader", parse: async (bytes) => table(bytes.toString("utf8")) };
let runtime: DocumentObservationRuntime;
let path: string;
const frame = { url: "file:///app/index.html", detached: false, isDestroyed: () => false };
const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame, isDestroyed: () => false,
  getType: () => "window", session: state.defaultSession, send: vi.fn() });
const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
const deps = { getAppWindows: () => state.registered ? [{ isDestroyed: () => false, webContents: sender }] : [], getMainWindow: () => null } as never;
const events = (): DocumentObservationEvent[] => sender.send.mock.calls.flatMap((call) => call[1] as DocumentObservationEvent[]);
const identity = { sessionId: "session-one", turnId: "turn-one", toolUseId: "tool-one" };

function baseline() {
  const binding = runtime.registerView(event, "session-one", path, Buffer.from("old"), table("old"));
  if (!binding) throw new Error("Missing observation baseline");
  expect(runtime.acknowledge(event, { action: "rendered", ...binding })).toEqual({ ok: true });
  return binding;
}
async function agentWrite(value: string) {
  return runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity, () =>
    observeAgentDocumentMutation([{ path, content: value }], async () => { writeFileSync(path, value); })));
}

beforeEach(() => {
  state.root = mkdtempSync(join(tmpdir(), "ave-observation-host-"));
  path = join(state.root, "values.csv");
  writeFileSync(path, "old");
  state.holder = sender;
  state.registered = true;
  sender.send.mockClear();
  runtime = new DocumentObservationRuntime(deps, engine);
});
afterEach(async () => { runtime.dispose(); await cleanupTmpDir(state.root); });

describe("document observation desktop ownership", () => {
  it("releases prepared runtimes after the final opening lease when no rendered view exists", async () => {
    runtime.dispose();
    const releaseSession = vi.fn();
    const prepare = vi.fn().mockResolvedValue(undefined);
    runtime = new DocumentObservationRuntime(deps, { ...engine, prepare, releaseSession });
    const first = runtime.acquireEnginePreparation("session-one", path, new AbortController().signal)!;
    const second = runtime.acquireEnginePreparation("session-one", path, new AbortController().signal)!;
    await Promise.all([first.ready, second.ready]);
    first.release();
    expect(releaseSession).not.toHaveBeenCalled();
    second.release();
    expect(releaseSession).toHaveBeenCalledExactlyOnceWith("session-one");
    expect(events()).toEqual([]);
  });

  it("keeps a prepared runtime owned by the rendered view after opening completes", async () => {
    runtime.dispose();
    const releaseSession = vi.fn();
    runtime = new DocumentObservationRuntime(deps, { ...engine, prepare: async () => {}, releaseSession });
    const preparation = runtime.acquireEnginePreparation("session-one", path, new AbortController().signal)!;
    await preparation.ready;
    const binding = baseline();
    preparation.release();
    expect(releaseSession).not.toHaveBeenCalled();
    runtime.release(binding.targetId);
    expect(releaseSession).toHaveBeenCalledExactlyOnceWith("session-one");
  });

  function textBaseline(engineAvailable = true) {
    runtime.dispose();
    runtime = new DocumentObservationRuntime(deps, engineAvailable ? {
      id: "text-reader", parse: async (bytes) => parseObservedTextDocument(bytes),
    } : null);
    path = join(state.root, "value.ts");
    const bytes = Buffer.from("const value = 1;\nexport { value };\n");
    writeFileSync(path, bytes);
    const binding = runtime.registerView(event, "session-one", path, bytes, parseObservedTextDocument(bytes))!;
    expect(runtime.acknowledge(event, { action: "rendered", ...binding })).toEqual({ ok: true });
    return binding;
  }

  it("streams native agent text edits as lines through the existing observation binding", async () => {
    textBaseline();
    await agentWrite("const value = 42;\nexport const ready = true;\n");
    await vi.waitFor(() => expect(events().some((entry) => entry.kind === "snapshot")).toBe(true));
    expect(events().filter((entry) => entry.kind === "element")).toMatchObject([
      { actor: "agent", before: "const value = 1;", after: "const value = 42;", advisory: false, element: { kind: "line", line: 1 } },
      { actor: "agent", before: "export { value };", after: "export const ready = true;", advisory: false, element: { kind: "line", line: 2 } },
    ]);
    expect(events().find((entry) => entry.kind === "snapshot")).toMatchObject({ after: {
      format: "text", content: "const value = 42;\nexport const ready = true;", lines: ["const value = 42;", "export const ready = true;"],
      totalLines: 2, truncated: false,
    } });
  });

  it("never streams a user-only text save or another session's mutation", async () => {
    textBaseline();
    writeFileSync(path, "private user line");
    await runWithAgentObservationTurn({ ...identity, sessionId: "another-session" }, () =>
      runWithAgentObservationInvocation({ ...identity, sessionId: "another-session" }, () =>
        observeAgentDocumentMutation([{ path, content: "other session" }], async () => { writeFileSync(path, "other session"); })));
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(events()).toEqual([]);
  });

  it("refuses a prior user text revision without publishing its contents", async () => {
    textBaseline();
    writeFileSync(path, "private user line");
    await agentWrite("agent line");
    await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({ kind: "status", after: { code: "reload-required" } })));
    expect(events().filter((entry) => entry.kind !== "status")).toEqual([]);
    expect(JSON.stringify(events())).not.toContain("private user line");
  });

  it("uses the explicit existing-viewer fallback when the text engine is absent", async () => {
    textBaseline(false);
    await agentWrite("agent line");
    await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({ kind: "status", after: { code: "engine-unavailable" } })));
    expect(events().filter((entry) => entry.kind !== "status")).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("agent line");
  });

  it("holds an agent table open until the initial grid is acknowledged as rendered", async () => {
    let settled = false;
    const ready = runtime.waitForRendered(identity, path, Date.now() + 1_000).then((value) => { settled = true; return value; });
    const binding = runtime.registerView(event, "session-one", path, Buffer.from("old"), table("old"))!;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(runtime.acknowledge(event, { action: "rendered", ...binding })).toEqual({ ok: true });
    expect(await ready).toBe(true);
    expect(await runtime.waitForRendered(identity, path, Date.now() + 1_000)).toBe(true);
  });

  it("expires a missing initial grid within the original open deadline", async () => {
    vi.useFakeTimers();
    try {
      const ready = runtime.waitForRendered(identity, path, Date.now() + 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await ready).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("rejects expired readiness even when timers have not run and a baseline exists", async () => {
    vi.useFakeTimers();
    try {
      const deadline = Date.now() + 100;
      const ready = runtime.waitForRendered(identity, path, deadline);
      vi.setSystemTime(deadline + 1);
      baseline();
      expect(await ready).toBe(false);
      expect(await runtime.waitForRendered(identity, path, deadline)).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("releases cancelled readiness waiters before admitting another open", async () => {
    for (let index = 0; index < 20; index++) {
      const controller = new AbortController();
      const ready = runtime.waitForRendered(identity, path, Date.now() + 1_000, controller.signal);
      controller.abort();
      expect(await ready).toBe(false);
    }
    const ready = runtime.waitForRendered(identity, path, Date.now() + 1_000);
    baseline();
    expect(await ready).toBe(true);
  });

  it("does not turn a user-opened baseline or user save into agent content", async () => {
    baseline();
    writeFileSync(path, "private user value");
    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(events()).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("private user value");
  });

  it("enrolls an already open file when the admitted agent actually writes it", async () => {
    baseline();
    await agentWrite("agent value");
    await vi.waitFor(() => expect(events().some((entry) => entry.kind === "snapshot")).toBe(true));
    expect(events().find((entry) => entry.kind === "element")).toMatchObject({ source: "document", actor: "agent", sessionId: "session-one",
      before: "old", after: "agent value", advisory: false, element: { kind: "cell", sheet: "Sheet1", row: 0, column: 0 } });
    expect(events().find((entry) => entry.kind === "snapshot")).toMatchObject({ after: { sheet: { rows: [["agent value"]] } } });
  });

  it("retains exact known mutation targets only until their agent turn ends", async () => {
    runtime.dispose();
    runtime = new DocumentObservationRuntime(deps, null);
    let binding!: ReturnType<DocumentObservationRuntime["registerView"]>;
    await runWithAgentObservationTurn(identity, async () => {
      await runWithAgentObservationInvocation(identity, () => observeAgentDocumentMutation([{ path, content: "agent value" }], async () => {
        writeFileSync(path, "agent value");
      }));
      // A previously unopened target gains scope when its actual view is rendered.
      binding = runtime.registerView(event, "session-one", path, Buffer.from("agent value"), table("agent value"));
      expect(binding).toBeDefined();
      expect(runtime.acknowledge(event, { action: "rendered", ...binding })).toEqual({ ok: true });
      await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({ kind: "status", after: { code: "engine-unavailable" } })));
    });
    expect(runtime.acknowledge(event, { action: "release", ...binding })).toEqual({ ok: true });
    sender.send.mockClear();
    const userView = runtime.registerView(event, "session-one", path, Buffer.from("agent value"), table("agent value"))!;
    expect(runtime.acknowledge(event, { action: "rendered", ...userView })).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events()).toEqual([]);
  });

  it("refuses to fold a prior user save into an agent diff", async () => {
    baseline();
    writeFileSync(path, "private user value");
    await agentWrite("agent value");
    await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({ kind: "status", after: { code: "reload-required" } })));
    expect(events().filter((entry) => entry.kind !== "status")).toEqual([]);
    expect(JSON.stringify(events())).not.toContain("private user value");
  });

  it("does not attribute a user save merely because an agent tool is running", async () => {
    baseline();
    runtime.markAgentDocument(identity, path);
    await runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity, async () => {
      writeFileSync(path, "private concurrent save");
      await new Promise((resolve) => setTimeout(resolve, 140));
    }));
    expect(events().filter((entry) => entry.kind !== "status")).toEqual([]);
    expect(JSON.stringify(events())).not.toContain("private concurrent save");
  });

  it("cannot acknowledge another frame or session and accepts no extra path field", () => {
    const binding = baseline();
    const subframe = { ...event, senderFrame: { ...frame } } as unknown as IpcMainInvokeEvent;
    expect(runtime.acknowledge(subframe, { action: "rendered", ...binding })).toEqual({ ok: false, error: "unauthorized" });
    expect(runtime.acknowledge(event, { action: "rendered", ...binding, sessionId: "other-session" })).toEqual({ ok: false, error: "unauthorized" });
    expect(runtime.acknowledge(event, { action: "rendered", ...binding, path: "/outside/other.csv" })).toEqual({ ok: false, error: "bad-request" });
  });

  it("rechecks live registration before delivering a completed parse", async () => {
    runtime.dispose();
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const parse = vi.fn(async (bytes: Buffer) => { await gate; return table(bytes.toString()); });
    runtime = new DocumentObservationRuntime(deps, { id: "table-reader", parse });
    baseline();
    const saving = agentWrite("agent value");
    // Generous timeout: the parse callback can be starved under full-suite worker concurrency.
    await vi.waitFor(() => expect(parse).toHaveBeenCalledTimes(1), { timeout: 5000, interval: 20 });
    state.registered = false;
    sender.send.mockClear();
    finish();
    await saving;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events()).toEqual([]);
  });

  it("answers busy at the limit it shares with terminal and browser targets, leaving no view owner behind", () => {
    // The runtime's one daemon also holds terminal and browser targets; fill it with non-document ones.
    const daemon = (runtime as unknown as { daemon: ObservationDaemon }).daemon;
    const others = Array.from({ length: OBSERVATION_LIMITS.maxViews }, (_, index) => `terminal-target-${index}`);
    for (const id of others) daemon.registerTarget<TerminalObservationEvent>({ id, path: "terminal-activity" }, "session-one", () => true, () => {}, "terminal");
    const listeners = () => ["destroyed", "render-process-gone", "did-frame-navigate"].map((name) => sender.listenerCount(name));
    const before = listeners();
    const open = () => runtime.registerView(event, "session-one", path, Buffer.from("old"), table("old"));
    expect(open).toThrow(expect.objectContaining({ code: "busy" }));
    // Admission refused after the precheck (a target taken in between) rolls back the same way.
    vi.spyOn(daemon, "hasCapacity").mockReturnValueOnce(true);
    expect(open).toThrow(expect.objectContaining({ code: "busy" }));
    expect(listeners()).toEqual(before);
    expect((runtime as unknown as { views: Map<string, unknown> }).views.size).toBe(0);
    // Room freed by another source admits the document view.
    daemon.release(others[0]!);
    expect(open()).toMatchObject({ sessionId: "session-one", seq: 0 });
    expect(listeners()).toEqual(before.map((count) => count + 1));
  });

  it("keeps a deterministic existing-viewer fallback when the engine is absent", async () => {
    runtime.dispose();
    runtime = new DocumentObservationRuntime(deps, null);
    baseline();
    runtime.markAgentDocument(identity, path);
    await vi.waitFor(() => expect(events()).toContainEqual(expect.objectContaining({ kind: "status", after: { code: "engine-unavailable" } })));
    expect(events().filter((entry) => entry.kind !== "status")).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("old");
  });

  it("drains more than one journal read before the actual shell HOME is removed", async () => {
    baseline();
    await runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity, async () => {
      const home = createSandboxProcessHome();
      try {
        const records: unknown[] = [{ v: 1, kind: "begin", editId: "burst-edit", target: path,
          beforeHash: "cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4" }];
        for (let index = 0; index < 100; index++) records.push({ v: 1, kind: "cell", editId: "burst-edit",
          sheet: "Sheet1", cell: "A1", before: "old", after: "a".repeat(1_000) });
        records.push({ v: 1, kind: "commit", editId: "burst-edit",
          afterHash: "62186ad02cb3a125b134d34741cc3b149846733e5cbdb0ded4edd2361e409d91" });
        const journal = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
        expect(Buffer.byteLength(journal)).toBeGreaterThan(65_536);
        writeFileSync(home.env.AVE_DOCUMENT_JOURNAL!, journal);
        writeFileSync(path, "agent value");
      } finally { home.cleanup(); }
    }));
    await vi.waitFor(() => expect(events().some((entry) => entry.kind === "snapshot")).toBe(true));
    expect(events().findLast((entry) => entry.kind === "snapshot")).toMatchObject({ after: { sheet: { rows: [["agent value"]] } } });
    expect(events().filter((entry) => entry.kind === "status").map((entry) => entry.after.code)).not.toContain("observation-error");
  });

  it("revokes an existing journal when its model turn ends before the tool settles", async () => {
    baseline();
    let started!: () => void;
    let finish!: () => void;
    let homePath = "";
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    let pending!: Promise<void>;
    await runWithAgentObservationTurn(identity, async () => {
      pending = runWithAgentObservationInvocation(identity, async () => {
        const home = createSandboxProcessHome();
        homePath = home.path;
        started();
        try { await gate; }
        finally { home.cleanup(); }
      });
      await ready;
    });
    try {
      writeFileSync(join(homePath, "document-observation", "journal.jsonl"), [
        { v: 1, kind: "begin", editId: "late-edit", target: path, beforeHash: "cba06b5736faf67e54b07b561eae94395e774c517a7d910a54369e1263ccfbd4" },
        { v: 1, kind: "cell", editId: "late-edit", sheet: "Sheet1", cell: "A1", before: "old", after: "agent value" },
        { v: 1, kind: "commit", editId: "late-edit", afterHash: "62186ad02cb3a125b134d34741cc3b149846733e5cbdb0ded4edd2361e409d91" },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n");
      writeFileSync(path, "agent value");
      await new Promise((resolve) => setTimeout(resolve, 180));
      expect(events().filter((entry) => entry.kind !== "status")).toEqual([]);
    } finally { finish(); await pending; }
  });
});
