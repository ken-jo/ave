import { win32 as winPath } from "node:path";
import { t } from "../i18n/index.js";
import { canonicalWhereItExists, mxcConfinementStatePaths } from "./mxc-runtime-root.js";
import { isWindowsPathAtOrUnder } from "./mxc-windows.js";
import { srtWinConfinementStatePaths } from "./srt-win-integrity.js";

const CONFINEMENT_STATE_WRITE_GRANT_CODE = "confinement-state-write-grant";

/** A write grant would equal, sit inside or contain a confinement backend's own state, or it or that state could not be
 * located. */
export class ConfinementStateWriteGrantError extends Error {
  readonly code = CONFINEMENT_STATE_WRITE_GRANT_CODE;
  constructor(readonly path: string | undefined, readonly reason: "overlap" | "grant-unresolved" = "overlap") {
    super(path === undefined
      ? t("be_confinementState.unresolved", { code: CONFINEMENT_STATE_WRITE_GRANT_CODE })
      : reason === "grant-unresolved"
        ? t("be_confinementState.grantUnresolved", { path, code: CONFINEMENT_STATE_WRITE_GRANT_CODE })
        : t("be_confinementState.writeGrantRefused", { path, code: CONFINEMENT_STATE_WRITE_GRANT_CODE }));
    this.name = "ConfinementStateWriteGrantError";
  }
}

/** `path` with its deepest existing ancestor resolved and the missing rest kept; undefined when no ancestor resolves or the
 * filesystem refuses the lookup. Never a lexical fallback. */
function strictlyResolved(path: string): string | undefined {
  if (!/^[A-Za-z]:\\/u.test(path)) return undefined;
  try { return canonicalWhereItExists(winPath.normalize(path), winPath); }
  catch { return undefined; }
}

/** Each declared state path as spelled and as resolved; undefined when the declaration is missing or any path is unproven. */
function resolvedStatePaths(statePaths: readonly string[] | undefined): string[] | undefined {
  if (statePaths === undefined) return undefined;
  const resolved: string[] = [];
  for (const state of statePaths) {
    const real = strictlyResolved(state);
    if (real === undefined) return undefined;
    resolved.push(state, real);
  }
  return resolved;
}

/**
 * The shared step every backend's grant check runs: no write grant may equal, sit inside or contain a path the backend
 * declares as its own state. Each grant is compared as spelled and as the identity it resolves to, which an alias or
 * a link on its path would otherwise hide. A declaration that is missing or does not resolve refuses every write; a
 * grant that does not resolve is refused.
 */
export function assertWriteGrantsOutsideConfinementState(write: readonly string[], statePaths: readonly string[] | undefined): void {
  if (write.length === 0) return;
  const states = resolvedStatePaths(statePaths);
  if (states === undefined) throw new ConfinementStateWriteGrantError(undefined);
  for (const grant of write) {
    const real = strictlyResolved(grant);
    if (real === undefined) throw new ConfinementStateWriteGrantError(grant, "grant-unresolved");
    if ([grant, real].some(spelling => states.some(state =>
      isWindowsPathAtOrUnder(spelling, state) || isWindowsPathAtOrUnder(state, spelling)))) {
      throw new ConfinementStateWriteGrantError(grant);
    }
  }
}

/** Every backend's declared state, for a grant chosen before a backend is selected; undefined when one cannot be located.
 * Both declaring backends grant on Windows only. */
export function declaredConfinementStatePaths(): string[] | undefined {
  if (process.platform !== "win32") return [];
  const srtWin = srtWinConfinementStatePaths();
  return srtWin === undefined ? undefined : [...srtWin, ...mxcConfinementStatePaths()];
}
