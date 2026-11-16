import { revealHiddenCharacters } from "../../../shared/display-safe-text.js";
import { cn } from "../../../lib/utils.js";

/**
 * A file path on one line that gives up its folders before its file name when space runs out:
 * the folder part shrinks first and ends in an ellipsis, so the ellipsis lands in the middle and the
 * name stays readable. Hidden characters are spelled out, as on approval cards.
 */
export function PathLabel({ path, className }: { path: string; className?: string }) {
  const shown = revealHiddenCharacters(path, { lineBreaks: true });
  const separator = Math.max(shown.lastIndexOf("/"), shown.lastIndexOf("\\"));
  const directory = shown.slice(0, separator + 1);
  const name = shown.slice(separator + 1);
  return (
    <span className={cn("inline-flex min-w-0 max-w-full font-mono", className)} title={shown} data-testid="path-label">
      {directory ? <span className="min-w-0 truncate [flex-shrink:1000]" data-path-part="directory">{directory}</span> : null}
      <span className="min-w-0 truncate" data-path-part="name">{name}</span>
    </span>
  );
}
