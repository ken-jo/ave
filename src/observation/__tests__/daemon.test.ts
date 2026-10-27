import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObservationDaemon } from "../daemon.js";
import type { DocumentObservationEvent, ObservationEventEnvelope } from "../../shared/agent-observation.js";
import type { PreviewTableDocument } from "../../shared/preview-document.js";

const daemons: ObservationDaemon[] = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.dispose();
  vi.useRealTimers();
});
const tick = () => vi.runAllTimersAsync();
function fixture() {
  const daemon = new ObservationDaemon();
  daemons.push(daemon);
  daemon.registerAdapter({ source: "document", dispose: () => undefined });
  const events: DocumentObservationEvent[] = [];
  daemon.registerTarget({ id: "view", path: "/workspace/book.xlsx" }, "session", () => true, (batch) => events.push(...batch));
  return { daemon, events };
}
function element(row: number, after: string) {
  return { kind: "element" as const, element: { kind: "cell" as const, sheet: "Sheet1", row, column: 0 },
    before: "original", after, advisory: true };
}

describe("observation daemon delivery", () => {
  it("releases a failed delivery and exposes an internal callback failure", async () => {
    const daemon = new ObservationDaemon();
    daemons.push(daemon);
    daemon.registerAdapter({ source: "document", dispose: () => undefined });
    daemon.registerTarget({ id: "failing-view", path: "/workspace/value.txt" }, "session", () => true,
      () => { throw new Error("Observation delivery contract failed."); });
    daemon.publish("failing-view", element(0, "value"));
    await expect(tick()).rejects.toThrow("Observation delivery contract failed.");
    expect(daemon.publish("failing-view", element(0, "late"))).toBeUndefined();
  });

  it("releases a native delivery whose frame expired during send", async () => {
    const daemon = new ObservationDaemon();
    daemons.push(daemon);
    let current = true;
    daemon.registerAdapter({ source: "document", dispose: () => undefined });
    daemon.registerTarget({ id: "expired-view", path: "/workspace/value.txt" }, "session", () => current,
      () => { current = false; throw new Error("Native frame was destroyed."); });
    daemon.publish("expired-view", element(0, "value"));
    await tick();
    expect(daemon.publish("expired-view", element(0, "late"))).toBeUndefined();
  });

  it("stamps local agent identity and coalesces pending elements", async () => {
    const { daemon, events } = fixture();
    daemon.publish("view", element(0, "first"));
    daemon.publish("view", element(0, "latest"));
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ source: "document", actor: "agent", sessionId: "session",
      target: { id: "view", path: "/workspace/book.xlsx" }, seq: 2, kind: "element", after: "latest" });
    expect(events[0].ts).toBeGreaterThan(0);
  });

  it("coalesces text lines by their own address without merging cells or other lines", async () => {
    const { daemon, events } = fixture();
    daemon.publish("view", { kind: "element", element: { kind: "line", line: 1 }, before: "one", after: "draft", advisory: false });
    daemon.publish("view", { kind: "element", element: { kind: "line", line: 2 }, before: "two", after: "second", advisory: false });
    daemon.publish("view", { kind: "element", element: { kind: "line", line: 1 }, before: "one", after: "final", advisory: false });
    daemon.publish("view", element(0, "cell"));
    await tick();
    expect(events).toMatchObject([
      { seq: 2, element: { kind: "line", line: 2 }, after: "second" },
      { seq: 3, element: { kind: "line", line: 1 }, after: "final" },
      { seq: 4, element: { kind: "cell", row: 0, column: 0 }, after: "cell" },
    ]);
  });

  it("bounds in-flight events until an actual delivery acknowledgement", async () => {
    const { daemon, events } = fixture();
    for (let row = 0; row < 100; row += 1) daemon.publish("view", element(row, "changed"));
    await tick();
    expect(events).toHaveLength(64);
    expect(daemon.acknowledge("view", 64)).toHaveLength(64);
    await tick();
    expect(events).toHaveLength(100);
    expect(() => daemon.acknowledge("view", 101)).toThrow("Invalid observation acknowledgement.");
  });

  it("signals resynchronization on overload and retains the authoritative snapshot", async () => {
    const { daemon, events } = fixture();
    for (let row = 0; row < 300; row += 1) daemon.publish("view", element(row, "changed"));
    const document = { format: "xlsx", needsRecalculation: true } as PreviewTableDocument;
    daemon.publish("view", { kind: "snapshot", before: null, after: document });
    await tick();
    expect(events.some((event) => event.kind === "status" && event.after.code === "resync-required")).toBe(true);
    expect(events.some((event) => event.kind === "snapshot" && event.after.format !== "text" && event.after.needsRecalculation)).toBe(true);
    expect(events.length).toBeLessThanOrEqual(64);
  });

  it("releases a target when the owning frame is no longer current", async () => {
    const daemon = new ObservationDaemon();
    daemons.push(daemon);
    daemon.registerAdapter({ source: "document", dispose: () => undefined });
    const events: DocumentObservationEvent[] = [];
    let current = true;
    daemon.registerTarget({ id: "view", path: "/workspace/book.xlsx" }, "session", () => current, (batch) => events.push(...batch));
    daemon.publish("view", element(0, "changed"));
    current = false;
    await tick();
    expect(events).toEqual([]);
    expect(daemon.publish("view", element(0, "later"))).toBeUndefined();
  });

  it("rejects duplicate adapter registration and disposes each source", () => {
    const daemon = new ObservationDaemon();
    let disposed = 0;
    const adapter = { source: "document" as const, dispose: () => { disposed += 1; } };
    daemon.registerAdapter(adapter);
    expect(() => daemon.registerAdapter(adapter)).toThrow("Observation adapter already registered.");
    daemon.dispose();
    daemon.dispose();
    expect(disposed).toBe(1);
  });

  it("derives a future adapter source from its registered target", async () => {
    type FutureEvent = ObservationEventEnvelope & { source: "terminal"; kind: "status"; before: null; after: { state: string } };
    const daemon = new ObservationDaemon();
    daemons.push(daemon);
    const events: FutureEvent[] = [];
    expect(() => daemon.registerTarget<FutureEvent>({ id: "future", path: "local-target" }, "session", () => true,
      (batch) => events.push(...batch), "terminal")).toThrow("Observation source is not registered.");
    daemon.registerAdapter({ source: "terminal", dispose: () => undefined });
    daemon.registerTarget<FutureEvent>({ id: "future", path: "local-target" }, "session", () => true,
      (batch) => events.push(...batch), "terminal");
    daemon.publish<FutureEvent>("future", { kind: "status", before: null, after: { state: "ready" } });
    await tick();
    expect(events).toMatchObject([{ source: "terminal", actor: "agent", sessionId: "session", after: { state: "ready" } }]);
  });

  it("retains only one unacknowledged snapshot before sending the next", async () => {
    const { daemon, events } = fixture();
    const document = { format: "xlsx", needsRecalculation: true } as PreviewTableDocument;
    daemon.publish("view", { kind: "snapshot", before: null, after: document });
    await tick();
    daemon.publish("view", { kind: "snapshot", before: null, after: document });
    daemon.publish("view", { kind: "snapshot", before: null, after: document });
    await tick();
    expect(events).toHaveLength(1);
    daemon.acknowledge("view", 1);
    await tick();
    expect(events.map((event) => event.seq)).toEqual([1, 3]);
  });
});
