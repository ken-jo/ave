/** Exit on stdin closure while a detached descendant retains stderr; report its PID for cleanup. */
import { spawn } from "node:child_process";
import { speak } from "./speak.mjs";

const descendant = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], {
  detached: true,
  stdio: ["ignore", "ignore", "inherit"],
});
descendant.unref();
process.stderr.write(`descendant-pid=${descendant.pid}\n`);
speak();
