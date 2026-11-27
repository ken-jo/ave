import { assertCodexExecutableLocation } from "./codex-executable-location.js";
import { spawnManaged, forceKillManagedChildProcess } from "./managed-child-processes.js";
import { buildSafeChildEnv } from "../tools/safe-env.js";
import { windowsPowerShellEnv } from "../shared/windows-powershell-env.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { win32SystemBinary } from "../shared/windows-system-path.js";
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const NETSH_MAX_OUTPUT_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);

export async function readWindowsTcpExcludedPortRanges(): Promise<string> {
  const { stdout } = await execFileAsync(
    win32SystemBinary("netsh"),
    ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
    { windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.tailnetPortHintMs, maxBuffer: NETSH_MAX_OUTPUT_BYTES },
  );
  return stdout;
}

/** Execute only a host-selected system utility, with bounded output and managed cancellation. */
export async function runDocumentEngineSystemCommand(command: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  await assertCodexExecutableLocation(command, "native");
  signal.throwIfAborted();
  const child = spawnManaged(command, args, { env: windowsPowerShellEnv(buildSafeChildEnv()),
    stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" }, { label: "document-engine-system-command" });
  let output = "";
  let failure: Error | undefined;
  const stop = (error: Error): void => {
    failure ??= error;
    void forceKillManagedChildProcess(child, "document engine system command cancelled");
  };
  const onAbort = (): void => stop(signal.reason instanceof Error ? signal.reason : new Error("Document engine operation cancelled"));
  const timer = setTimeout(() => stop(new Error("Document engine system command timed out")), TOOL_TIMEOUT_POLICY.documentEngineVerificationMs);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const consume = (chunk: Buffer): void => {
    if (Buffer.byteLength(output) + chunk.length > 262_144) stop(new Error("Document engine system command output exceeded its limit"));
    else output += chunk.toString("utf8");
  };
  child.stdout!.on("data", consume);
  child.stderr!.on("data", consume);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, exitSignal) => {
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(`Document engine ${basename(command)} failed (${String(code ?? exitSignal)}): ${output.trim().slice(-2_048)}`));
        else resolve();
      });
    });
    signal.throwIfAborted();
    return output;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
