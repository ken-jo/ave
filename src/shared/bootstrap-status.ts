/**
 * Boot-install status — single source of truth for the discriminated union
 * the marketplace's boot pass (design §10.2) reports across the main process,
 * the preload bridge, and the renderer.
 *
 * Before this SoT the union was declared inline in 4 places
 * (`boot/bootstrap-status.ts`, `preload/internal-api-surface.ts`,
 * `ui/renderer/types.ts`, `ui/renderer/hooks/use-bootstrap-status.ts`), so
 * adding a variant or a field meant editing all 4 — the "Field-Addition
 * Sweep" rule this repository forbids breaking.
 *
 * Lives in `src/shared/` (not `boot/` or `ui/renderer/`) so the main-process
 * emitter and the renderer's preload bridge + UI hook can each depend on it
 * without forming a cross-boundary import; `shared/` is the neutral module
 * zone for cross-process contracts.
 */

/**
 * Why the boot-install pass was skipped instead of run.
 *
 * Closed, because the renderer has to translate it. A free-form reason string
 * reaches the user as whatever English the producer happened to write, dropped
 * verbatim into a Korean sentence, and a boolean-ish "there is a reason" test
 * cannot tell a policy decision from a failure.
 *
 *   - `e2e-isolated` — isolated E2E runtime; the network pass is off by policy
 *                      and nothing is wrong.
 */
export type BootstrapSkipReason = "e2e-isolated";

/** A skip as reported across the wire: the closed code. */
interface BootstrapSkip {
  reason: BootstrapSkipReason;
}

/**
 * The i18n key whose sentence the renderer shows. The lookup is a computed key, which the literal-key scan in
 * `src/i18n/__tests__/used-keys-exist.test.ts` cannot see, so that suite
 * asserts this table's values against every locale by name.
 */
export const BOOTSTRAP_SKIP_MESSAGE_KEY: Record<BootstrapSkipReason, string> = {
  "e2e-isolated": "bootstrapStatusPill.skippedE2eIsolated",
};

export type AppBootstrapStatus =
  /** Bootstrap call enqueued — the renderer can show a quiet spinner. */
  | { phase: "start" }
  /** Finished. `installed` and `failed` are plugin IDs; `skipped` is present
   *  only when the pass was skipped entirely, and says which decision or
   *  failure skipped it. */
  | {
      phase: "complete";
      installed: string[];
      failed: Array<{ id: string; error: string }>;
      skipped?: BootstrapSkip;
    }
  /** Bootstrap itself threw (catalog fetch failure, etc.). `message` is a
   *  single sentence, surfaced verbatim to the renderer banner. */
  | { phase: "error"; message: string };
