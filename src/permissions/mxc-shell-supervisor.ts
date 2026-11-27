import "../main/bare-program-lookup.js";
import { Socket } from "node:net";
import { MxcExtensionChannel } from "./mxc-extension-channel.js";
import { MxcProcessContractError } from "./mxc-extension-errors.js";
import { bootstrapMxcShellSupervisor } from "./mxc-shell-supervisor-bootstrap.js";
import { serveMxcShellSupervisor } from "./mxc-shell-supervisor-service.js";
import { readMxcSupervisorKey } from "./mxc-supervisor-transport.js";

async function run(): Promise<void> {
  const [nodeModules, generation, mode] = process.argv.slice(2);
  if (!nodeModules || !generation || (mode !== "packaged" && mode !== "development")) {
    throw new MxcProcessContractError("Missing shell supervisor configuration");
  }
  const liveness = new Socket({ fd: 3, readable: true, writable: false });
  const control = new Socket({ fd: 4, readable: true, writable: true, allowHalfOpen: true });
  const key = await readMxcSupervisorKey(liveness);
  const channel = new MxcExtensionChannel(control, control, generation, key, "supervisor");
  await serveMxcShellSupervisor(channel, liveness, process.stdout, process.stderr,
    () => bootstrapMxcShellSupervisor(nodeModules, mode === "packaged"), () => process.exit(1));
}

void run().then(() => process.exit(0), () => process.exit(1));
