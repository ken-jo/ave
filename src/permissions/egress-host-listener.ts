import { maskSensitiveData } from "../audit/dlp-filter.js";

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
