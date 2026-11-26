import { win32 as winPath } from "node:path";
import { t } from "../i18n/index.js";
import { canonicalWhereItExists, mxcConfinementStatePaths } from "./mxc-runtime-root.js";
import { isWindowsPathAtOrUnder } from "./mxc-windows.js";
import { srtWinConfinementStatePaths } from "./srt-win-integrity.js";

const CONFINEMENT_STATE_WRITE_GRANT_CODE = "confinement-state-write-grant";

/** Which kind of backend state a declared path is, named in the refusal. */
export type ConfinementStateClass = "helper-ledger" | "container-runtime";

export interface ConfinementStatePath {
  readonly path: string;
  readonly stateClass: ConfinementStateClass;
}

const STATE_CLASS_KEY = {
  "helper-ledger": "be_confinementState.helperLedgerClass",
  "container-runtime": "be_confinementState.containerRuntimeClass",
} as const;

/** A write grant would equal, sit inside or contain a confinement backend's own state, or it or that state could not be
 * located. */
export class ConfinementStateWriteGrantError extends Error {
  readonly code = CONFINEMENT_STATE_WRITE_GRANT_CODE;
  constructor(path: undefined);
  constructor(path: string, reason: ConfinementStateClass | "grant-unresolved");
  constructor(readonly path: string | undefined, readonly reason?: ConfinementStateClass | "grant-unresolved") {
    const code = CONFINEMENT_STATE_WRITE_GRANT_CODE;
    super(path === undefined || reason === undefined
      ? t("be_confinementState.unresolved", { code })
      : reason === "grant-unresolved"
        ? t("be_confinementState.grantUnresolved", { path, code })
        : t("be_confinementState.writeGrantRefused", { path, stateClass: t(STATE_CLASS_KEY[reason]), code }));
    this.name = "ConfinementStateWriteGrantError";
  }
}

const DRIVE_PATH = /^[A-Za-z]:\\/u;

/** `path` with its deepest existing ancestor resolved and the missing rest kept; undefined when no ancestor resolves, the
 * filesystem refuses the lookup, the identity is off a drive (a mapped drive's share) or a missing component is one
 * Windows would open under another name (a trailing dot or space, a stream). Never a lexical fallback. */
function strictlyResolved(path: string): string | undefined {
  const normalized = winPath.normalize(path);
  if (!DRIVE_PATH.test(normalized)) return undefined;
  let real: string;
  try { real = canonicalWhereItExists(normalized, winPath); }
  catch { return undefined; }
  if (!DRIVE_PATH.test(real)) return undefined;
  return real.slice(3).split("\\").some((component) => /[. ]$|:/u.test(component)) ? undefined : real;
}

/** Each declared state path as spelled and as resolved; undefined when the declaration is missing or any path is unproven. */
function resolvedStatePaths(statePaths: readonly ConfinementStatePath[] | undefined): ConfinementStatePath[] | undefined {
  if (statePaths === undefined) return undefined;
  const resolved: ConfinementStatePath[] = [];
  for (const state of statePaths) {
    const real = strictlyResolved(state.path);
    if (real === undefined) return undefined;
    resolved.push(state, { ...state, path: real });
  }
  return resolved;
}

/**
 * The shared step every grant route runs: no write grant may equal, sit inside or contain a path a backend declares as
 * its own state. Each grant is compared as spelled and as the identity it resolves to, which an alias or a link on its
 * path would otherwise hide. A declaration that is missing or does not resolve refuses every write; a grant that does
 * not resolve is refused. `stagingRoot` is the one host-minted holder root inside a backend's state the route grants
 * itself; only a grant resolving to exactly it is passed.
 */
export function assertWriteGrantsOutsideConfinementState(
  write: readonly string[],
  statePaths: readonly ConfinementStatePath[] | undefined,
  stagingRoot?: string,
): void {
  if (write.length === 0) return;
  const states = resolvedStatePaths(statePaths);
  if (states === undefined) throw new ConfinementStateWriteGrantError(undefined);
  // Nothing declared (no backend that grants on this host): there is nothing to resolve a grant against.
  if (states.length === 0) return;
  const staging = stagingRoot === undefined ? undefined : strictlyResolved(stagingRoot);
  for (const grant of write) {
    const real = strictlyResolved(grant);
    if (real === undefined) throw new ConfinementStateWriteGrantError(grant, "grant-unresolved");
    if (staging !== undefined && isWindowsPathAtOrUnder(real, staging) && isWindowsPathAtOrUnder(staging, real)) continue;
    const hit = states.find(state => [grant, real].some(spelling =>
      isWindowsPathAtOrUnder(spelling, state.path) || isWindowsPathAtOrUnder(state.path, spelling)));
    if (hit !== undefined) throw new ConfinementStateWriteGrantError(grant, hit.stateClass);
  }
}

/** Every backend's declared state, whichever backend is active: both can run on one machine. Undefined when one cannot
 * be located. Both declaring backends grant on Windows only, so no other host looks either up. */
export function declaredConfinementStatePaths(
  helperPaths?: readonly string[],
  containerPaths?: readonly string[],
): ConfinementStatePath[] | undefined {
  if (process.platform !== "win32") return [];
  const helper = helperPaths ?? srtWinConfinementStatePaths();
  if (helper === undefined) return undefined;
  return [
    ...helper.map((path) => ({ path, stateClass: "helper-ledger" as const })),
    ...(containerPaths ?? mxcConfinementStatePaths()).map((path) => ({ path, stateClass: "container-runtime" as const })),
  ];
}
