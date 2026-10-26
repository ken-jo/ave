/** Clone both directions through strict JSON, refusing values that serialization would change.
 * Deliver on a microtask so pending requests register before replies arrive. */
import type {
  JsonRpcMessage,
  JsonRpcResponse,
  McpTransport,
} from "./mcp-client.js";
import type { PluginMcpServer } from "./plugin-mcp-server.js";
import { describeNonJson } from "../shared/json-representable.js";

/** Reject changed wire values with direction, request id and value path for diagnosis. */
function marshal<T>(value: T, direction: string, id: unknown): T {
  const reason = describeNonJson(value, direction);
  if (reason !== null) {
    throw new Error(
      `[loopback] ${direction} for request ${String(id)} does not survive a JSON round-trip: ${reason}. ` +
        "Loopback is in-process, so this call works here and breaks over a real transport; " +
        "give the value a JSON representation at its source rather than relying on the shared heap.",
    );
  }
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

export class LoopbackTransport implements McpTransport {
  readonly kind = "loopback" as const;

  private alive = false;
  private messageHandler: ((msg: JsonRpcResponse) => void) | null = null;
  private closeHandler: ((reason: string) => void) | null = null;

  constructor(private readonly server: PluginMcpServer) {}

  async open(): Promise<void> {
    this.alive = true;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.alive) {
      throw new Error("[loopback] transport not open");
    }
    // Reply only to requests with method and id; notifications and responses receive no reply.
    const method = "method" in message ? message.method : undefined;
    if (typeof method !== "string" || !("id" in message)) {
      return;
    }
    const response = await this.server.handle({
      jsonrpc: "2.0",
      id: message.id,
      method,
      // Params cross the boundary too. A caller handing the server a live
      // object would otherwise have the server mutate the caller's copy.
      params: marshal(message.params, "params", message.id),
    });
    const result = marshal(response.result, "result", message.id);
    const error = marshal(response.error, "error", message.id);
    queueMicrotask(() => {
      this.messageHandler?.({ jsonrpc: "2.0", id: message.id, result, error });
    });
  }

  async close(): Promise<void> {
    if (!this.alive) return;
    this.alive = false;
    this.closeHandler?.("loopback closed");
  }

  isAlive(): boolean {
    return this.alive;
  }

  onMessage(handler: (msg: JsonRpcResponse) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }
}
