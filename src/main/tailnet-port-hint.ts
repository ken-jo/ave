import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TailnetObserverPortHint } from "../shared/tailnet-observer-config.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { win32SystemBinary } from "../shared/windows-system-path.js";

const execFileAsync = promisify(execFile);
const MIRRORED_PORT_RANGE = [44_620, 48_715] as const;
const NETSH_MAX_OUTPUT_BYTES = 64 * 1024;

export function parseWindowsTailnetPortHint(output: string, port: number): TailnetObserverPortHint | null {
  const lines = output.split(/\r?\n/);
  const separator = lines.findIndex(line => /^\s*-{2,}\s+-{2,}\s*$/.test(line));
  if (separator === -1) return null;

  for (const line of lines.slice(separator + 1)) {
    const match = /^\s*(\d{1,5})[ \t]+(\d{1,5})(?:[ \t]+\*)?\s*$/.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start > 0 && end <= 65_535 && port >= start && port <= end) return "excluded-range";
  }
  return port >= MIRRORED_PORT_RANGE[0] && port <= MIRRORED_PORT_RANGE[1] ? "mirrored-range" : null;
}

export async function getWindowsTailnetPortHint(port: number): Promise<TailnetObserverPortHint | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync(
      win32SystemBinary("netsh"),
      ["interface", "ipv4", "show", "excludedportrange", "protocol=tcp"],
      { windowsHide: true, timeout: TOOL_TIMEOUT_POLICY.tailnetPortHintMs, maxBuffer: NETSH_MAX_OUTPUT_BYTES },
    );
    return parseWindowsTailnetPortHint(stdout, port);
  } catch {
    return null;
  }
}
