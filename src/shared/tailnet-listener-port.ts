export const TAILNET_LOOPBACK_DESTINATION = "tailnet-loopback-destination";

const listeners = new Set<number>();
const portObservers = new Set<() => void>();

export function tailnetListenerPorts(): number[] {
  return [...listeners];
}

export function isTailnetListenerPort(port: number): boolean {
  return listeners.has(port);
}

export function onTailnetListenerPortsChanged(observer: () => void): void {
  portObservers.add(observer);
}

/** Keep the port protected from before the bind until the listener has closed. */
export function reserveTailnetListenerPort(port: number): () => void {
  if (listeners.has(port)) throw Object.assign(new Error("Tailnet listener port is already reserved"), { code: "EADDRINUSE" });
  listeners.add(port);
  const release = () => {
    if (listeners.delete(port)) for (const observer of portObservers) observer();
  };
  try {
    for (const observer of portObservers) observer();
  } catch (error) {
    release();
    throw error;
  }
  return release;
}
