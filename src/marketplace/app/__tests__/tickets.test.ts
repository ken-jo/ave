/**
 * Single-use plan and preview ids (design §13): taken once, expired after the
 * TTL whether or not anyone asks again, and superseded within a slot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tickets } from "../tickets.js";

describe("Tickets", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("takes an id once", () => {
    const tickets = new Tickets<string>("install plan");
    const { id } = tickets.issue("plan");
    expect(tickets.take(id)).toBe("plan");
    expect(() => tickets.take(id)).toThrow(expect.objectContaining({ code: "PLAN_EXPIRED" }));
  });

  it("drops a value left unused when it expires, without another call to sweep it", () => {
    const dropped = vi.fn();
    const tickets = new Tickets<string>("marketplace preview", Date.now, 1000, dropped);
    const { id } = tickets.issue("clone");
    vi.advanceTimersByTime(999);
    expect(dropped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dropped).toHaveBeenCalledWith("clone");
    expect(() => tickets.peek(id)).toThrow(expect.objectContaining({ code: "PLAN_EXPIRED" }));
  });

  it("does not drop a taken value when its time comes", () => {
    const dropped = vi.fn();
    const tickets = new Tickets<string>("marketplace preview", Date.now, 1000, dropped);
    tickets.take(tickets.issue("clone").id);
    vi.advanceTimersByTime(5000);
    expect(dropped).not.toHaveBeenCalled();
  });

  it("keeps only the newest ticket in a slot, and leaves other slots alone", () => {
    const dropped = vi.fn();
    const tickets = new Tickets<string>("install plan", Date.now, 1000, dropped);
    const first = tickets.issue("v1", "acme:mcp:notes");
    const other = tickets.issue("other", "acme:mcp:weather");
    const second = tickets.issue("v2", "acme:mcp:notes");
    expect(dropped).toHaveBeenCalledWith("v1");
    expect(() => tickets.peek(first.id)).toThrow(expect.objectContaining({ code: "PLAN_EXPIRED" }));
    expect(tickets.peek(second.id)).toBe("v2");
    expect(tickets.peek(other.id)).toBe("other");
    // A taken ticket frees its slot: the next one there drops nothing.
    tickets.take(second.id);
    tickets.issue("v3", "acme:mcp:notes");
    expect(dropped).toHaveBeenCalledTimes(1);
  });

  it("drops everything on clear and fires no timer afterwards", () => {
    const dropped = vi.fn();
    const tickets = new Tickets<string>("install plan", Date.now, 1000, dropped);
    tickets.issue("a");
    tickets.issue("b", "slot");
    tickets.clear();
    expect(dropped.mock.calls).toEqual([["a"], ["b"]]);
    vi.advanceTimersByTime(5000);
    expect(dropped).toHaveBeenCalledTimes(2);
  });
});
