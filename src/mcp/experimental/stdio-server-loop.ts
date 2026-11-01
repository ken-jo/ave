/** Dispatch newline-framed requests over streams; handler failures reply with internal errors without ending service. */
import type { Readable, Writable } from "node:stream";
import { frameMessage, StdioFrameDecoder } from "../stdio-framing.js";
import { RPC_INTERNAL_ERROR } from "../protocol-constants.js";
import type { JsonRpcId, JsonRpcRequest, JsonRpcResponse } from "../mcp-client.js";
import { errorMessage } from "../../shared/error-message.js";

export interface StdioRequestHandler {
  handle(request: JsonRpcRequest<JsonRpcId>): Promise<JsonRpcResponse<JsonRpcId>>;
}

export class StdioServerLoop {
  private readonly decoder: StdioFrameDecoder;
  private started = false;

  /** The mounting channel supplies its line cap; overflow propagates to the input writer. A mount may also cap
   * the bytes its output may hold unwritten: a response that would exceed it is refused as an error reply
   * for that call, so memory stays bounded without pausing input (cancellations and later calls still arrive). */
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly handler: StdioRequestHandler,
    maxLineBytes: number,
    private readonly maxQueuedOutputBytes?: number,
  ) {
    this.decoder = new StdioFrameDecoder(maxLineBytes);
  }

  start(): void {
    if (this.started) {
      throw new Error("[stdio-server-loop] already started");
    }
    this.started = true;
    this.input.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    for (const message of this.decoder.push(chunk)) {
      if (typeof message.method === "string" && message.id !== undefined) {
        void this.dispatch(message as unknown as JsonRpcRequest<JsonRpcId>);
      }
    }
  }

  private async dispatch(request: JsonRpcRequest<JsonRpcId>): Promise<void> {
    let response: JsonRpcResponse<JsonRpcId>;
    try {
      response = await this.handler.handle(request);
    } catch (err) {
      response = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: RPC_INTERNAL_ERROR,
          message: errorMessage(err),
        },
      };
    }
    let frame = frameMessage(response);
    if (this.maxQueuedOutputBytes !== undefined && this.output.writableLength + frame.length > this.maxQueuedOutputBytes) {
      frame = frameMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: RPC_INTERNAL_ERROR,
          message: `[stdio-server-loop] response refused: ${frame.length} bytes would exceed the ${this.maxQueuedOutputBytes}-byte unwritten output limit`,
          data: { code: "payload-too-large", byteLength: frame.length, limit: this.maxQueuedOutputBytes },
        },
      });
    }
    this.output.write(frame);
  }
}
