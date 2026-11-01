import { createHmac, timingSafeEqual } from "node:crypto";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { MxcProcessContractError } from "./mxc-extension-errors.js";
import { assertMxcExtensionRequest } from "./mxc-extension-request.js";

export const MXC_FRAME_MAX_BYTES = 64 * 1024;
export const MXC_STREAM_CHUNK_BYTES = 32 * 1024;

type StreamFrame = { type: "stdin" | "stdout" | "stderr"; data: string };
type ControlFrame = { type: "stdin-end" | "stop" | "stopped" };
type StartFrame = { type: "start"; request: ContainerRequest };
type ReadyFrame = { type: "ready"; id: number; nodeVersion: string; nativeModules: string[] };
type ExitFrame = { type: "exit"; exitCode: number; timedOut: boolean };
type FailureFrame = { type: "error"; code: "contract" | "cleanup" | "supervisor-lost"; message: string };
export type MxcStreamFrame = (StreamFrame | ControlFrame | StartFrame | ReadyFrame | ExitFrame | FailureFrame) & {
  version: 1;
  generation: string;
  sequence: number;
};

function validateFrame(value: unknown, generation: string, sequence: number): asserts value is MxcStreamFrame {
  const fail = (): never => { throw new MxcProcessContractError("Invalid supervisor frame"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  if (!/^[a-f0-9]{64}$/.test(generation) || !Number.isSafeInteger(sequence) || sequence < 0) fail();
  const frame = value as Record<string, unknown>;
  if (frame.version !== 1 || frame.generation !== generation || frame.sequence !== sequence) fail();
  let fields: string[];
  switch (frame.type) {
    case "stdin": case "stdout": case "stderr":
      if (typeof frame.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)
        || Buffer.byteLength(frame.data, "base64") > MXC_STREAM_CHUNK_BYTES) fail();
      fields = ["data"];
      break;
    case "stdin-end": case "stop": case "stopped": fields = []; break;
    case "start": assertMxcExtensionRequest(frame.request); fields = ["request"]; break;
    case "ready":
      if (!Number.isSafeInteger(frame.id) || (frame.id as number) <= 0 || typeof frame.nodeVersion !== "string" || frame.nodeVersion.length > 64
        || !Array.isArray(frame.nativeModules) || frame.nativeModules.length > 16
        || frame.nativeModules.some((entry) => typeof entry !== "string" || entry.length > 32768)) fail();
      fields = ["id", "nodeVersion", "nativeModules"];
      break;
    case "exit":
      if (!Number.isInteger(frame.exitCode) || typeof frame.timedOut !== "boolean") fail();
      fields = ["exitCode", "timedOut"];
      break;
    case "error":
      if (!["contract", "cleanup", "supervisor-lost"].includes(String(frame.code))
        || typeof frame.message !== "string" || frame.message.length > 1024) fail();
      fields = ["code", "message"];
      break;
    default: return fail();
  }
  const allowed = new Set(["version", "generation", "sequence", "type", ...fields]);
  if (Object.keys(frame).some((key) => !allowed.has(key))) fail();
}

type ChannelDirection = "host" | "supervisor";
const MAC_BYTES = 32;
function authenticate(body: Buffer, key: Buffer, direction: ChannelDirection): Buffer {
  if (key.length !== MAC_BYTES) throw new MxcProcessContractError("Invalid supervisor channel key");
  return createHmac("sha256", key).update(direction).update(body).digest();
}

export function encodeMxcFrame(frame: MxcStreamFrame, key: Buffer, direction: ChannelDirection): Buffer {
  validateFrame(frame, frame.generation, frame.sequence);
  const body = Buffer.from(JSON.stringify(frame));
  if (body.length + MAC_BYTES > MXC_FRAME_MAX_BYTES) throw new MxcProcessContractError("Supervisor frame exceeds limit");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length + MAC_BYTES);
  return Buffer.concat([header, body, authenticate(body, key, direction)]);
}

/** Consume frames synchronously; the transport must await downstream drain before reading again. */
export class MxcFrameDecoder {
  private header = Buffer.alloc(4);
  private headerBytes = 0;
  private body = Buffer.alloc(0);
  private bodyBytes = 0;
  private sequence = 0;
  private failed = false;

  constructor(private readonly generation: string, private readonly key: Buffer, private readonly direction: ChannelDirection) {
    if (key.length !== MAC_BYTES) throw new MxcProcessContractError("Invalid supervisor channel key");
    if (!/^[a-f0-9]{64}$/.test(generation)) throw new MxcProcessContractError("Invalid supervisor generation");
  }

  *read(chunk: Buffer): Generator<MxcStreamFrame> {
    if (this.failed) throw new MxcProcessContractError("Supervisor decoder is closed");
    try {
      let offset = 0;
      while (offset < chunk.length) {
        if (this.headerBytes < 4) {
          const count = Math.min(4 - this.headerBytes, chunk.length - offset);
          chunk.copy(this.header, this.headerBytes, offset, offset + count);
          this.headerBytes += count;
          offset += count;
          if (this.headerBytes !== 4) continue;
          const size = this.header.readUInt32BE();
          if (size <= MAC_BYTES || size > MXC_FRAME_MAX_BYTES) throw new MxcProcessContractError("Supervisor frame exceeds limit");
          this.body = Buffer.alloc(size);
        }
        const count = Math.min(this.body.length - this.bodyBytes, chunk.length - offset);
        chunk.copy(this.body, this.bodyBytes, offset, offset + count);
        this.bodyBytes += count;
        offset += count;
        if (this.bodyBytes !== this.body.length) continue;
        const body = this.body.subarray(0, -MAC_BYTES);
        if (!timingSafeEqual(this.body.subarray(-MAC_BYTES), authenticate(body, this.key, this.direction))) {
          throw new MxcProcessContractError("Supervisor authentication failed");
        }
        const frame: unknown = JSON.parse(body.toString("utf8"));
        validateFrame(frame, this.generation, this.sequence);
        this.sequence += 1;
        this.headerBytes = 0;
        this.bodyBytes = 0;
        this.body = Buffer.alloc(0);
        yield frame;
      }
    } catch (cause) {
      this.failed = true;
      if (cause instanceof MxcProcessContractError) throw cause;
      throw new MxcProcessContractError("Malformed supervisor frame", { cause });
    }
  }

  end(): void {
    if (this.failed || this.headerBytes || this.bodyBytes) throw new MxcProcessContractError("Truncated supervisor stream");
    this.failed = true;
  }
}
