/**
 * Starts a detached descendant that inherits its stderr and outlives it, then
 * speaks the protocol and exits cleanly on stdin close. The descendant's pid
 * is written to stderr, so the harness can end it.
 */
import { spawn } from "node:child_process";
import { speak } from "./speak.mjs";

const descendant = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], {
  detached: true,
  stdio: ["ignore", "ignore", "inherit"],
});
descendant.unref();
process.stderr.write(`descendant-pid=${descendant.pid}\n`);
speak();
