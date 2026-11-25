import { t } from "../i18n/index.js";
import { mxcConfinementStatePaths } from "./mxc-runtime-root.js";
import { isGrantPathWithin } from "./sandbox-write-policy.js";
import { srtWinConfinementStatePaths } from "./srt-win-integrity.js";

export const CONFINEMENT_STATE_WRITE_GRANT_CODE = "confinement-state-write-grant";

/** A write grant would equal, sit inside or contain a confinement backend's own state, or that state could not be located. */
export class ConfinementStateWriteGrantError extends Error {
  readonly code = CONFINEMENT_STATE_WRITE_GRANT_CODE;
  constructor(readonly path: string | undefined) {
    super(path === undefined
      ? t("be_confinementState.unresolved", { code: CONFINEMENT_STATE_WRITE_GRANT_CODE })
      : t("be_confinementState.writeGrantRefused", { path, code: CONFINEMENT_STATE_WRITE_GRANT_CODE }));
    this.name = "ConfinementStateWriteGrantError";
  }
}

/**
 * The shared step every backend's grant check runs: no write grant may equal, sit inside or contain a path the backend
 * declares as its own state. `statePaths` undefined means the backend could not locate its state; any write is refused.
 * `within(root, path)` is the backend's containment rule for its grant spellings.
 */
export function assertWriteGrantsOutsideConfinementState(
  write: readonly string[],
  statePaths: readonly string[] | undefined,
  within: (root: string, path: string) => boolean = isGrantPathWithin,
): void {
  if (write.length === 0) return;
  if (statePaths === undefined) throw new ConfinementStateWriteGrantError(undefined);
  for (const grant of write) {
    if (statePaths.some(state => within(state, grant) || within(grant, state))) throw new ConfinementStateWriteGrantError(grant);
  }
}

/** Every backend's declared state, for a grant chosen before a backend is selected. An unlocatable declaration is left to
 * that backend's own grant check, which refuses then. */
export function declaredConfinementStatePaths(): string[] {
  return [...(srtWinConfinementStatePaths() ?? []), ...mxcConfinementStatePaths()];
}
