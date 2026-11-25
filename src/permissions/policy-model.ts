// The filesystem policy of one confined launch, as rows no backend owns.
//
// A composer states what the launch may touch as rows. Each confinement backend has one adapter that turns the rows into its own
// request, and that adapter owns the backend's handling of absent paths and the precedence between its lists. Network egress is not
// part of the model: a confined launch reaches the network only through the egress relay endpoint it is handed.

import { t } from "../i18n/index.js";

type PolicyAccess = "rw" | "ro" | "denied";

/**
 * Why a floor row exists. A floor row takes access away.
 * - `secrets`: the protected read floor (secret and credential stores, the app's user data directory). Nothing may be granted at
 *   or beneath it unless a `floor-pierce` row covers the grant. The model does not enforce
 *   that by itself: the container adapter drops such a grant when it ranks the rows, and the sandbox runtime package's composers
 *   withhold it before they state their rows (see `toSrtConfig`).
 * - `ave-home`: the Ave home boundary. Only a more specific grant (a re-allowed child) is readable beneath it.
 * - `read-boundary`: a read deny a composer restates for this launch (sandbox private directories, other extensions' storage, a
 *   caller's own list). A more specific grant is readable beneath it.
 * - `protected-name`: the write floor (control names inside write roots, startup and persistence files, Ave's own control files).
 * - `user-deny`: a read deny the user configured. Nothing may be granted at or beneath it, and no `floor-pierce` covers it: a
 *   launch whose pierce lies at or beneath one is refused, naming the rule.
 *
 * A reason is exact where the composer knows the origin: the shared and the per-command package composers name each read deny's
 * real floor. The container composers hand over two legacy lists instead, a restated read-deny list and the protected floor, and
 * the Windows container adapter treats them differently. There a path on both lists is stated twice, once as `read-boundary` and
 * once as `secrets`, and `read-boundary` means "from the restated list", whatever the path is.
 */
export type PolicyFloorReason = "secrets" | "ave-home" | "read-boundary" | "protected-name" | "user-deny";

/**
 * Why a grant row exists. A grant row gives access.
 * - `user-grant`: a root the user or the user's settings granted.
 * - `extension-manifest`: a root an extension holds through its manifest.
 * - `launch-grant`: a root one launch was handed by a composer whose interface does not say which of the two stands behind it.
 * - `floor-pierce`: a host-minted binding, not access by itself: read grants at or beneath it stay granted under a `secrets` row,
 *   never under a `user-deny` row.
 *   Only an extension manifest's or a launch's rows may carry one.
 */
export type PolicyGrantReason = "user-grant" | "extension-manifest" | "launch-grant" | "floor-pierce";

interface PolicyRowPath {
  readonly path: string;
  /** True when `path` is taken byte for byte. False when it is a spelling a backend expands (a leading `~`, an environment reference, a pattern). */
  readonly literal: boolean;
}

export interface PolicyFloorRow extends PolicyRowPath {
  readonly access: Extract<PolicyAccess, "ro" | "denied">;
  readonly reason: PolicyFloorReason;
}

export interface PolicyGrantRow extends PolicyRowPath {
  readonly access: Extract<PolicyAccess, "rw" | "ro">;
  readonly reason: PolicyGrantReason;
}

export type PolicyRow = PolicyFloorRow | PolicyGrantRow;

declare const checkedPolicyModel: unique symbol;

/** Only `buildPolicyModel` makes one, so every model an adapter receives has passed its checks. */
export interface PolicyModel {
  /** Floors first, then user grants, extension manifests and launch grants, each in the order it was given. */
  readonly rows: readonly PolicyRow[];
  readonly [checkedPolicyModel]: true;
}

export interface PolicyModelInput {
  readonly floors: readonly PolicyFloorRow[];
  readonly userGrants: readonly PolicyGrantRow[];
  readonly extensionManifests: readonly PolicyGrantRow[];
  /** Roots handed over by a composer that cannot name their source. */
  readonly launchGrants: readonly PolicyGrantRow[];
}

const FLOOR_REASONS: ReadonlySet<string> = new Set<PolicyFloorReason>(["secrets", "ave-home", "read-boundary", "protected-name", "user-deny"]);

export function policyFloorRow(path: string, access: PolicyFloorRow["access"], reason: PolicyFloorReason, literal: boolean): PolicyFloorRow {
  return { path, literal, access, reason };
}

export function policyGrantRow(path: string, access: PolicyGrantRow["access"], reason: PolicyGrantReason, literal: boolean): PolicyGrantRow {
  return { path, literal, access, reason };
}

/** A launch refused because a user's read deny covers, or may cover, a host pierce. The message ends with its code, so the
 * plugin card shows it as a container refusal. */
export class UserReadDenyPierceError extends Error {
  constructor(readonly code: "user-deny-covers-pierce" | "user-deny-cover-undecided", message: string) {
    super(message);
    this.name = "UserReadDenyPierceError";
  }
}

/** A host pierce at or beneath a user's read deny: the user's rule wins, so the launch is refused and names it. */
export function userDenyCoversPierce(rule: string, pierce: string): Error {
  const code = "user-deny-covers-pierce";
  return new UserReadDenyPierceError(code, t("be_policyModel.userDenyCoversPierce", { rule, pierce, code }));
}

/** A user's read deny whose cover of a host pierce cannot be decided: the launch is refused as if it covered, and says it cannot tell. */
export function userDenyMayCoverPierce(rule: string, pierce: string): Error {
  const code = "user-deny-cover-undecided";
  return new UserReadDenyPierceError(code, t("be_policyModel.userDenyMayCoverPierce", { rule, pierce, code }));
}

export function isPolicyFloorRow(row: PolicyRow): row is PolicyFloorRow {
  return FLOOR_REASONS.has(row.reason);
}

function refuse(row: PolicyRow, detail: string): never {
  throw new Error(`Policy model row is invalid (${detail}): ${row.reason} ${row.access}`);
}

// The path grammar is each composer's and each backend's admission; the model only requires the fields to be there.
function checkPath(row: PolicyRow): void {
  if (typeof row.path !== "string") refuse(row, "path");
  if (typeof row.literal !== "boolean") refuse(row, "literal");
}

function checkFloor(row: PolicyFloorRow): PolicyFloorRow {
  checkPath(row);
  if (!FLOOR_REASONS.has(row.reason)) refuse(row, "not a floor reason");
  if (row.access !== "denied" && row.access !== "ro") refuse(row, "a floor row never gives access");
  // The write floor is the only floor a launch may still read.
  if ((row.access === "ro") !== (row.reason === "protected-name")) refuse(row, "floor access");
  return Object.freeze({ ...row });
}

function checkGrant(row: PolicyGrantRow, source: Exclude<PolicyGrantReason, "floor-pierce">): PolicyGrantRow {
  checkPath(row);
  // A pierce is minted by the host for one launch or one extension holder, never by a user grant.
  if (row.reason === "floor-pierce" ? source === "user-grant" : row.reason !== source) refuse(row, `not a ${source} row`);
  if (row.access !== "rw" && row.access !== "ro") refuse(row, "a grant row never denies");
  if (row.reason === "floor-pierce" && row.access !== "ro") refuse(row, "a floor pierce covers reads only");
  return Object.freeze({ ...row });
}

/** Rows are checked against the closed vocabulary and frozen. Nothing is merged, dropped or reordered within an input. */
export function buildPolicyModel(input: PolicyModelInput): PolicyModel {
  const model: Pick<PolicyModel, "rows"> = Object.freeze({
    rows: Object.freeze([
      ...input.floors.map(checkFloor),
      ...input.userGrants.map((row) => checkGrant(row, "user-grant")),
      ...input.extensionManifests.map((row) => checkGrant(row, "extension-manifest")),
      ...input.launchGrants.map((row) => checkGrant(row, "launch-grant")),
    ]),
  });
  return model as PolicyModel;
}
