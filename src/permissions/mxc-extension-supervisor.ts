import "../main/bare-program-lookup.js";
import { Socket } from "node:net";
import { bootstrapMxcSupervisor } from "./mxc-supervisor-bootstrap.js";
import { MxcExtensionChannel } from "./mxc-extension-channel.js";
import { serveMxcSupervisor } from "./mxc-supervisor-service.js";
import { readMxcSupervisorKey } from "./mxc-supervisor-transport.js";

async function run(): Promise<void> {
  const [nodeModules, generation] = process.argv.slice(2);
  const liveness = new Socket({ fd: 3, readable: true, writable: false });
  const key = await readMxcSupervisorKey(liveness);
  const channel = new MxcExtensionChannel(process.stdin, process.stdout, generation, key, "supervisor");
  // stdout is exclusively the authenticated protocol. Diagnostics never become frames.
  process.stdout.on("error", () => process.exit(1));
  await serveMxcSupervisor(channel, liveness, () => bootstrapMxcSupervisor(nodeModules), () => process.exit(1), true);
}

void run().then(() => process.exit(0), () => {
  process.stderr.write("Native extension supervisor failed\n");
  process.exit(1);
});
