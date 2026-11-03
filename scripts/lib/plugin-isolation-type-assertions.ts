// Compile-time assertions preserve factory shape, bound authority and non-destructive session contracts.
// Transport requests remain instance-only so metadata cannot bypass its producer.
import type { OutOfProcessPluginSpec } from "../../src/plugins/isolation/out-of-process-plugin.js";
import type {
  PluginProtocolChannel,
  PluginProtocolSessionSpec,
} from "../../src/plugins/isolation/plugin-protocol-session.js";
import type { BoundHostApiDispatchTable } from "../../src/plugins/isolation/bound-host-api-table.js";
import type {
  PluginChildProbeReply,
  PluginChildTransport,
  PluginMcpRequestMethod,
} from "../../src/plugins/isolation/plugin-child-transport.js";
import type { ValidationSessionInput } from "../../src/plugins/validate/validation-session.js";
import type { PluginInstanceMethod } from "../../src/plugins/isolation/plugin-instance-wire.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

export type OutOfProcessPluginSpecKeysAreExact = Expect<
  Equal<
    keyof OutOfProcessPluginSpec,
    | "manifest"
    | "auditLog"
    | "launch"
    | "childEntryPath"
    | "prepareMxcChild"
    | "registerSandboxEnvelope"
    | "onMalformedCredentialSelector"
    | "observeChild"
    | "onChildSpawned"
  >
>;

export type SessionTableIsBound = Expect<
  Equal<PluginProtocolSessionSpec["table"], BoundHostApiDispatchTable>
>;

// A required member prevents the empty object from satisfying the pick.
export type SessionTableIsRequired = Expect<{} extends Pick<PluginProtocolSessionSpec, "table"> ? false : true>;

export type TransportRequestTakesInstanceMethods = Expect<
  Equal<Parameters<PluginChildTransport["request"]>[0], PluginInstanceMethod>
>;

export type ChannelIsNonDestructive = Expect<
  Equal<keyof PluginProtocolChannel, "requestMcp" | "probe" | "runStopHook" | "closeInput" | "exited">
>;

export type McpRequestMethodsAreExact = Expect<
  Equal<PluginMcpRequestMethod, "server/discover" | "tools/list" | "tools/call" | "resources/read">
>;

export type ProbeReplyIsResultOrError = Expect<
  Equal<
    PluginChildProbeReply,
    | { readonly result: unknown }
    | {
        readonly error: {
          readonly code: number;
          readonly message: string;
          readonly data?: { readonly code?: unknown };
        };
      }
  >
>;

export type ValidationSessionInputKeysAreExact = Expect<
  Equal<
    keyof ValidationSessionInput,
    "manifest" | "host" | "link" | "entryPath" | "pluginRoot" | "pluginDataDir" | "signal"
  >
>;
