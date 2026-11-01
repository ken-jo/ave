import { Socket } from "node:net";
import { bootstrapMxcSupervisor } from "./mxc-supervisor-bootstrap.js";
import { MxcExtensionChannel } from "./mxc-extension-channel.js";
import { serveMxcSupervisor } from "./mxc-supervisor-service.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";

async function run(): Promise<void> {
  const [nodeModules, generation] = process.argv.slice(2);
  const liveness = new Socket({ fd: 3, readable: true, writable: false });
  const key = await new Promise<Buffer>((resolve, reject) => {
    const key = Buffer.alloc(32);
    let offset = 0;
    const timer = setTimeout(() => finish(new MxcProcessContractError("Supervisor authentication deadline exceeded")), TOOL_TIMEOUT_POLICY.mxcRequestTransportMs);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      liveness.off("data", data); liveness.off("end", ended); liveness.off("close", ended); liveness.off("error", finish);
      liveness.pause();
      if (error) reject(error); else resolve(key);
    };
    const ended = (): void => finish(new MxcProcessContractError("Supervisor owner disconnected"));
    const data = (chunk: Buffer): void => {
      if (chunk.length > 32 - offset) return finish(new MxcProcessContractError("Invalid supervisor authentication key"));
      chunk.copy(key, offset); offset += chunk.length;
      if (offset === 32) finish();
    };
    liveness.on("data", data); liveness.once("end", ended); liveness.once("close", ended); liveness.once("error", finish);
  });
  const channel = new MxcExtensionChannel(process.stdin, process.stdout, generation, key, "supervisor");
  // stdout is exclusively the authenticated protocol. Diagnostics never become frames.
  process.stdout.on("error", () => process.exit(1));
  await serveMxcSupervisor(channel, liveness, () => bootstrapMxcSupervisor(nodeModules), () => process.exit(1));
}

void run().then(() => process.exit(0), () => {
  process.stderr.write("Native extension supervisor failed\n");
  process.exit(1);
});
