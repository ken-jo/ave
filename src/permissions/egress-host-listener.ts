import { maskSensitiveData } from "../audit/dlp-filter.js";
import { egressInvocationOwner, onEgressInvocationReleased } from "./egress-invocations.js";
import { openInvocationProxyListener, type InvocationProxyListener } from "./egress-invocation-listener.js";

/** One endpoint-scoped egress lease; control traffic belongs on native streams. */
export async function openMxcEgressLease(token: string): Promise<InvocationProxyListener> {
  if (!egressInvocationOwner(token)) throw new Error("Container egress requires a live invocation");
  const relay = await openHostEgressListener(token);
  let listener: InvocationProxyListener | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  let unsubscribe = (): void => {};
  const close = (): Promise<void> => {
    closed = true;
    unsubscribe();
    closing ??= (async () => {
      try { await listener?.close(); } finally { await relay.close(); }
    })();
    return closing;
  };
  try {
    listener = await openInvocationProxyListener({
      upstream: () => !closed && egressInvocationOwner(token)
        ? { host: "127.0.0.1", port: relay.port, proxyAuthorization: relay.proxyAuthorization }
        : undefined,
      onRefused: relay.recordRefusal,
    });
    relay.registerPort(listener.port);
    // Admission may have ended while the asynchronous listener bind was pending.
    if (!egressInvocationOwner(token)) throw new Error("Container egress invocation ended during preparation");
    unsubscribe = onEgressInvocationReleased((released) => {
      if (released === token) void close().catch(() => {});
    });
    return { port: listener.port, url: listener.url, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// Host-only bridge to the runtime's invocation policy and refusal store.
export async function openHostEgressListener(token: string) {
  // Keep the runtime external to the host bundle, as in the sandbox adapter.
  const { openHostInvocationProxy } = await import("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-manager.js");
  const relay = await openHostInvocationProxy(token);
  return {
    ...relay,
    recordRefusal(destination: string, reason: string): void {
      let host = destination;
      let port: number | undefined;
      try {
        const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(destination);
        const url = new URL(absolute ? destination : `http://${destination}`);
        host = url.hostname;
        port = url.port !== "" ? Number(url.port) : absolute ? (url.protocol === "https:" ? 443 : 80) : undefined;
      } catch {
        // Malformed destinations are still recorded, as with proxy denials.
      }
      relay.recordRefusal(maskSensitiveData(host).masked, port, maskSensitiveData(reason).masked);
    },
  };
}
