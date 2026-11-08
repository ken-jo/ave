import { Loader2, type LucideIcon } from "lucide-react";
import { cn } from "../../lib/utils.js";

/** The icon steps of DESIGN.md: 12px beside captions, 14px in dense chrome, 16px in comfortable rows. */
export type LoaderSize = 12 | 14 | 16;

const SIZE_CLASS: Record<LoaderSize, string> = {
  12: "h-3 w-3",
  14: "h-3.5 w-3.5",
  16: "h-4 w-4",
};

/**
 * The one in-progress mark. It spins while motion is allowed; under `prefers-reduced-motion` it stands still, because a
 * continuous spin is exactly the motion that setting asks to stop and the busy state is carried by the adjacent label or
 * disabled control anyway. `icon` lets a control that already shows a glyph (a refresh button) spin that glyph instead of
 * swapping it, under the same rule.
 */
export function Loader({
  size = 14,
  icon: Icon = Loader2,
  className,
}: {
  size?: LoaderSize;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <Icon
      aria-hidden="true"
      data-loader=""
      className={cn(SIZE_CLASS[size], "shrink-0 animate-spin motion-reduce:animate-none", className)}
    />
  );
}
