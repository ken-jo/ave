/** Withhold start while a detached descendant holds inherited output pipes; report its PID for cleanup. */
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
