/**
 * The dispatch table one plugin connection serves, bound to one incarnation's
 * `hostApi` and to one filesystem envelope
 * (`docs/design/plugin-hostapi-protocol.md` §9.7, S1).
 *
 * A module of its own so a protocol session can take the table as its whole
 * authority without importing the factory that spawns children: the session
 * is handed a bound table and serves exactly that, and the only things that
 * can produce one are the factory (with the envelope its spawn received) and
 * the validation session (with the base envelope). Nothing here spawns,
 * derives an envelope or reads settings.
 */
import {
  HOSTAPI_DISPATCH_TABLE,
  createConfigSubscriptionHostApiPaths,
  createInteractionHostApiPaths,
  createServiceHostApiPaths,
  createStorageHostApiPaths,
  type DelegatedWorkerConfinement,
  type HostApiPathHandler,
} from "./host-api-dispatcher.js";
import type { HostApiPath } from "./host-api-wire.js";

/**
 * The `hostApi` members a bound table needs, as the union of the four groups'
 * own narrowings.
 *
 * Stated as an intersection of what each group asks for rather than as
 * `PluginHostApi`, so a group that widens its needs widens this too — and a
 * caller cannot satisfy the assembly with an object that happens to have the
 * right shape for three groups and not the fourth.
 */
export type DispatchableHostApi = Parameters<typeof createStorageHostApiPaths>[0] &
  Parameters<typeof createConfigSubscriptionHostApiPaths>[0] &
  Parameters<typeof createInteractionHostApiPaths>[0] &
  Parameters<typeof createServiceHostApiPaths>[0];

/**
 * Module-private, so no other module can spell the brand: a value of
 * {@link BoundHostApiDispatchTable} comes from
 * {@link createBoundHostApiDispatchTable} or from an explicit cast a reviewer
 * can see.
 */
const BOUND_CONFINEMENT: unique symbol = Symbol("bound-host-api-table.confinement");

/**
 * A dispatch table bound to one `hostApi` and one envelope.
 *
 * The brand holds the envelope the table enforces, so the value says which
 * jail its `spawnWorker` check compares against. A symbol key is invisible to
 * `hostProtocolCapabilities`, which reads string keys only.
 */
export type BoundHostApiDispatchTable = Record<HostApiPath, HostApiPathHandler> & {
  readonly [BOUND_CONFINEMENT]: DelegatedWorkerConfinement;
};

/**
 * Bind every dispatched member to ONE plugin incarnation's `hostApi`.
 *
 * The instance passed here must be the one the host handed the factory —
 * `context.hostApi`, which `buildHostApiIncarnation` has already wrapped in the
 * effect recorder, the effect gate and the active-incarnation proxy. Binding a
 * freshly built hostApi instead would produce a boundary that works in every
 * test and records nothing in the field: the recorder's ledger is per-wrapper,
 * so effects would be attributed to a wrapper no one reads.
 *
 * The four spreads are applied over the shipped table rather than replacing it,
 * so a member no group claims keeps its throwing default instead of becoming
 * absent. `Record<HostApiPath, …>` makes a missing key a compile error either
 * way; this makes an UNBOUND key a loud runtime refusal.
 */
export function createBoundHostApiDispatchTable(
  hostApi: DispatchableHostApi,
  /**
   * The roots the child's own ASRT wrap grants it, so `spawnWorker` can refuse
   * a delegated worker that would reach further. In production it is the SAME
   * value `spawnConfinedPluginChild` passes to the wrap — one
   * `derivePluginChildEnvelope` result, held by the factory — because a
   * boundary that checked against a differently-derived envelope would be
   * checking against something other than the jail.
   */
  confinement: DelegatedWorkerConfinement,
  onMalformedCredentialSelector?: () => void,
): BoundHostApiDispatchTable {
  return {
    ...HOSTAPI_DISPATCH_TABLE,
    ...createStorageHostApiPaths(hostApi),
    ...createConfigSubscriptionHostApiPaths(hostApi),
    ...createInteractionHostApiPaths(hostApi),
    ...createServiceHostApiPaths(hostApi, confinement, onMalformedCredentialSelector),
    [BOUND_CONFINEMENT]: confinement,
  };
}
