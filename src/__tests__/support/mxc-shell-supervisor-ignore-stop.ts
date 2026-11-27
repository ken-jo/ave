// Fault entry for the native suite only: a supervisor that reports ready, ignores stop and never sends a receipt. A
// detached helper inherits its stdout, so the host must settle without waiting for that pipe to close.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Socket } from "node:net";
import { MxcExtensionChannel } from "../../permissions/mxc-extension-channel.js";
import { readMxcSupervisorKey } from "../../permissions/mxc-supervisor-transport.js";

async function run(): Promise<void> {
  const [, generation] = process.argv.slice(2);
  if (!generation) throw new Error("Missing generation");
  const liveness = new Socket({ fd: 3, readable: true, writable: false });
  const control = new Socket({ fd: 4, readable: true, writable: true, allowHalfOpen: true });
  const key = await readMxcSupervisorKey(liveness);
  const channel = new MxcExtensionChannel(control, control, generation, key, "supervisor");
  let staging: string | undefined;
  // Idle (a dropped standby): leave with the owner. Once started, outlive it until the host kills this process.
  liveness.once("close", () => { if (staging === undefined) process.exit(0); });
  liveness.resume();
  for await (const frame of channel.frames()) {
    if (frame.type === "shell-start") {
      staging = dirname(frame.requestPath);
      const holder = spawn("/bin/sleep", ["60"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
      holder.unref();
      writeFileSync(join(staging, "holder.pid"), String(holder.pid));
      await channel.send({ type: "shell-ready", id: 1 });
    } else if (frame.type === "stop" && staging !== undefined) {
      // Record when the host's stop arrived, then ignore it.
      writeFileSync(join(staging, "stop-received"), String(Date.now()));
    }
  }
  await new Promise(() => {});
}

void run().catch(() => process.exit(1));
