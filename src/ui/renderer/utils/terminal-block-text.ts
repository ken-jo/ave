/** Copy and Attach use distinct text forms of the same terminal block. */
import type { TerminalBlock, TerminalBlockSummary } from "../../../shared/terminal-blocks.js";

type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Seconds with one decimal, or null while the block is still running. */
export function blockDurationSeconds(block: TerminalBlockSummary): number | null {
  if (block.endedAt === null) return null;
  return Math.max(0, Math.round((block.endedAt - block.startedAt) / 100) / 10);
}

export function blockStatusLabel(block: TerminalBlockSummary, t: Translate): string {
  if (block.status === "running") return t("terminalBlocks.running");
  if (block.exitCode === null) return t("terminalBlocks.exitUnknown");
  return t("terminalBlocks.exitCode", { code: block.exitCode });
}

/** The command as typed, then its output — the clipboard form. */
export function formatBlockForCopy(block: TerminalBlock): string {
  const output = block.output.replace(/\n+$/u, "");
  return output ? `$ ${block.command}\n${output}` : `$ ${block.command}`;
}

/** A code fence longer than any backtick run inside `body`. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/gu) ?? []) longest = Math.max(longest, run.length);
  return "`".repeat(Math.max(3, longest + 1));
}

/** The composer form: a one-line header labeling user-provided untrusted content, the terminal tab, status,
 * duration and directory, then the command and output in a fence that the output cannot close. */
export function formatBlockForChat(
  block: TerminalBlock,
  tab: { label: string; id: string },
  t: Translate,
): string {
  const seconds = blockDurationSeconds(block);
  const header = t("terminalBlocks.attachmentHeader", {
    tab: `${tab.label} · ${tab.id} · #${block.id}`,
    status: blockStatusLabel(block, t),
    duration: seconds === null ? t("terminalBlocks.running") : t("terminalBlocks.durationSeconds", { seconds }),
    cwd: block.cwd ?? t("terminalBlocks.cwdUnknown"),
  });
  const body = formatBlockForCopy(block);
  const fence = fenceFor(body);
  // A truncated block already says so inside its output, at the cut.
  return `${header}\n${fence}console\n${body}\n${fence}`;
}

/** Command-history search: case-insensitive substring over the command text. */
export function filterBlocksByCommand<T extends TerminalBlockSummary>(blocks: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...blocks];
  return blocks.filter((block) => block.command.toLowerCase().includes(needle));
}
