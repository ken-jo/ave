// Keep boot-owned stores and runtime wiring separate from injected egress decision logic.
import type { SandboxAskCallback } from "@anthropic-ai/sandbox-runtime";
import { createLogger } from "../lib/logger.js";
import { errorMessage } from "../shared/error-message.js";
import { emitSandboxAudit } from "../audit/sandbox-audit-sink.js";
import type { PermissionManager } from "./permission-manager.js";
import type { ApprovalGate } from "./approval-gate.js";
import { closeEgressConnections, normalizeUnionForAsrt } from "./asrt-sandbox.js";
import type { ListedEgressGrant, RevocableEgressGrant } from "../shared/egress-grant-scopes.js";
import { createApprovalGateEgressRequester, createShellNetworkPermissionEvaluator } from "./egress-approval.js";
import { createEgressAskCallback } from "./egress-ask.js";
import { EgressGrantStore, egressGrantFilePath } from "./egress-grants.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import { egressIdentityStrength } from "./egress-identity.js";
import {
  egressInvocationAbortSignal,
  egressInvocationOwner,
  onEgressInvocationReleased,
} from "./egress-invocations.js";

const log = createLogger("egress-ask");

let grantStore: EgressGrantStore | undefined;

// The process's shell egress grant store (Settings lists and revokes through it). Created on first use; its "Allow once" hosts go with their invocation, and a terminal tab's "This tab" hosts with the tab's shell (the tab closed).
function egressGrantStore(): EgressGrantStore {
  if (grantStore === undefined) {
    const store = new EgressGrantStore(egressGrantFilePath(), (dropped) => {
      log.warn(`[egress] a v1 "This workspace" network grant made inside a repository was dropped by the grant-file migration; it will be asked again`);
      emitSandboxAudit({
        timestamp: new Date().toISOString(),
        entryKind: "egress-grant-migration",
        action: "dropped",
        destination: { host: maskSensitiveData(dropped.host).masked, port: dropped.port },
        workspaceRoot: maskSensitiveData(dropped.workspaceRoot).masked,
        projectRoot: maskSensitiveData(dropped.projectRoot).masked,
      }).catch((error: unknown) => log.warn(`[egress] grant migration audit write failed: ${errorMessage(error)}`));
    });
    onEgressInvocationReleased((token, { owner }) => {
      store.releaseToken(token);
      if (owner.kind === "terminal") store.releaseTab(owner.tabId);
    });
    grantStore = store;
  }
  return grantStore;
}

// Every grant Settings lists: this run's session and tab grants, then the persistent ones.
export async function listEgressGrants(): Promise<readonly ListedEgressGrant[]> {
  const store = egressGrantStore();
  return [...store.listSession(), ...store.listTab(), ...(await store.listPersistent())];
}

// Drop a deleted conversation's "This session" hosts (owner 2026-10-25: session scope dies with the session).
export function releaseEgressSessions(ended: (sessionId: string) => boolean): void {
  if (grantStore === undefined) return;
  grantStore.releaseSessions(ended);
}

// Revoke one grant and close the connections it had let through that are still open. Resolves whether it existed and how many connections closed.
export async function revokeEgressGrant(target: RevocableEgressGrant): Promise<{ readonly removed: boolean; readonly closed: number }> {
  const { removed, tokens } = await egressGrantStore().revoke(target);
  return { removed, closed: closeEgressConnections(tokens, target.host, target.port) };
}

// Refresh extension domains and configured model endpoints at boot, plugin load and endpoint changes.
export interface WorkerEgressAllowlists {
  // Extension id to its manifest's `networkAccess.allowedDomains`.
  readonly byExtension: ReadonlyMap<string, readonly string[]>;
  // Host names of the configured model endpoints (`computeDynamicEndpointHosts`).
  readonly modelEndpointHosts: readonly string[];
}

let workerAllowlists: WorkerEgressAllowlists = { byExtension: new Map(), modelEndpointHosts: [] };

export function setWorkerEgressAllowlists(next: WorkerEgressAllowlists): void {
  workerAllowlists = {
    byExtension: new Map([...next.byExtension].map(([id, domains]) => [id, [...domains]])),
    modelEndpointHosts: [...next.modelEndpointHosts],
  };
}

// The hosts one worker may reach: its own extension's domains (none for a worker no extension owns) plus the model endpoints, never another extension's domains and never a shell grant.
export function workerEgressAllowedDomains(pluginId: string | undefined): readonly string[] {
  const own = pluginId === undefined ? [] : workerAllowlists.byExtension.get(pluginId) ?? [];
  return normalizeUnionForAsrt([...own, ...workerAllowlists.modelEndpointHosts]);
}

export interface EgressAskRuntimeDeps {
  readonly approvalGate: Pick<ApprovalGate, "requestAndWait">;
  // `features.shellEgressAsk`.
  readonly shellAskEnabled: () => boolean;
  readonly permissionManager?: PermissionManager;
}

// The callback ASRT is initialised with.
export function createEgressAskRuntimeCallback(deps: EgressAskRuntimeDeps): SandboxAskCallback {
  const requester = createApprovalGateEgressRequester(deps.approvalGate, deps.permissionManager);
  return createEgressAskCallback({
    // Shell cards offer Deny plus once/session/project/always (owner 2026-10-25, five-choice network card); a shared identity or a local/unverified destination keeps only the in-memory rungs.
    identityStrength: egressIdentityStrength,
    ownerOf: egressInvocationOwner,
    abortSignalOf: egressInvocationAbortSignal,
    workerAllowedDomains: workerEgressAllowedDomains,
    grants: egressGrantStore(),
    evaluateShellPermission: createShellNetworkPermissionEvaluator(deps.permissionManager),
    shellAskEnabled: deps.shellAskEnabled,
    requester: () => requester,
    audit: (entry) => {
      emitSandboxAudit(entry).catch((error: unknown) => {
        log.warn("could not record an egress decision: %s", errorMessage(error));
      });
    },
  });
}
