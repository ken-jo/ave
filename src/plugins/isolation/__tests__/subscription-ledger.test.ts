/** Assert registration counts on both sides for every termination path; live callbacks alone cannot reveal leaks. */
import { describe, expect, it, vi } from "vitest";
import {
  DuplicateSubscriptionError,
  SubscriptionLedger,
  SubscriptionLedgerEndedError,
} from "../subscription-ledger.js";

describe("SubscriptionLedger", () => {
  it("runs a release exactly once, however many times it is closed", () => {
    const release = vi.fn();
    const ledger = new SubscriptionLedger<string>("test");
    const id = ledger.open("a", release);

    expect(ledger.close(id, "disposed")).toBe(true);
    expect(ledger.close(id, "disposed")).toBe(false);
    expect(ledger.close(id, "peer-gone")).toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith("a", "disposed", id);
    expect(ledger.openCount).toBe(0);
  });

  it("counts live registrations by kind after release and teardown", () => {
    const ledger = new SubscriptionLedger<{ kind: "event" | "worker" }>("test");
    ledger.adopt("event-1", { kind: "event" }, vi.fn());
    ledger.adopt("event-2", { kind: "event" }, vi.fn());
    ledger.adopt("worker-1", { kind: "worker" }, vi.fn());
    expect(ledger.countWhere((entry) => entry.kind === "event")).toBe(2);
    expect(ledger.countWhere((entry) => entry.kind === "worker")).toBe(1);
    ledger.close("event-1", "disposed");
    expect(ledger.countWhere((entry) => entry.kind === "event")).toBe(1);
    ledger.end("peer-gone");
    expect(ledger.countWhere(() => true)).toBe(0);
  });

  it("survives a release that disposes itself", () => {
    const ledger = new SubscriptionLedger<string>("test");
    let reentered = 0;
    const id = ledger.open("a", () => {
      reentered += 1;
      // Reentrant disposal must not double-release.
      ledger.close(id, "disposed");
    });
    ledger.close(id, "disposed");
    expect(reentered).toBe(1);
    expect(ledger.openCount).toBe(0);
  });

  it("tells the release WHY, so it can decide whether to notify the peer", () => {
    const reasons: string[] = [];
    const ledger = new SubscriptionLedger<string>("test");
    ledger.adopt("s1", "a", (_v, reason) => reasons.push(reason));
    ledger.adopt("s2", "b", (_v, reason) => reasons.push(reason));
    ledger.close("s1", "revoked");
    ledger.end("peer-gone");
    expect(reasons).toEqual(["revoked", "peer-gone"]);
  });

  it("refuses a duplicate id instead of overwriting a release", () => {
    const ledger = new SubscriptionLedger<string>("test");
    const first = vi.fn();
    ledger.adopt("s1", "a", first);
    expect(() => ledger.adopt("s1", "b", vi.fn())).toThrow(DuplicateSubscriptionError);
    ledger.close("s1", "disposed");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("refuses to open once the peer is gone", () => {
    const ledger = new SubscriptionLedger<string>("test");
    ledger.end("peer-gone");
    expect(ledger.isEnded).toBe(true);
    expect(() => ledger.open("a", vi.fn())).toThrow(SubscriptionLedgerEndedError);
  });

  it("releases every registration when the peer dies, and reports how many", () => {
    const released: string[] = [];
    const ledger = new SubscriptionLedger<string>("test");
    for (const value of ["a", "b", "c"]) {
      ledger.open(value, (v) => released.push(v));
    }
    expect(ledger.end("peer-gone")).toBe(3);
    expect(released.sort()).toEqual(["a", "b", "c"]);
    expect(ledger.openCount).toBe(0);
  });

  it("ends cleanly when one release closes a sibling", () => {
    const ledger = new SubscriptionLedger<string>("test");
    const released: string[] = [];
    const first = ledger.open("a", (v) => {
      released.push(v);
      ledger.close(second, "peer-gone");
    });
    const second = ledger.open("b", (v) => released.push(v));
    expect(first).not.toBe(second);
    // Count every registration once even when a release closes its sibling.
    expect(ledger.end("peer-gone")).toBe(1);
    expect(released).toEqual(["a", "b"]);
    expect(ledger.openCount).toBe(0);
  });
});
