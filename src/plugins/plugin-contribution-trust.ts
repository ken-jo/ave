import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeUtf8FileAtomicSync, isMissingPathError } from "../lib/atomic-file.js";

export type PluginContributionTrustKind = "hook" | "mcpServer";

export interface PluginContributionTrustIdentity {
  pluginId: string;
  pluginVersion: string;
  generationId: string;
  localId: string;
  fingerprint: string;
}

/** Approvals bind exact generation identity and coverage digest; carriedFrom identifies the source approval. */
export interface PluginContributionTrustRecord extends PluginContributionTrustIdentity {
  approvalDigest: string | null;
  carriedFrom?: string;
}

interface TrustFileV2 {
  version: 2;
  kind: PluginContributionTrustKind;
  approvals: PluginContributionTrustIdentity[];
}

interface TrustFileV3 {
  version: 3;
  kind: PluginContributionTrustKind;
  approvals: PluginContributionTrustRecord[];
}

const SHA256 = /^[a-f0-9]{64}$/;
const IDENTITY_KEYS = ["pluginId", "pluginVersion", "generationId", "localId", "fingerprint"];

function key(identity: PluginContributionTrustIdentity): string {
  return [
    identity.pluginId,
    identity.pluginVersion,
    identity.generationId,
    identity.localId,
    identity.fingerprint,
  ].join("|");
}

function identityOf(identity: PluginContributionTrustIdentity): PluginContributionTrustIdentity {
  return {
    pluginId: identity.pluginId,
    pluginVersion: identity.pluginVersion,
    generationId: identity.generationId,
    localId: identity.localId,
    fingerprint: identity.fingerprint,
  };
}

function validIdentity(identity: PluginContributionTrustIdentity | undefined): boolean {
  return Boolean(
    identity?.pluginId && identity.pluginVersion &&
    SHA256.test(identity.generationId) && identity.localId &&
    SHA256.test(identity.fingerprint),
  );
}

/** Load trust versions strictly; only explicit approval or validated carry-forward authorizes a new generation. */
export class PluginContributionTrustStore {
  private approvals = new Map<string, Readonly<PluginContributionTrustRecord>>();

  constructor(
    private readonly kind: PluginContributionTrustKind,
    private readonly path?: string,
  ) {
    if (!path) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as TrustFileV2 | TrustFileV3;
      if ((parsed.version !== 2 && parsed.version !== 3) || parsed.kind !== kind || !Array.isArray(parsed.approvals)) {
        throw new Error(`invalid ${kind} plugin contribution trust file`);
      }
      for (const raw of parsed.approvals as Array<PluginContributionTrustIdentity & Partial<PluginContributionTrustRecord>>) {
        if (!validIdentity(raw)) throw new Error(`invalid ${kind} plugin contribution trust record`);
        let record: PluginContributionTrustRecord;
        if (parsed.version === 2) {
          if (Object.keys(raw).some((field) => !IDENTITY_KEYS.includes(field))) throw new Error(`invalid ${kind} plugin contribution trust record`);
          record = { ...identityOf(raw), approvalDigest: null };
        } else {
          if (Object.keys(raw).some((field) => !IDENTITY_KEYS.includes(field) && field !== "approvalDigest" && field !== "carriedFrom")
            || !(raw.approvalDigest === null || (typeof raw.approvalDigest === "string" && SHA256.test(raw.approvalDigest)))
            || (raw.carriedFrom !== undefined && (typeof raw.carriedFrom !== "string" || !SHA256.test(raw.carriedFrom)))) {
            throw new Error(`invalid ${kind} plugin contribution trust record`);
          }
          record = { ...identityOf(raw), approvalDigest: raw.approvalDigest!, ...(raw.carriedFrom ? { carriedFrom: raw.carriedFrom } : {}) };
        }
        this.approvals.set(key(record), Object.freeze(record));
      }
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }

  approve(identity: PluginContributionTrustIdentity, approvalDigest: string | null, carriedFrom?: string): void {
    const next = new Map(this.approvals);
    next.set(key(identity), Object.freeze({ ...identityOf(identity), approvalDigest, ...(carriedFrom ? { carriedFrom } : {}) }));
    this.persist(next);
    this.approvals = next;
  }

  isApproved(identity: PluginContributionTrustIdentity): boolean {
    return this.approvals.has(key(identity));
  }

  record(identity: PluginContributionTrustIdentity): Readonly<PluginContributionTrustRecord> | undefined {
    return this.approvals.get(key(identity));
  }

  /** Backfill a missing digest only from its exact running generation; never replace a recorded digest. */
  recordDigest(identity: PluginContributionTrustIdentity, approvalDigest: string | null): void {
    const current = this.approvals.get(key(identity));
    if (!current || current.approvalDigest !== null || approvalDigest === null) return;
    const next = new Map(this.approvals);
    next.set(key(identity), Object.freeze({ ...current, approvalDigest }));
    this.persist(next);
    this.approvals = next;
  }

  revoke(identity: PluginContributionTrustIdentity): void {
    if (!this.approvals.has(key(identity))) return;
    const next = new Map(this.approvals);
    next.delete(key(identity));
    this.persist(next);
    this.approvals = next;
  }

  private persist(approvals: ReadonlyMap<string, PluginContributionTrustRecord>): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const body: TrustFileV3 = {
      version: 3,
      kind: this.kind,
      approvals: [...approvals.values()],
    };
    writeUtf8FileAtomicSync(this.path, `${JSON.stringify(body, null, 2)}\n`, 0o600);
  }
}

export interface ApprovableProjection {
  owner: PluginContributionTrustIdentity;
  approvalDigest: string | null;
}

export interface ProjectionTrust<P extends ApprovableProjection> {
  approve(projection: P, carriedFrom?: string): void;
  isApproved(projection: P): boolean;
  record(projection: P): Readonly<PluginContributionTrustRecord> | undefined;
  revoke(projection: P): void;
}

/** Carry only matching non-null component digests; revalidate source approvals before publishing and revoke failed candidates. */
export function carryApprovals<P extends ApprovableProjection>(
  trust: ProjectionTrust<P>,
  previous: readonly P[],
  next: readonly P[],
): Array<{ from: P; to: P }> {
  const carried: Array<{ from: P; to: P }> = [];
  for (const to of next) {
    if (to.approvalDigest === null || trust.isApproved(to)) continue;
    const from = previous.find((item) => item.owner.pluginId === to.owner.pluginId && item.owner.localId === to.owner.localId);
    if (!from) continue;
    const record = trust.record(from);
    if (!record || record.approvalDigest === null || record.approvalDigest !== to.approvalDigest) continue;
    trust.approve(to, from.owner.generationId);
    carried.push({ from, to });
  }
  return carried;
}

/** Recheck source approval and digest under publication serialization so concurrent revocation cannot be undone. */
export function assertCarriedApprovalsHold<P extends ApprovableProjection>(
  trust: Pick<ProjectionTrust<P>, "record">,
  carried: ReadonlyArray<{ from: P; to: P }>,
): void {
  for (const { from, to } of carried) {
    const record = trust.record(from);
    if (!record || record.approvalDigest !== to.approvalDigest) {
      throw new CarriedApprovalWithdrawnError(to.owner.pluginId, to.owner.localId);
    }
  }
}

/** Withdrawn source consent aborts publication and requires a new update review. */
export class CarriedApprovalWithdrawnError extends Error {
  constructor(readonly pluginId: string, readonly localId: string) {
    super(`the approval of ${pluginId}:${localId} was withdrawn while its update was prepared`);
    this.name = "CarriedApprovalWithdrawnError";
  }
}

/** Installed approval must match the exact generation and digest the user reviewed. */
export class ContributionTrustReviewStaleError extends Error {
  constructor(readonly pluginId: string, readonly localId: string) {
    super(`${pluginId}:${localId} changed since it was reviewed`);
    this.name = "ContributionTrustReviewStaleError";
  }
}
