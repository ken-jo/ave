import { openHostEgressListener } from "../permissions/egress-host-listener.js";
import { openInvocationProxyListener } from "../permissions/egress-invocation-listener.js";
import {
  egressInvocationAbortSignal, egressInvocationOwner, onEgressInvocationReleased, releaseEgressInvocation,
} from "../permissions/egress-invocations.js";
import { onSandboxStatusChanged } from "../permissions/sandbox-capability.js";
import type { ContainedShellLifecycle } from "./contained-shell-lifecycle.js";

/**
 * The egress half of a container shell launch, shared by every platform: the invocation's owner, everything that
 * revokes it, the admission the listeners bind under, and the listener pair itself. Platform policy, the launcher's
 * identity and the transport stay with each launch.
 */
export interface ShellEgressAdmission {
  /** Throws unless the invocation, its route and the lifecycle are all still current. */
  assertAdmission(): void;
  /** Opens the host relay listener and the invocation's own proxy listener, registered with each other. */
  openProxy(): Promise<{ readonly port: number; readonly url: string }>;
  /** From now on the proxy forwards connections: called when the job starts. */
  activate(): void;
  /** Whether `activate` ran. */
  readonly active: boolean;
}

export function openShellEgressAdmission(input: {
  readonly token: string;
  readonly lifecycle: ContainedShellLifecycle;
  /** Whether the container route this launch was admitted on is still the live one. */
  readonly isRouteCurrent: () => boolean;
  /** A platform's own admission check, run after the shared ones. */
  readonly assertPlatform?: () => void;
  /** Release the invocation when the lifecycle is revoked, for a launch whose caller does not. */
  readonly releaseOnRevoke?: true;
}): ShellEgressAdmission {
  const { token, lifecycle, isRouteCurrent } = input;
  const owner = egressInvocationOwner(token);
  if (owner?.kind !== "shell" || owner.requiresListener !== true) {
    throw new Error("Container egress requires a live shell invocation");
  }
  if (input.releaseOnRevoke) lifecycle.onRevoke(() => releaseEgressInvocation(token));
  const invocationSignal = egressInvocationAbortSignal(token);
  // The invocation's own end (cancellation or release) is reported before what it caused.
  const assertAdmission = (): void => {
    invocationSignal?.throwIfAborted();
    if (!isRouteCurrent()) throw new Error("Container shell route is unavailable");
    if (egressInvocationOwner(token) !== owner) throw new Error("Container egress requires a live shell invocation");
    lifecycle.signal.throwIfAborted();
    input.assertPlatform?.();
  };
  // Watched for the whole invocation: any of these ends it, before spawn or while the job runs.
  lifecycle.defer(onEgressInvocationReleased((released) => {
    if (released === token) lifecycle.revoke();
  }));
  lifecycle.defer(onSandboxStatusChanged(() => {
    if (!isRouteCurrent()) lifecycle.revoke();
  }));
  const revokeOnAbort = (): void => lifecycle.revoke();
  invocationSignal?.addEventListener("abort", revokeOnAbort, { once: true });
  lifecycle.defer(() => invocationSignal?.removeEventListener("abort", revokeOnAbort));
  if (invocationSignal?.aborted === true) lifecycle.revoke();

  let active = false;
  const admission = {
    signal: lifecycle.signal,
    assertCanBind: assertAdmission,
    acceptsConnections: () => active && !lifecycle.signal.aborted,
    adopt: (close: () => Promise<void>) => lifecycle.defer(close),
  };
  return {
    assertAdmission,
    async openProxy() {
      assertAdmission();
      const relay = await openHostEgressListener(token, admission);
      assertAdmission();
      const listener = await openInvocationProxyListener({
        admission,
        upstream: () => admission.acceptsConnections()
          ? { host: "127.0.0.1", port: relay.port, proxyAuthorization: relay.proxyAuthorization }
          : undefined,
        onRefused: relay.recordRefusal,
      });
      assertAdmission();
      relay.registerPort(listener.port);
      return { port: listener.port, url: listener.url };
    },
    activate() {
      active = true;
    },
    get active() { return active; },
  };
}
