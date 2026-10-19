/**
 * Boot wiring for the egress ask: the process's grant store and the callback
 * ASRT is initialised with. Kept apart from `egress-ask.ts`, which is pure
 * decision logic over injected dependencies.
 */
import type { SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { emitSandboxAudit } from "../audit/sandbox-audit-sink.js";
import type { ApprovalGate } from "./approval-gate.js";
import { closeEgressConnections, normalizeUnionForAsrt } from "./asrt-sandbox.js";
import type { ListedEgressGrant, RevocableEgressGrant } from "../shared/egress-grant-scopes.js";
import { createApprovalGateEgressRequester } from "./egress-approval.js";
import { createEgressAskCallback } from "./egress-ask.js";
import { EgressGrantStore } from "./egress-grants.js";
import { egressIdentityStrength } from "./egress-identity.js";
import {
  egressInvocationAbortSignal,
  egressInvocationOwner,
  onEgressInvocationReleased,
} from "./egress-invocations.js";

const log = createLogger("egress-ask");

let grantStore: EgressGrantStore | undefined;

/**
 * The process's shell egress grant store (Settings lists and revokes through
 * it). Created on first use; its "Allow once" hosts go with their invocation.
 */
function egressGrantStore(): EgressGrantStore {
  if (grantStore === undefined) {
    const store = new EgressGrantStore();
    onEgressInvocationReleased((token) => store.releaseToken(token));
    grantStore = store;
  }
  return grantStore;
}

/** Every grant Settings lists: this run's conversation grants, then the persistent ones. */
export async function listEgressGrants(): Promise<readonly ListedEgressGrant[]> {
  const store = egressGrantStore();
  return [...store.listConversation(), ...(await store.listPersistent())];
}

/**
 * Revoke one grant and close the connections it had let through that are
 * still open. Resolves whether it existed and how many connections closed.
 */
export async function revokeEgressGrant(target: RevocableEgressGrant): Promise<{ readonly removed: boolean; readonly closed: number }> {
  const { removed, tokens } = await egressGrantStore().revoke(target);
  return { removed, closed: closeEgressConnections(tokens, target.host, target.port) };
}

/**
 * What plugin workers may reach, as of the last refresh: each extension's
 * declared domains and the model endpoints the host is configured for.
 * Recomputed by `refreshSandboxNetworkConfig` (boot, after plugins load, and
 * whenever a model endpoint changes), the same moments the shared ASRT
 * allowlist used to be swapped.
 */
export interface WorkerEgressAllowlists {
  /** Extension id to its manifest's `networkAccess.allowedDomains`. */
  readonly byExtension: ReadonlyMap<string, readonly string[]>;
  /** Host names of the configured model endpoints (`computeDynamicEndpointHosts`). */
  readonly modelEndpointHosts: readonly string[];
}

let workerAllowlists: WorkerEgressAllowlists = { byExtension: new Map(), modelEndpointHosts: [] };

export function setWorkerEgressAllowlists(next: WorkerEgressAllowlists): void {
  workerAllowlists = {
    byExtension: new Map([...next.byExtension].map(([id, domains]) => [id, [...domains]])),
    modelEndpointHosts: [...next.modelEndpointHosts],
  };
}

/**
 * The hosts one worker may reach: its own extension's domains (none for a
 * worker no extension owns) plus the model endpoints, never another
 * extension's domains and never a shell grant.
 */
export function workerEgressAllowedDomains(pluginId: string | undefined): readonly string[] {
  const own = pluginId === undefined ? [] : workerAllowlists.byExtension.get(pluginId) ?? [];
  return normalizeUnionForAsrt([...own, ...workerAllowlists.modelEndpointHosts]);
}

export interface EgressAskRuntimeDeps {
  readonly approvalGate: Pick<ApprovalGate, "requestAndWait">;
  /** `features.shellEgressAsk`. */
  readonly shellAskEnabled: () => boolean;
}

/** The callback ASRT is initialised with. */
export function createEgressAskRuntimeCallback(deps: EgressAskRuntimeDeps): SandboxAskCallback {
  const requester = createApprovalGateEgressRequester(deps.approvalGate);
  return createEgressAskCallback({
    identityStrength: egressIdentityStrength,
    ownerOf: egressInvocationOwner,
    abortSignalOf: egressInvocationAbortSignal,
    workerAllowedDomains: workerEgressAllowedDomains,
    grants: egressGrantStore(),
    shellAskEnabled: deps.shellAskEnabled,
    requester: () => requester,
    audit: (entry) => {
      emitSandboxAudit(entry).catch((error: unknown) => {
        log.warn("could not record an egress decision: %s", errorMessage(error));
      });
    },
  });
}
