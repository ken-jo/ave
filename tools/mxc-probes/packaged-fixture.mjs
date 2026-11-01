import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
const [mode, token, heartbeatText] = process.argv.slice(2);
const heartbeat = Number(heartbeatText);
if (!Number.isSafeInteger(heartbeat) || heartbeat <= 0) throw new Error("Invalid fixture heartbeat interval");
const emit = (frame) => process.stdout.write(JSON.stringify({ token, ...frame }) + "\n");
if (mode === "echo") {
  for await (const bytes of process.stdin) if (!process.stdout.write(bytes)) await once(process.stdout, "drain");
  process.stderr.write("fixture-input-eof\n");
} else if (mode === "lifetime") {
  const child = spawn(process.execPath, [process.argv[1], "grandchild", token, heartbeatText], {
    env: process.env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
  });
  child.on("error", (error) => { emit({ marker: "error", message: error.message }); process.exitCode = 2; });
  const keepAlive = setInterval(() => {}, heartbeat);
  child.once("spawn", () => emit({ marker: "ready", pid: process.pid, grandchildPid: child.pid }));
  child.stdin.on("error", () => {});
  createInterface({ input: process.stdin }).on("line", (line) => child.stdin.write(line + "\n"));
  createInterface({ input: child.stdout }).on("line", (line) => {
    const frame = JSON.parse(line);
    emit({ ...frame, pid: process.pid, grandchildPid: frame.pid });
  });
  process.on("exit", () => clearInterval(keepAlive));
  // Deliberately survive stdin EOF: only the measured lifetime boundary ends us.
} else if (mode === "grandchild") {
  setInterval(() => {}, heartbeat);
  createInterface({ input: process.stdin }).on("line", (line) => {
    const { nonce } = JSON.parse(line);
    emit({ marker: "confirmed", nonce, pid: process.pid });
  });
} else throw new Error("Unknown packaged fixture mode");
