/**
 * Compile-time equalities between the generated protocol client and the host
 * it is a client of. Types only: nothing imports this module and it has no
 * runtime effect. It is compiled twice — by `check:plugin-host-protocol-client`
 * (its own program, `scripts/tsconfig.plugin-host-protocol-client-assertions.json`)
 * and by `bun run typecheck`, whose root `include` has `scripts` — so the
 * equalities hold on every push even where `build` is not run.
 *
 * The client is generated from the committed schema, and the schema from the
 * host's sources; these equalities close that loop at the type level, which a
 * runtime comparison cannot do, because the unions are erased. Each is a
 * mutual-assignability check that fails to compile when either side gains or
 * loses a member, and each alias is exported so `noUnusedLocals` does not
 * flag it.
 */
import type {
  HOST_PROTOCOL_VERSION,
  HostNotification,
  HostProtocolErrorCode,
  InstanceMethod,
} from "../../schemas/plugin-host-protocol/3/protocol-client.js";
import type {
  HOST_API_WIRE_ERROR_CODES,
  HOST_PROTOCOL_NOTIFICATIONS,
  HostProtocolVersion,
} from "../../src/plugins/isolation/host-api-wire.js";
import type { PLUGIN_INSTANCE_METHODS } from "../../src/plugins/isolation/plugin-instance-wire.js";

/** `true` when `A` and `B` are each assignable to the other, `false` otherwise (never `never`, which `Assert` would accept). */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compiles only for `true`, so an inequality is a compile error at its alias. */
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
