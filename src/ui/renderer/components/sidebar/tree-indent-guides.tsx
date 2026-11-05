/*
 * Portions adapted from Microsoft VS Code (MIT License), Copyright (c) Microsoft Corporation.
 * Source: https://github.com/microsoft/vscode (main @ 8bf7aa09e11308534151dbfebd787793455781ce, read 2026-11-05)
 *   - src/vs/base/browser/ui/tree/abstractTree.ts — TreeRenderer: the row's indent as left padding of
 *     `defaultIndent + (depth - 1) * indent`, and `_renderIndentGuides`, one fixed-width `.indent-guide` per ancestor
 *     inside a `.monaco-tl-indent` container.
 *   - src/vs/base/browser/ui/tree/media/tree.css — `.monaco-tl-indent` (absolute, full row height, offset from the row's
 *     left edge, `pointer-events: none`) and `.indent-guide` (inline-block, full height, a 1px left border).
 * The full MIT license text and attribution are in THIRD-PARTY-NOTICES.md at the repository root.
 *
 * Changes from the original: React + Tailwind instead of DOM building; guides are always shown rather than on hover;
 * each column knows whether its ancestor has a later sibling (a blank column when it does not); and the row's own
 * column draws an elbow (├ for a child with later siblings, └ for the last one), which VS Code does not draw.
 */
import type { CSSProperties } from "react";

/** One column of a row's indent, left to right. The last column is the row's own connector to its parent. */
export type TreeGuide =
  /** An ancestor with a later sibling: its vertical line passes through this row. */
  | "line"
  /** An ancestor that was the last of its siblings: nothing to draw. */
  | "blank"
  /** This row, with a later sibling: ├. */
  | "mid"
  /** This row, the last of its siblings: └. */
  | "last";

// Every length is in rem, as the rows' own padding and icons are (`px-2`, `h-3.5`), so the guides stay under the icons at
// any interface font size.

/** Width of one level of indent, as VS Code's `indent` (the tree's per-depth step). */
const TREE_INDENT_REM = 1;

/**
 * Where the first guide column's line sits from the row's left edge: the centre of a level-1 row's leading icon, which
 * every tree row places `px-2` (0.5rem) in at `h-3.5` (0.875rem) wide — the group's chevron, a conversation's glyph, a
 * terminal's or page's icon. VS Code offsets `.monaco-tl-indent` the same way so a guide falls under its parent's
 * twistie. The half pixel centres the 1px stroke on that point.
 */
const TREE_GUIDE_OFFSET = "calc(0.9375rem - 0.5px)";

/** The gap the tree leaves between rows (`space-y-0.5`). A guide reaches up across it, so a parent's line does not break. */
const ROW_GAP_REM = 0.125;

/** How far the elbow's arm runs right: from the parent's icon centre to just short of this row's own icon. */
const ELBOW_ARM_REM = 0.375;

// VS Code's inactive guide stroke is a mid gray at 40% opacity; muted-foreground at --opacity-muted is the same weight in
// this palette and turns with the theme. `border-border` is too light to read on a hovered or selected row.
const GUIDE_LINE_CLASS = "border-muted-foreground/(--opacity-muted)";

/**
 * Rows are indented by padding on the row, as VS Code pads its twistie, so the row's hover, selection and focus ring
 * still span the full width. `baseRem` is the left padding the row has at level 1, which the indent adds to.
 */
export function treeIndentStyle(level: number, baseRem = 0): CSSProperties | undefined {
  return level > 1 ? { paddingLeft: `${baseRem + (level - 1) * TREE_INDENT_REM}rem` } : undefined;
}

/**
 * The indent columns of every row in a flat, depth-first list of `levels` (1 = top level), as the `tree` command draws
 * them. A row at level L gets L − 1 columns: column d (1-based) belongs to its ancestor at level d + 1 — a line when that
 * ancestor has a later sibling, else blank — and the last column is the row's own ├ or └.
 *
 * `levels` may hold breaks (level 0) for lines that end every run of siblings, as a time header does.
 */
export function treeGuides(levels: readonly number[]): TreeGuide[][] {
  // Whether a later row at `level` comes before any row shallower than it — that is, whether the row (or ancestor) at
  // `level` that `index` sits under has a sibling still to come.
  const hasLaterSibling = (index: number, level: number): boolean => {
    for (let next = index + 1; next < levels.length; next += 1) {
      const nextLevel = levels[next]!;
      if (nextLevel < level) return false;
      if (nextLevel === level) return true;
    }
    return false;
  };
  return levels.map((level, index) => {
    const guides: TreeGuide[] = [];
    for (let column = 1; column < level; column += 1) {
      const continues = hasLaterSibling(index, column + 1);
      if (column === level - 1) guides.push(continues ? "mid" : "last");
      else guides.push(continues ? "line" : "blank");
    }
    return guides;
  });
}

/** The columns for something drawn BELOW a row but inside its slot (a caption): every line that runs on past the row. */
export function continuationGuides(guides: readonly TreeGuide[]): TreeGuide[] {
  return guides.map((guide) => (guide === "line" || guide === "mid" ? "line" : "blank"));
}

/**
 * The guides of one tree row: an absolutely placed, click-through strip along the row's left edge (VS Code's
 * `.monaco-tl-indent`), one fixed-width column per level above the row. Decoration only — the row's `aria-level` is what
 * assistive tech reads, so every guide is hidden from it.
 */
export function TreeIndentGuides({ guides, reachUp = true }: { guides: readonly TreeGuide[]; reachUp?: boolean }) {
  if (guides.length === 0) return null;
  return (
    <span
      aria-hidden="true"
      data-testid="tree-indent-guides"
      className="pointer-events-none absolute bottom-0 flex"
      style={{ left: TREE_GUIDE_OFFSET, top: reachUp ? `-${ROW_GAP_REM}rem` : 0 }}
    >
      {guides.map((guide, column) => (
        <span
          // Columns are positional: the same column of the same row is the same guide.
          key={column}
          aria-hidden="true"
          data-tree-guide={guide}
          className="relative h-full shrink-0"
          style={{ width: `${TREE_INDENT_REM}rem` }}
        >
          {guide === "line" || guide === "mid" ? (
            <span className={`absolute inset-y-0 left-0 border-l ${GUIDE_LINE_CLASS}`} />
          ) : null}
          {guide === "mid" || guide === "last" ? (
            // The elbow, at the row's middle. └ is one element (down, then right) so its corner is one stroke; ├ already has
            // the full-height line, so its arm starts one pixel right of it rather than painting the junction twice.
            <span
              className={`absolute top-0 border-b ${guide === "last" ? "border-l" : ""} ${GUIDE_LINE_CLASS}`}
              style={{
                left: guide === "last" ? 0 : 1,
                width: guide === "last" ? `${ELBOW_ARM_REM}rem` : `calc(${ELBOW_ARM_REM}rem - 1px)`,
                height: `calc(50% + ${reachUp ? ROW_GAP_REM / 2 : 0}rem)`,
              }}
            />
          ) : null}
        </span>
      ))}
    </span>
  );
}
