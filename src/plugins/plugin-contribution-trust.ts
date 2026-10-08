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

/**
 * One approval: the exact generation's identity, plus what the approval
 * covers (design §18.7.3). `approvalDigest` is the component's approval
 * digest when it was approved, or null when its closure could not be
 * determined or the approval came from a version-2 file and has not been
 * matched to its running bytes. `carriedFrom` names the generation an
 * approval was carried forward from.
 */
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

/**
 * Durable exact-generation trust store (design §18.7.3). An approval names
 * one generation; a new generation's component is approved only explicitly
 * or by carry-forward, which the lifecycles decide from `approvalDigest`.
 *
 * Version 2 (0.12) loads strictly as before, every record without an
 * approval digest; version 3 loads strictly too; anything else fails. The
 * next write is version 3.
 */
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

  /** Approve the exact identity, covering `approvalDigest`; `carriedFrom` marks a carried approval. */
  approve(identity: PluginContributionTrustIdentity, approvalDigest: string | null, carriedFrom?: string): void {
    const next = new Map(this.approvals);
    next.set(key(identity), Object.freeze({ ...identityOf(identity), approvalDigest, ...(carriedFrom ? { carriedFrom } : {}) }));
    this.persist(next);
    this.approvals = next;
  }

  isApproved(identity: PluginContributionTrustIdentity): boolean {
    return this.approvals.has(key(identity));
  }

  /** The approval of the exact identity, if any. */
  record(identity: PluginContributionTrustIdentity): Readonly<PluginContributionTrustRecord> | undefined {
    return this.approvals.get(key(identity));
  }

  /**
   * Record the approval digest of an approval that has none, computed from
   * the bytes of the exact generation it names while that generation runs
   * (design §18.7.3, version-2 migration). Those are the bytes the user
   * approved: the generation id commits to every receipt-covered byte. A
   * digest that is still null, or an approval that already has one, is
   * left as it is.
   */
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

/** A projection whose approval the stores hold: its trust identity and its approval digest. */
export interface ApprovableProjection {
  owner: PluginContributionTrustIdentity;
  approvalDigest: string | null;
}

/** The trust store operations a carry-forward uses, on projections. */
export interface ProjectionTrust<P extends ApprovableProjection> {
  approve(projection: P, carriedFrom?: string): void;
  isApproved(projection: P): boolean;
  record(projection: P): Readonly<PluginContributionTrustRecord> | undefined;
  revoke(projection: P): void;
}

/**
 * Carry approvals forward to a new generation (design §18.7.3 "Prepare"):
 * each component of `next` whose predecessor in `previous` (same local id)
 * is approved with a non-null approval digest equal to its own gets a
 * provisional approval naming the predecessor's generation. Returns the
 * carried pairs, so the caller revalidates them before publication and
 * revokes them on failure.
 */
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

/**
 * Revalidate carried approvals under the serialization that publishes the
 * new generation (design §18.7.3 "Publish"): each source approval must still
 * be held with the same digest. Throws {@link CarriedApprovalWithdrawnError}
 * when one is not, so a revocation in between is not undone.
 */
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

/**
 * A carried approval's source was revoked between preparation and
 * publication: the publication is abandoned, and an automatic update
 * becomes `needs-review` (design §18.7.3).
 */
export class CarriedApprovalWithdrawnError extends Error {
  constructor(readonly pluginId: string, readonly localId: string) {
    super(`the approval of ${pluginId}:${localId} was withdrawn while its update was prepared`);
    this.name = "CarriedApprovalWithdrawnError";
  }
}

/**
 * The approval of a reviewed installed component carries the reviewed
 * generation and the approval digest the review showed (design §18.7.5).
 * When the installed generation or digest is no longer that, nothing is
 * approved: a generation that replaced the reviewed one is never approved by
 * mistake.
 */
export class ContributionTrustReviewStaleError extends Error {
  constructor(readonly pluginId: string, readonly localId: string) {
    super(`${pluginId}:${localId} changed since it was reviewed`);
    this.name = "ContributionTrustReviewStaleError";
  }
}
