import type { Readable } from "node:stream";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";

export function isMxcSupervisorLoaderOverride(key: string): boolean {
  const name = key.toUpperCase();
  return name.startsWith("MXC_") || name === "NODE_OPTIONS" || name === "NODE_PATH";
}

export function readMxcSupervisorKey(liveness: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const key = Buffer.alloc(32);
    let offset = 0;
    const timer = setTimeout(() => finish(new MxcProcessContractError("Supervisor authentication deadline exceeded")), TOOL_TIMEOUT_POLICY.mxcRequestTransportMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      liveness.off("data", data);
      liveness.off("end", ended);
      liveness.off("close", ended);
      liveness.off("error", finish);
      liveness.pause();
      if (error) reject(error);
      else resolve(key);
    };
    const ended = (): void => finish(new MxcProcessContractError("Supervisor owner disconnected"));
    const data = (chunk: Buffer): void => {
      if (chunk.length > key.length - offset) {
        finish(new MxcProcessContractError("Invalid supervisor authentication key"));
        return;
      }
      chunk.copy(key, offset);
      offset += chunk.length;
      if (offset === key.length) finish();
    };
    liveness.on("data", data);
    liveness.once("end", ended);
    liveness.once("close", ended);
    liveness.once("error", finish);
  });
}
