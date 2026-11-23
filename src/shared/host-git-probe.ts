import { execFileSync, spawn, type ExecFileOptions } from "node:child_process";
import { forceKillManagedChildProcess } from "../main/managed-child-processes.js";
import { TOOL_TIMEOUT_POLICY } from "./tool-timeout-policy.js";

interface ProbeOutput {
  stdout: string;
  exitCode?: number;
}

type ProbeOptions = Pick<ExecFileOptions, "cwd" | "env">;
const MAX_STDOUT_BYTES = 4096;

export function runGitProbeSync(path: string, args: string[], options: ProbeOptions): ProbeOutput {
  try {
    const stdout = execFileSync(path, args, {
      ...options,
      encoding: "utf8",
      windowsHide: true,
      timeout: TOOL_TIMEOUT_POLICY.projectGitQueryMs,
      maxBuffer: MAX_STDOUT_BYTES,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { stdout, exitCode: 0 };
  } catch (error) {
    return { stdout: "", exitCode: (error as { status?: number }).status };
  }
}

export function runGitProbeAsync(path: string, args: string[], options: ProbeOptions): Promise<ProbeOutput> {
  return new Promise<ProbeOutput>((resolve) => {
    const child = spawn(path, args, { ...options, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const settle = (result: ProbeOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // A descendant that inherited stdout can hold `close` open indefinitely: settle first, then release the pipe and kill the tree.
    const stop = () => {
      if (settled) return;
      settle({ stdout: "" });
      child.stdout.destroy();
      try {
        // The Windows tree kill runs asynchronously; elsewhere the undetached probe gets a plain signal, keeping sync child APIs off discovery.
        if (process.platform === "win32") void forceKillManagedChildProcess(child, "host git probe stopped");
        else child.kill();
      } catch {
        // The probe has already settled as unavailable.
      }
    };
    const timer = setTimeout(stop, TOOL_TIMEOUT_POLICY.projectGitQueryMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_STDOUT_BYTES) stop();
      else chunks.push(chunk);
    });
    child.on("error", () => settle({ stdout: "" }));
    child.once("close", (code) => settle({ stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? undefined }));
  }).catch(() => ({ stdout: "" }));
}
