import type { TailnetObserverPortHint } from "../shared/tailnet-observer-config.js";

const MIRRORED_PORT_RANGE = [44_620, 48_715] as const;

export function parseWindowsTailnetPortHint(output: string, port: number): TailnetObserverPortHint | null {
  // A footer without its line ending may be a partial read.
  if (!output.endsWith("\n")) return null;
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
    const { readWindowsTcpExcludedPortRanges } = await import("./document-engine-system-command.js");
    return parseWindowsTailnetPortHint(await readWindowsTcpExcludedPortRanges(), port);
  } catch {
    return null;
  }
}
