import { createLogger } from "../../lib/logger.js";

export interface BrowserLifecycleGuest {
  readonly id: number;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  removeListener(event: "destroyed", listener: () => void): unknown;
}

interface GuestLifecycle {
  owners: Map<symbol, () => void>;
  unsubscribe(): void;
}

const log = createLogger("browser-guest-lifecycle");
const lifecycles = new Map<number, Map<BrowserLifecycleGuest, GuestLifecycle>>();
const destroyedGuests = new WeakSet<BrowserLifecycleGuest>();

function notify(listener: () => void): void {
  try { listener(); }
  catch (error) { log.warn({ error }, "browser guest cleanup failed"); }
}

/** Independent owners share one native destruction subscription for the exact physical guest. */
export function subscribeBrowserGuestDestroyed(guest: BrowserLifecycleGuest, listener: () => void): () => void {
  if (destroyedGuests.has(guest) || guest.isDestroyed()) {
    destroyedGuests.add(guest);
    notify(listener);
    return () => {};
  }
  const guestId = guest.id;
  let bucket = lifecycles.get(guestId);
  if (!bucket) { bucket = new Map(); lifecycles.set(guestId, bucket); }
  const registrations = bucket;
  let lifecycle = registrations.get(guest);
  if (!lifecycle) {
    const owners = new Map<symbol, () => void>();
    let subscribed = true;
    const unsubscribe = () => {
      if (!subscribed) return;
      subscribed = false;
      guest.removeListener("destroyed", destroyed);
      registrations.delete(guest);
      if (registrations.size === 0 && lifecycles.get(guestId) === registrations) lifecycles.delete(guestId);
    };
    const destroyed = () => {
      destroyedGuests.add(guest);
      const pending = [...owners.values()];
      owners.clear();
      unsubscribe();
      for (const owner of pending) notify(owner);
    };
    lifecycle = { owners, unsubscribe };
    registrations.set(guest, lifecycle);
    guest.once("destroyed", destroyed);
  }
  const owner = Symbol("guest-lifecycle-owner");
  const registration = lifecycle;
  registration.owners.set(owner, listener);
  return () => {
    registration.owners.delete(owner);
    if (registration.owners.size === 0) registration.unsubscribe();
  };
}
