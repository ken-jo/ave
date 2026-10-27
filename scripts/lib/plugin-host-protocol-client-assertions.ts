// Compile generated-client equalities with host options in both protocol checks and typechecks.
// This module has no runtime imports.
import type {
  HOST_PROTOCOL_VERSION,
  HostAuthRedirectOpenResult,
  HostNotification,
  HostProtocolErrorCode,
  InstanceMethod,
} from "../../schemas/plugin-host-protocol/4/protocol-client.js";
import type {
  HOST_API_WIRE_ERROR_CODES,
  HOST_PROTOCOL_NOTIFICATIONS,
  HostProtocolVersion,
} from "../../src/plugins/isolation/host-api-wire.js";
import type { AuthRedirectOpenResult } from "../../src/plugins/public-contract.js";
import type { PLUGIN_INSTANCE_METHODS } from "../../src/plugins/isolation/plugin-instance-wire.js";

/** Always return a boolean: never would incorrectly satisfy Assert. */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type ErrorCodesMatchHost = Assert<
  Equal<HostProtocolErrorCode, (typeof HOST_API_WIRE_ERROR_CODES)[number]>
>;
export type InstanceMethodsMatchHost = Assert<
  Equal<InstanceMethod, (typeof PLUGIN_INSTANCE_METHODS)[keyof typeof PLUGIN_INSTANCE_METHODS]>
>;
export type ProtocolVersionMatchesHost = Assert<Equal<typeof HOST_PROTOCOL_VERSION, HostProtocolVersion>>;
export type NotificationsMatchHost = Assert<
  Equal<HostNotification, (typeof HOST_PROTOCOL_NOTIFICATIONS)[keyof typeof HOST_PROTOCOL_NOTIFICATIONS]>
>;

export type AuthRedirectOpenMatchesHost = Assert<Equal<HostAuthRedirectOpenResult, AuthRedirectOpenResult>>;
