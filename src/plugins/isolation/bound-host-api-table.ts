/** Bind one dispatch table to the actual incarnation HostApi and the same filesystem envelope used by spawn. */
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

/** Intersect handler-group requirements so every group is satisfied by the same host object. */
export type DispatchableHostApi = Parameters<typeof createStorageHostApiPaths>[0] &
  Parameters<typeof createConfigSubscriptionHostApiPaths>[0] &
  Parameters<typeof createInteractionHostApiPaths>[0] &
  Parameters<typeof createServiceHostApiPaths>[0];

/** The private brand limits table construction to this factory or a visible explicit cast. */
const BOUND_CONFINEMENT: unique symbol = Symbol("bound-host-api-table.confinement");

/** The brand carries the enforced envelope; symbol keys stay out of advertised string-key methods. */
export type BoundHostApiDispatchTable = Record<HostApiPath, HostApiPathHandler> & {
  readonly [BOUND_CONFINEMENT]: DelegatedWorkerConfinement;
};

/** Bind the exact context.hostApi; refuse any declared path that lacks its required binding. */
export function createBoundHostApiDispatchTable(
  hostApi: DispatchableHostApi,
  /** Use the same envelope supplied to confinement so delegated workers cannot exceed the child grants. */
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
