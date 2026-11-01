import { createHash } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { configureHostResources } from "../../src/main/host-resources.js";
import { spawnMxcExtensionProcess, type MxcProcessLifecycleEvent } from "../../src/permissions/mxc-extension-process.js";
import { TOOL_TIMEOUT_POLICY } from "../../src/shared/tool-timeout-policy.js";
// @ts-expect-error standalone probe helpers intentionally have no declaration output
import { buildProbeFilesystem } from "./filesystem-policy.mjs";
// @ts-expect-error standalone probe helpers intentionally have no declaration output
import { safeEnvironment, windowsQuote } from "./probe-common.mjs";

const emit = (frame: object): void => { process.stdout.write(JSON.stringify(frame) + "\n"); };
async function run(): Promise<void> {
  const [runDirectory, mode, token] = process.argv.slice(2);
  if (process.platform !== "win32" || process.arch !== "x64" || !path.isAbsolute(runDirectory) || !/^[a-f0-9]{32}$/.test(token)) {
    throw new Error("Packaged probe requires Windows x64 and an owned absolute run directory");
  }
  const resources = path.join(path.dirname(process.execPath), "resources");
  configureHostResources({ resourcePath: resources, isPackaged: true });
  const proxy = createServer((_request, response) => { response.writeHead(403); response.end(); });
  proxy.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  await new Promise<void>((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const address = proxy.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture proxy address");
  const policy = buildProbeFilesystem(process.execPath, runDirectory, process.env.SYSTEMROOT);
  const request: ContainerRequest = {
    command: [process.execPath, path.join(runDirectory, "fixture.mjs"), mode === "echo" ? "echo" : "lifetime", token, String(TOOL_TIMEOUT_POLICY.processGroupPollMs)].map(windowsQuote).join(" "),
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
    if (mode === "cancel" && event.type === "spawning") controller.abort();
  };
  try {
    const owned = await spawnMxcExtensionProcess(request, { signal: controller.signal, onLifecycle });
    emit({ event: "owned", mainPid: process.pid, id: owned.id, diagnostics: owned.diagnostics, filesystemPolicy: policy });
    if (mode === "cancel") {
      await owned.dispose();
      emit({ event: "cancel", error: "Cancellation completed after readiness", pending: false });
      return;
    }
    if (mode === "echo") {
      const bytes = Buffer.alloc(4 * 1024 * 1024);
      for (let offset = 0; offset < bytes.length; offset++) bytes[offset] = offset % 251;
      const hash = createHash("sha256");
      let received = 0, backpressureWrites = 0, stderr = "";
      owned.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk).slice(-4096); });
      const resume = setTimeout(() => {
        owned.stdout.on("data", (chunk: Buffer) => { received += chunk.length; hash.update(chunk); });
      }, TOOL_TIMEOUT_POLICY.processGroupPollMs);
      try {
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          if (!owned.stdin.write(bytes.subarray(offset, offset + 32768))) { backpressureWrites++; await once(owned.stdin, "drain"); }
        }
        owned.stdin.end();
        const result = await owned.completion;
        await owned.dispose();
        emit({ event: "stdio", received, expected: bytes.length, sha256: hash.digest("hex"), expectedSha256: createHash("sha256").update(bytes).digest("hex"), backpressureWrites, stderr, result });
      } finally { clearTimeout(resume); await owned.dispose(); }
    } else {
      const controls = createInterface({ input: process.stdin });
      void owned.completion.catch(() => { controls.close(); process.stdin.destroy(); });
      createInterface({ input: owned.stdout }).on("line", (line) => emit({ event: "fixture", frame: JSON.parse(line) }));
      owned.stderr.resume();
      for await (const line of controls) {
        const frame = JSON.parse(line);
        if (frame.action === "challenge") owned.stdin.write(JSON.stringify({ nonce: frame.nonce }) + "\n");
        else if (frame.action === "dispose") { await owned.dispose(); emit({ event: "disposed" }); break; }
        else throw new Error("Unknown packaged probe command");
      }
      await owned.dispose();
    }
  } catch (error) {
    const failure = error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
    if (mode === "cancel") {
      const stopped = events.findLast((event) => event.type === "stopped");
      emit({ event: "cancel", ...failure, pending: stopped?.type === "stopped" && stopped.spawnPendingAtCancellation });
    } else { emit({ event: "failure", ...failure }); process.exitCode = 2; }
  } finally { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); }
}
void run().catch((error: unknown) => { emit({ event: "failure", name: error instanceof Error ? error.name : "Error", message: String(error) }); process.exitCode = 2; });
