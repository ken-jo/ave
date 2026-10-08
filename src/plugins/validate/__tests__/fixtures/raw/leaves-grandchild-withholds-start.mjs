/**
 * Starts a detached descendant that inherits its stdout and stderr and
 * outlives it, then answers construct, declaring a start hook, and never
 * answers start — so the run fails and the child is terminated while the
 * descendant still holds both pipes. Its pid is written to stderr.
 */
import { spawn } from "node:child_process";
import { constructed, speak, WITHHOLD } from "./speak.mjs";

const descendant = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"],
});
descendant.unref();
process.stderr.write(`descendant-pid=${descendant.pid}\n`);
speak({
  "ave/instance/construct": (request) => constructed(request.params, ["start"]),
  "ave/instance/start": WITHHOLD,
});
