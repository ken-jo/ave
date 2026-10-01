/**
 * Compile-time assertions over the plugin-isolation seam
 * (`docs/design/plugin-hostapi-protocol.md` §9.7, S1).
 *
 * Types only, and inside the root `tsconfig.json` `include`, so `bun run
 * typecheck` — and CI with it — fails when one of them stops holding. Nothing
 * imports this file; `knip.jsonc` names it as an entry.
 *
 * - The factory's spec has exactly these members. Restoring a way to hand the
 *   factory a child (`connect`), or adding any member, fails here until the
 *   set is edited in review.
 * - A protocol session's authority is a REQUIRED bound table, so a session can
 *   neither run without one nor be handed an unbound record.
 * - The transport's `request` takes instance methods only, so an MCP request
 *   cannot bypass the one producer of its metadata.
 * - The session's channel is the non-destructive set and nothing else: a
 *   member that could end the child belongs to `teardown`, not here.
 * - The signature types the frozen functions take and return keep the shape
 *   the downstream slices are written against: the MCP methods `requestMcp`
 *   sends, the two arms of a probe reply, and the validation session's input.
 */
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
    | "entryPath"
    | "childEntryPath"
    | "registerSandboxEnvelope"
    | "onMalformedCredentialSelector"
    | "observeChild"
  >
>;

export type SessionTableIsBound = Expect<
  Equal<PluginProtocolSessionSpec["table"], BoundHostApiDispatchTable>
>;

// `{}` is the probe: a required member makes `{}` not assignable to the pick.
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
