import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { subscribeBrowserGuestDestroyed } from "../browser-guest-lifecycle.js";

const log = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../../lib/logger.js", () => ({ createLogger: () => log }));

const guests = new Set<EventEmitter>();
afterEach(() => {
  for (const guest of guests) guest.emit("destroyed");
  guests.clear();
  log.warn.mockClear();
});
function guest(id = 1) {
  const page = Object.assign(new EventEmitter(), { id, isDestroyed: (): boolean => false });
  guests.add(page);
  return page;
}

it("shares one native subscription across many independent owners", () => {
  const page = guest();
  const owners = Array.from({ length: 20 }, () => vi.fn());
  const unsubscribe = owners.map(owner => subscribeBrowserGuestDestroyed(page, owner));
  expect(page.listenerCount("destroyed")).toBe(1);
  for (const stop of unsubscribe.slice(0, -1)) stop();
  expect(page.listenerCount("destroyed")).toBe(1);
  const lastOwner = unsubscribe.at(-1);
  if (!lastOwner) throw new Error("Missing lifecycle owner");
  lastOwner();
  expect(page.listenerCount("destroyed")).toBe(0);
  page.emit("destroyed");
  expect(owners.every(owner => owner.mock.calls.length === 0)).toBe(true);
});

it("treats repeated callback registrations as independent ownership", () => {
  const page = guest();
  const owner = vi.fn();
  const first = subscribeBrowserGuestDestroyed(page, owner);
  const second = subscribeBrowserGuestDestroyed(page, owner);
  first(); first();
  expect(page.listenerCount("destroyed")).toBe(1);
  page.emit("destroyed");
  second();
  expect(owner).toHaveBeenCalledOnce();
  expect(page.listenerCount("destroyed")).toBe(0);
});

it("fans out destruction once despite reentrant events and cleanup", () => {
  const page = guest();
  const later = vi.fn();
  let unsubscribeLater = () => {};
  const first = vi.fn(() => { unsubscribeLater(); page.emit("destroyed"); });
  subscribeBrowserGuestDestroyed(page, first);
  unsubscribeLater = subscribeBrowserGuestDestroyed(page, later);
  page.emit("destroyed");
  page.emit("destroyed");
  expect(first).toHaveBeenCalledOnce();
  expect(later).toHaveBeenCalledOnce();
  expect(page.listenerCount("destroyed")).toBe(0);
});

it("continues notifying owners when one cleanup throws", () => {
  const page = guest();
  const later = vi.fn();
  const error = new Error("cleanup failed");
  subscribeBrowserGuestDestroyed(page, () => { throw error; });
  subscribeBrowserGuestDestroyed(page, later);
  expect(() => page.emit("destroyed")).not.toThrow();
  expect(later).toHaveBeenCalledOnce();
  expect(log.warn).toHaveBeenCalledWith({ error }, "browser guest cleanup failed");
  expect(page.listenerCount("destroyed")).toBe(0);
});

it("does not attach again when an owner subscribes during or after destruction", () => {
  const page = guest();
  const during = vi.fn();
  const after = vi.fn();
  subscribeBrowserGuestDestroyed(page, () => subscribeBrowserGuestDestroyed(page, during));
  page.emit("destroyed");
  subscribeBrowserGuestDestroyed(page, after)();
  expect(during).toHaveBeenCalledOnce();
  expect(after).toHaveBeenCalledOnce();
  expect(page.listenerCount("destroyed")).toBe(0);
});

it("notifies an already destroyed guest without installing a native listener", () => {
  const page = guest();
  page.isDestroyed = () => true;
  const owner = vi.fn();
  subscribeBrowserGuestDestroyed(page, owner)();
  expect(owner).toHaveBeenCalledOnce();
  expect(page.listenerCount("destroyed")).toBe(0);
});

it("isolates physical guests whose numeric identifiers are reused", () => {
  const oldPage = guest();
  const newPage = guest();
  const oldOwner = vi.fn();
  const newOwner = vi.fn();
  const stopOld = subscribeBrowserGuestDestroyed(oldPage, oldOwner);
  subscribeBrowserGuestDestroyed(newPage, newOwner);
  stopOld();
  expect(oldPage.listenerCount("destroyed")).toBe(0);
  expect(newPage.listenerCount("destroyed")).toBe(1);
  oldPage.emit("destroyed");
  expect(newOwner).not.toHaveBeenCalled();
  newPage.emit("destroyed");
  expect(newOwner).toHaveBeenCalledOnce();
  expect(oldOwner).not.toHaveBeenCalled();
});

it("keeps a replacement guest subscribed when the old guest is destroyed", () => {
  const oldPage = guest();
  const newPage = guest();
  const oldOwner = vi.fn();
  const newOwner = vi.fn();
  subscribeBrowserGuestDestroyed(oldPage, oldOwner);
  subscribeBrowserGuestDestroyed(newPage, newOwner);
  oldPage.emit("destroyed");
  expect(oldOwner).toHaveBeenCalledOnce();
  expect(newOwner).not.toHaveBeenCalled();
  const added = vi.fn();
  subscribeBrowserGuestDestroyed(newPage, added);
  expect(newPage.listenerCount("destroyed")).toBe(1);
  newPage.emit("destroyed");
  expect(newOwner).toHaveBeenCalledOnce();
  expect(added).toHaveBeenCalledOnce();
});
