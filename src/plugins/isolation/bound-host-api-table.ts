/** Bind one dispatch table to the actual incarnation HostApi and the same filesystem envelope used by spawn. */
import {
  HOSTAPI_DISPATCH_TABLE,
  createConfigSubscriptionHostApiPaths,
  createInteractionHostApiPaths,
  createServiceHostApiPaths,
  createStorageHostApiPaths,
  type DelegatedWorkerConfinement,
  type HostApiPathHandler,
  unimplementedHostApiPath,
} from "./host-api-dispatcher.js";
import {
  HOST_PROTOCOL_CURRENT_VERSION,
  HostApiBoundaryError,
  isLegacyHostProtocolVersion,
  type HostApiPath,
  type ServedHostProtocolVersion,
} from "./host-api-wire.js";

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

/** Members a legacy connection never reaches: protocol 3 had plugin-checked OAuth state (§3.3.1). */
const LEGACY_WITHHELD_PATHS = ["authRedirect.open", "authRedirect.wait", "authRedirect.close"] as const satisfies readonly HostApiPath[];

/** Refuse without reaching the host; unimplemented status keeps the member out of advertised capabilities. */
function legacyWithheldPath(path: HostApiPath, version: ServedHostProtocolVersion): HostApiPathHandler {
  return {
    ...unimplementedHostApiPath(path),
    invoke: () =>
      Promise.reject(
        new HostApiBoundaryError(
          "path-not-implemented",
          `[host-api-dispatcher] '${path}': authRedirect requires host protocol ${HOST_PROTOCOL_CURRENT_VERSION} — migrate this extension`,
          { path, hostProtocol: version, requiredHostProtocol: HOST_PROTOCOL_CURRENT_VERSION },
        ),
      ),
  };
}

/** The table one connection serves at its negotiated version; the current version serves the bound table unchanged. */
export function hostApiTableForProtocol(
  table: BoundHostApiDispatchTable,
  version: ServedHostProtocolVersion,
): BoundHostApiDispatchTable {
  if (!isLegacyHostProtocolVersion(version)) return table;
  const withheld = Object.fromEntries(LEGACY_WITHHELD_PATHS.map((path) => [path, legacyWithheldPath(path, version)]));
  return { ...table, ...withheld };
}
