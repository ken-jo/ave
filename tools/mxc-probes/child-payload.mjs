import net from "node:net";
import { spawn } from "node:child_process";
const [mode, budgetText] = process.argv.slice(2);
const budget = Number(budgetText);
const emit = (data) => process.stdout.write(JSON.stringify(data) + "\n");
if (mode === "start") {
  emit({ marker: "runtime-started", pid: process.pid, node: process.versions.node, electron: process.versions.electron });
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
      env: process.env, stdio: ["ignore", "ignore", "ignore"], windowsHide: true,
    });
    child.once("error", (error) => { clearInterval(timer); emit({ error: error.message }); process.exitCode = 2; });
    child.once("spawn", () => emit({ marker: "long-lived", pid: process.pid, grandchildPid: child.pid }));
    // Deliberately keep running after input EOF: disposal must enforce the lifetime.
    process.stdin.resume();
  }
} else {
  throw new Error("Unknown child measurement");
}
