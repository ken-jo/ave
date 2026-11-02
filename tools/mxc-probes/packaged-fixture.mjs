import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { writeProbeJson } from "./packaged-processes.mjs";
const [mode, token, heartbeatText] = process.argv.slice(2);
const heartbeat = Number(heartbeatText);
if (!Number.isSafeInteger(heartbeat) || heartbeat <= 0) throw new Error("Invalid fixture heartbeat interval");
const directory = path.dirname(process.argv[1]);
await writeProbeJson(directory, mode === "grandchild" ? "grandchild.json" : "process.json", { token, pid: process.pid, role: mode });
async function file(name) {
  try { return JSON.parse(await readFile(path.join(directory, name), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
let challenged;
async function answerChallenge() {
  const challenge = await file(`challenge-${process.pid}.json`);
  if (challenge?.nonce && challenge.nonce !== challenged) {
    challenged = challenge.nonce;
    await writeProbeJson(directory, `ack-${process.pid}.json`, { token, nonce: challenged, pid: process.pid });
  }
}
if (mode === "plugin" || mode === "plugin-overflow") {
  while (!(await file("go.json"))) { await answerChallenge(); await pause(heartbeat); }
  const runtimeEntry = process.argv[5];
  if (!path.isAbsolute(runtimeEntry)) throw new Error("Missing packaged child runtime");
  const { servePluginChild } = await import(pathToFileURL(runtimeEntry).href);
  const service = servePluginChild(process.stdin, process.stdout);
  process.stdin.once("end", () => { service.hostGone(); process.exit(0); });
} else if (mode === "echo") {
  while (!(await file("go.json"))) { await answerChallenge(); await pause(heartbeat); }
  for await (const bytes of process.stdin) if (!process.stdout.write(bytes)) await once(process.stdout, "drain");
  process.stderr.write("fixture-input-eof\n");
} else if (mode === "lifetime") {
  const child = spawn(process.execPath, [process.argv[1], "grandchild", token, heartbeatText], { env: process.env, stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
  child.on("error", (error) => { process.stderr.write(error.message + "\n"); process.exitCode = 2; });
  while (true) { await answerChallenge(); await pause(heartbeat); }
} else if (mode === "grandchild" || mode === "cancel") {
  while (true) { await answerChallenge(); await pause(heartbeat); }
} else throw new Error("Unknown packaged fixture mode");
