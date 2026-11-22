import { execFileSync, spawn, type ExecFileOptions } from "node:child_process";
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
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill();
    };
    const timer = setTimeout(stop, TOOL_TIMEOUT_POLICY.projectGitQueryMs);
    timer.unref();
    child.stdout.on("data", (chunk: Buffer) => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > MAX_STDOUT_BYTES) stop();
      else chunks.push(chunk);
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ stdout: "" });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(stopped ? { stdout: "" } : { stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code ?? undefined });
    });
  }).catch(() => ({ stdout: "" }));
}
