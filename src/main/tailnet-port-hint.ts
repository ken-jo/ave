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
  if (separator < 1) return null;
  const headings = lines[separator - 1].trim().split(/[ \t]{2,}/);
  if (headings.length !== 2 || headings.some(heading => !/\p{L}/u.test(heading))) return null;

  let excluded = false;
  let sawLegend = false;
  for (const line of lines.slice(separator + 1)) {
    const row = line.trim();
    if (row === "") continue;
    if (sawLegend) return null;
    if (/^\*[ \t]+-[ \t]+\S/.test(row)) {
      sawLegend = true;
      continue;
    }

    const match = /^(\d{1,5})[ \t]+(\d{1,5})(?:[ \t]+\*)?$/.exec(row);
    if (!match) return null;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (start < 1 || end < start || end > 65_535) return null;
    if (port >= start && port <= end) excluded = true;
  }
  if (!sawLegend) return null;
  if (excluded) return "excluded-range";
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
