/** Test the reverse protocol channel in memory, including deliberately malformed requests. */
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

/** Map positional arguments without marshalling so malformed values reach host validation. */
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

export function settleHostApiReply(reply: HostApiReply): unknown {
  if ("error" in reply) throw reconstructWireError(fromHostApiRpcError(reply.error));
  return reply.result;
}

export function argsOfRequest(request: HostApiRequest): unknown[] {
  return hostApiArgsOf(pathOfRequest(request), request.params ?? {}).args;
}

export function pathOfRequest(request: HostApiRequest): HostApiPath {
  const path = request.method.slice("ave/host/".length).replaceAll("/", ".");
  if (!isHostApiPath(path)) throw new Error(`not a hostApi request: ${request.method}`);
  return path;
}

interface DirectHost {
  handle(request: HostApiRequest): Promise<HostApiReply>;
  handleNotification?(notification: HostApiNotification): void;
}

/** Allocate production-shaped ids and record all requests and notifications. */
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
