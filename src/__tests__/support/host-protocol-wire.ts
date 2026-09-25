/**
 * The reverse channel of the host protocol, spoken by hand in a test.
 *
 * The suites that exercise one hostApi member at a time wire the child's stub
 * straight into a host dispatcher in memory, and several of them also send a
 * request the stub would never build. Both need the same three conversions —
 * positional call → `ave/host/*` request, reply → value or throw, recorded
 * request → the arguments it carried — and a copy per suite would be a copy per
 * suite of the wire's shape.
 */
import {
  fromHostApiRpcError,
  hostApiArgsOf,
  hostApiParamsOf,
  isHostApiPath,
  reconstructWireError,
  type HostApiChannel,
  type HostApiNotification,
  type HostApiPath,
  type HostApiReply,
  type HostApiRequest,
  type JsonRpcRequestId,
} from "../../plugins/isolation/host-api-wire.js";

/**
 * The request the child runtime would send for `path(...args)`.
 *
 * `path` may name no member: the method is still spelled the way a member's
 * would be, so a test can show the host refusing it. The arguments are mapped
 * onto the member's parameter names as they are, with no marshalling, which is
 * what lets a test put a malformed value in front of the host.
 */
export function hostApiRequest(
  path: string,
  args: readonly unknown[],
  id: JsonRpcRequestId = "raw",
): HostApiRequest {
  return {
    jsonrpc: "2.0",
    id,
    method: `ave/host/${path.replaceAll(".", "/")}`,
    params: isHostApiPath(path) ? hostApiParamsOf(path, args) : {},
  };
}

/** Settle a reply the way the child does: its value, or the error that crossed. */
export function settleHostApiReply(reply: HostApiReply): unknown {
  if ("error" in reply) throw reconstructWireError(fromHostApiRpcError(reply.error));
  return reply.result;
}

/** The positional arguments a recorded request carried, as the host reads them. */
export function argsOfRequest(request: HostApiRequest): unknown[] {
  return hostApiArgsOf(pathOfRequest(request), request.params ?? {}).args;
}

/** The member a recorded request named. */
export function pathOfRequest(request: HostApiRequest): HostApiPath {
  const path = request.method.slice("ave/host/".length).replaceAll("/", ".");
  if (!isHostApiPath(path)) throw new Error(`not a hostApi request: ${request.method}`);
  return path;
}

/** What a dispatcher offers a channel wired straight into it. */
interface DirectHost {
  handle(request: HostApiRequest): Promise<HostApiReply>;
  handleNotification?(notification: HostApiNotification): void;
}

/**
 * A child channel wired straight into a host dispatcher, in memory.
 *
 * It allocates ids the way the production channel does and records every
 * request and notification it carried, so a test can assert what crossed.
 */
export function directHostApiChannel(
  host: DirectHost,
  record: {
    readonly requests?: HostApiRequest[];
    readonly notifications?: HostApiNotification[];
  } = {},
): HostApiChannel {
  let nextId = 0;
  return {
    call(method, params, onSent) {
      nextId += 1;
      const request: HostApiRequest = { jsonrpc: "2.0", id: nextId, method, params };
      record.requests?.push(request);
      onSent?.(nextId);
      return host.handle(request);
    },
    notify(notification) {
      record.notifications?.push(notification);
      host.handleNotification?.(notification);
    },
  };
}
