import net from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
const [mode, budgetText] = process.argv.slice(2);
const budget = Number(budgetText);
const emit = (data) => process.stdout.write(JSON.stringify(data) + "\n");
if (mode === "start") {
  emit({ marker: "runtime-started", pid: process.pid, node: process.versions.node, electron: process.versions.electron });
} else if (mode === "ancestor-exposure") {
  const fixture = JSON.parse(process.argv[4]);
  const observations = {};
  for (const [label, directory] of Object.entries(fixture.directories)) {
    try { observations[label] = { names: await readdir(directory) }; }
    catch (error) { observations[label] = { error: error.code }; }
  }
  for (const [label, file] of Object.entries(fixture.files)) {
    try { observations[label] = { contents: await readFile(file, "utf8") }; }
    catch (error) { observations[label] = { error: error.code }; }
  }
  emit({ marker: "ancestor-exposure", observations });
} else if (mode === "loopback") {

  let client, timer, settled = false, data = "";
  const server = net.createServer((socket) => socket.end("probe-loopback"));
  const finish = (error) => {
    if (settled) return;
    settled = true; clearTimeout(timer); client?.destroy(); server.close();
    const connected = !error && data === "probe-loopback";
    emit({ connected, reason: error?.code ?? error?.message, bytes: data.length });
    process.exitCode = connected ? 0 : 2;
  };
  timer = setTimeout(() => finish(new Error("deadline")), budget);
  server.on("error", finish);
  server.listen(0, "127.0.0.1", () => {
    client = net.connect(server.address().port, "127.0.0.1");
    client.on("data", (part) => { data += part; });
    client.once("end", () => finish()); client.once("error", finish);
  });
} else if (mode === "lifetime" || mode === "grandchild") {
  const timer = setInterval(() => {}, budget);
  if (mode === "lifetime") {
    const child = spawn(process.execPath, [process.argv[1], "grandchild", budgetText], {
      env: process.env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true,
    });
    child.once("error", (error) => { clearInterval(timer); emit({ error: error.message }); process.exitCode = 2; });
    child.once("spawn", () => emit({ marker: "long-lived", pid: process.pid, grandchildPid: child.pid }));
    child.stdin.on("error", () => {});
    const parentInput = createInterface({ input: process.stdin });
    parentInput.on("line", (line) => child.stdin.write(line + "\n"));
    createInterface({ input: child.stdout }).on("line", (line) => {
      const frame = JSON.parse(line);
      emit({ ...frame, pid: process.pid, grandchildPid: frame.pid });
    });
    // Deliberately keep running after input EOF: disposal must enforce the lifetime.
  } else {
    createInterface({ input: process.stdin }).on("line", (line) => {
      const { nonce } = JSON.parse(line);
      emit({ marker: "identity-confirmed", nonce, pid: process.pid });
    });
  }
} else {
  throw new Error("Unknown child measurement");
}
