import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { configureHostResources } from "../../src/main/host-resources.js";
import { spawnMxcExtensionProcess, type MxcProcessLifecycleEvent } from "../../src/permissions/mxc-extension-process.js";
import { TOOL_TIMEOUT_POLICY } from "../../src/shared/tool-timeout-policy.js";
import PINS from "../../src/permissions/mxc-launcher-pins.json" with { type: "json" };
// @ts-expect-error standalone probe helpers intentionally have no declaration output
import { buildProbeFilesystem } from "./filesystem-policy.mjs";
// @ts-expect-error standalone probe helpers intentionally have no declaration output
import { safeEnvironment, windowsQuote } from "./probe-common.mjs";
// @ts-expect-error native observer is bundled only into the explicit verification entry
import { openPackagedObserver } from "./packaged-observer.mjs";
// @ts-expect-error standalone probe argument parser is bundled with this entry
import { packagedMainArguments } from "./packaged-processes.mjs";

const emit = (frame: object): void => { process.stdout.write(JSON.stringify(frame) + "\n"); };
async function run(): Promise<void> {
  const { runDirectory, mode, token, observerExecutable } = packagedMainArguments(process.argv.slice(2));
  if (process.platform !== "win32" || process.arch !== "x64" || !path.isAbsolute(runDirectory) || !/^[a-f0-9]{32}$/.test(token)) {
    throw new Error("Packaged probe requires Windows x64 and an owned absolute run directory");
  }
  const resources = path.join(path.dirname(process.execPath), "resources");
  configureHostResources({ resourcePath: resources, isPackaged: true });
  // The independent pin inspector uses the untouched trusted package. The
  // public primitive below still launches and verifies the copied package.
  const inspector = openPackagedObserver(observerExecutable, PINS);
  const supervisorHandles: unknown[] = [];
  const containerHandles: unknown[] = [];
  const controls = createInterface({ input: process.stdin });
  const queued: string[] = [];
  let controlsClosed = false;
  const waiting = new Map<string, { resolve(): void; reject(error: Error): void }>();
  const command = (action: string): Promise<void> => {
    if (controlsClosed) return Promise.reject(new Error("Probe controller disconnected"));
    const index = queued.indexOf(action);
    if (index !== -1) { queued.splice(index, 1); return Promise.resolve(); }
    return new Promise((resolve, reject) => waiting.set(action, { resolve, reject }));
  };
  controls.on("line", (line) => {
    if (line.length > 65536) throw new Error("Probe control frame exceeds bound");
    const frame = JSON.parse(line);
    if (frame.action === "owner-challenge") { emit({ event: "owner-confirmed", nonce: frame.nonce, pid: process.pid }); return; }
    if (!["begin", "run", "release", "dispose"].includes(frame.action)) throw new Error("Unknown packaged probe command");
    const resolve = waiting.get(frame.action);
    if (resolve) { waiting.delete(frame.action); resolve.resolve(); } else queued.push(frame.action);
  });
  controls.once("close", () => { controlsClosed = true; for (const waiter of waiting.values()) waiter.reject(new Error("Probe controller disconnected")); waiting.clear(); });
  const proxy = createServer((_request, response) => { response.writeHead(403); response.end(); });
  proxy.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture proxy address");
  const policy = buildProbeFilesystem(process.execPath, runDirectory, process.env.SYSTEMROOT);
  const request: ContainerRequest = {
    command: [process.execPath, path.join(runDirectory, "fixture.mjs"), mode, token, String(TOOL_TIMEOUT_POLICY.processGroupPollMs)].map(windowsQuote).join(" "),
    containment: { type: "processcontainer", config: { filesystem: { enumeratePaths: policy.enumeratePaths } } },
    workingDirectory: runDirectory, environment: safeEnvironment(runDirectory), inheritDefaultEnvironment: false,
    filesystem: policy.filesystem,
    network: { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" }, runtimeConfig: { networkProxy: `http://127.0.0.1:${address.port}` } },
    ui: { disable: false, clipboard: "none", allowInputInjection: false },
  };
  const controller = new AbortController();
  const events: MxcProcessLifecycleEvent[] = [];
  const onLifecycle = (event: MxcProcessLifecycleEvent): void => {
    events.push(event); emit({ event: "lifecycle", ...event });
    if (event.type === "supervisor-started") {
      const handle = inspector.open(0x00101001, false, event.pid);
      if (!handle) throw new Error("Cannot pin the newly spawned supervisor");
      supervisorHandles.push(handle);
      const identity = inspector.identity(handle);
      emit({ event: "supervisor-pinned", pid: event.pid, handle: inspector.handleValue(handle), createdAt: identity.createdAt.toString(), imagePath: identity.imagePath });
    }
    if (event.type === "native-created") {
      const source = supervisorHandles[0];
      if (!source) throw new Error("Cannot transfer container without a pinned supervisor");
      const handle = inspector.duplicateProcessHandle(source, event.processHandle);
      containerHandles.push(handle);
      if (inspector.pid(handle) !== event.id) throw new Error("Transferred container PID mismatch");
      const identity = inspector.identity(handle);
      emit({ event: "container-pinned", pid: event.id, handle: inspector.handleValue(handle), createdAt: identity.createdAt.toString(), imagePath: identity.imagePath });
    }
    if (mode === "cancel" && event.type === "spawning") controller.abort();
  };
  let activeProcess: Awaited<ReturnType<typeof spawnMxcExtensionProcess>> | undefined;
  try {
    emit({ event: "main-ready", pid: process.pid });
    await command("begin");
    const owned = await spawnMxcExtensionProcess(request, { signal: controller.signal, onLifecycle });
    activeProcess = owned;
    emit({ event: "owned", mainPid: process.pid, id: owned.id, diagnostics: owned.diagnostics, filesystemPolicy: policy });
    if (mode === "cancel") {
      await owned.dispose(); emit({ event: "cancel", error: "Cancellation completed after readiness", pending: false });
    } else if (mode === "echo") {
      await command("run");
      const bytes = Buffer.alloc(4 * 1024 * 1024);
      for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = offset % 251;
      const hash = createHash("sha256");
      let received = 0, stderr = "";
      owned.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk).slice(-4096); });
      owned.stdout.on("data", (chunk: Buffer) => { received += chunk.length; hash.update(chunk); });
      try {
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          if (!owned.stdin.write(bytes.subarray(offset, offset + 32768))) await once(owned.stdin, "drain");
        }
        owned.stdin.end();
        const result = await owned.completion;
        await owned.dispose();
        emit({ event: "stdio", received, expected: bytes.length, sha256: hash.digest("hex"), expectedSha256: createHash("sha256").update(bytes).digest("hex"), stderr, result });
      } finally { await owned.dispose(); }
    } else {
      const lost = owned.completion.catch(() => "lost" as const);
      owned.stdout.resume(); owned.stderr.resume();
      const action = await Promise.race([command("dispose").then(() => "dispose" as const), lost]);
      await owned.dispose();
      if (action === "dispose") emit({ event: "disposed" });
    }
  } catch (error) {
    const failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
    if (mode === "cancel") {
      const stopped = events.findLast((event) => event.type === "stopped");
      emit({ event: "cancel", ...failure, pending: stopped?.type === "stopped" && stopped.spawnPendingAtCancellation });
    } else { emit({ event: "failure", ...failure }); process.exitCode = 2; }
  } finally {
    if (activeProcess) {
      try { await activeProcess.dispose(); }
      catch (error) { emit({ event: "cleanup-failure", message: String(error) }); process.exitCode = 2; }
    }
    // Retain exact supervisor process objects until the external observer has
    // duplicated them, even when verification or cancellation made them exit.
    emit({ event: "case-complete" });
    try { if (!controlsClosed) await command("release"); }
    catch { process.exitCode = 2; }
    for (const handle of supervisorHandles) inspector.close(handle);
    for (const handle of containerHandles) inspector.close(handle);
    controls.close(); process.stdin.destroy();
    proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}
void run().catch((error: unknown) => { emit({ event: "failure", name: error instanceof Error ? error.name : "Error", message: String(error) }); process.exitCode = 2; });
