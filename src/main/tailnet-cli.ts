import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";

// On macOS the installed app bundle provides a CLI even when PATH has no entry.
const MACOS_TAILSCALE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

const TAILSCALE_CLI_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const execFileAsync = promisify(execFile);

// Command execution is separate from status interpretation and setup decisions.
export type TailscaleCommandResult =
  | { readonly kind: "ran"; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly detail: string; readonly category?: "timeout" | "execution-failed" };

export type TailscaleCommandRunner = (
  cliPath: string,
  args: readonly string[],
) => Promise<TailscaleCommandResult>;

export function tailscaleCliPath(platformName: NodeJS.Platform): string {
  return platformName === "darwin" && existsSync(MACOS_TAILSCALE_CLI)
    ? MACOS_TAILSCALE_CLI
    : "tailscale";
}

export async function runTailscaleCommand(
  cliPath: string,
  args: readonly string[],
): Promise<TailscaleCommandResult> {
  try {
    const { stdout, stderr } = await execFileAsync(cliPath, [...args], {
      encoding: "utf8",
      timeout: TOOL_TIMEOUT_POLICY.tailnetIdentityProbeMs,
      maxBuffer: TAILSCALE_CLI_MAX_OUTPUT_BYTES,
      windowsHide: true,
    });
    return { kind: "ran", code: 0, stdout, stderr };
  } catch (err) {
    const error = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (error.code === "ENOENT") return { kind: "not-found" };
    if (typeof error.code === "number") {
      return {
        kind: "ran",
        code: error.code,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
      };
    }
    return { kind: "failed", detail: error.message, category: (error as { killed?: boolean }).killed ? "timeout" : "execution-failed" };
  }
}
