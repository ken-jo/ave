import { maskSensitiveData } from "../audit/dlp-filter.js";
import { egressInvocationAbortSignal, egressInvocationOwner, onEgressInvocationReleased } from "./egress-invocations.js";
import { commitUnderAdmission } from "../shared/admission-commit.js";
import {
  openInvocationProxyListener, openInvocationProxySocketListener, type InvocationProxyAdmission, type InvocationProxyListener, type InvocationProxySocketListener,
} from "./egress-invocation-listener.js";
import { openEgressRelay } from "./egress-relay/relay.js";

/**
 * One endpoint-scoped egress lease; control traffic belongs on native streams. By default the lease closes when its
 * invocation is released. `holdPortAfterRelease` keeps the port bound and refusing every request instead, until the
 * owner closes it: a macOS holder whose stop was not verified may have a process left whose profile allows this port,
 * so the number must not go to another listener while Ave runs.
 */
export function openMxcEgressLease(token: string, assertStillValid?: () => void,
  options: { readonly holdPortAfterRelease?: boolean } = {}): Promise<InvocationProxyListener> {
  return openLease(token, assertStillValid, options) as Promise<InvocationProxyListener>;
}

/**
 * The socket form, for a Linux holder: the listener binds `socketPath`, and a held lease keeps the socket bound and
 * refusing after its invocation ends, until the owner closes it, which removes the file.
 */
export function openMxcEgressSocketLease(token: string, assertStillValid: (() => void) | undefined,
  options: { readonly holdPortAfterRelease?: boolean; readonly socketPath: string }): Promise<InvocationProxySocketListener> {
  return openLease(token, assertStillValid, options) as Promise<InvocationProxySocketListener>;
}

async function openLease(token: string, assertStillValid: (() => void) | undefined,
  options: { readonly holdPortAfterRelease?: boolean; readonly socketPath?: string }): Promise<InvocationProxyListener | InvocationProxySocketListener> {
  const owner = egressInvocationOwner(token);
  const signal = egressInvocationAbortSignal(token);
  if (!owner || !signal) throw new Error("Container egress requires a live invocation");
  const disposers: Array<() => Promise<void>> = [];
  let closed = false;
  let closing: Promise<void> | undefined;
  let unsubscribe = (): void => {};
  const close = (): Promise<void> => {
    closed = true;
    unsubscribe();
    closing ??= (async () => {
      const results = await Promise.allSettled(disposers.map(dispose => dispose()));
      const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (errors.length) throw new AggregateError(errors, "Container egress lease failed to close");
    })();
    return closing;
  };
  const assertCanBind = () => {
    signal.throwIfAborted();
    if (closed || egressInvocationOwner(token) !== owner) throw new Error("Container egress invocation ended during preparation");
    assertStillValid?.();
  };
  let ready = false;
  const admission = { signal, assertCanBind, acceptsConnections: () => ready && !closed && !signal.aborted,
    adopt: (dispose: () => Promise<void>) => { disposers.push(dispose); } };
  try {
    assertCanBind();
    const relay = await openHostEgressListener(token, admission);
    const listenerOptions = {
      admission,
      upstream: () => admission.acceptsConnections()
        ? { host: "127.0.0.1", port: relay.port, proxyAuthorization: relay.proxyAuthorization }
        : undefined,
      onRefused: relay.recordRefusal,
    };
    const subscribe = () => {
      // Held: the invocation's abort revokes the relay and the listener, which refuse every request while bound.
      if (!options.holdPortAfterRelease) {
        unsubscribe = onEgressInvocationReleased((released) => {
          if (released === token) void close().catch(() => {});
        });
      }
      ready = true;
    };
    if (options.socketPath !== undefined) {
      const listener = await openInvocationProxySocketListener({ ...listenerOptions, socketPath: options.socketPath });
      // A socket file is never a TCP destination, so there is no port to register with the relay.
      return commitUnderAdmission(assertCanBind, () => {
        subscribe();
        return { socketPath: listener.socketPath, close };
      });
    }
    const listener = await openInvocationProxyListener(listenerOptions);
    return commitUnderAdmission(assertCanBind, () => {
      relay.registerPort(listener.port);
      subscribe();
      return { port: listener.port, url: listener.url, close };
    });
  } catch (error) {
    try {
      await close();
    } catch (closeError) {
      throw new AggregateError([error, closeError], "Container egress lease failed to open and to close");
    }
    throw error;
  }
}

// The invocation's relay: its policy decisions and its refusal record.
export async function openHostEgressListener(token: string, admission?: InvocationProxyAdmission) {
  const relay = await openEgressRelay(token, admission);
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
