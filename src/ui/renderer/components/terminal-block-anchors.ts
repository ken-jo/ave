import type { IBufferLine, IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { TERMINAL_VIEW_BLOCK_FIELD, TERMINAL_VIEW_TOKEN_FIELD } from "../../../shared/terminal-blocks.js";

/** Columns kept free after the command text before an annotation starts. */
const ANNOTATION_GAP = 2;
/** The narrowest annotation drawn: a warning glyph that opens the changes. */
const MIN_ANNOTATION_COLUMNS = 2;

/** Where one annotation renders: after the command text on its row, never over it. */
export interface TerminalAnnotationSlot {
  readonly container: HTMLElement;
  /** Terminal columns free for the annotation, from its start to the row's end. */
  readonly columns: number;
}

/** Where a block annotation renders: a container inside an xterm decoration on the block's command row. */
export interface TerminalBlockAnchors {
  /** The annotation slot for a block, or null when its command row is unknown, left the scrollback, or the command
   * text leaves no free columns on it. */
  attach(blockId: number): TerminalAnnotationSlot | null;
  subscribe(listener: () => void): () => void;
  version(): number;
}

/** The block id main put on a C marker it regenerated, proven by this incarnation's view token; null for any other
 * payload, including a program's copy of the fields in whatever OSC encoding. */
export function viewBlockId(oscData: string, viewToken: string | null): number | null {
  if (!viewToken) return null;
  const fields = oscData.split(";");
  if (fields[0] !== "C" || fields.length !== 3 || fields[2] !== `${TERMINAL_VIEW_TOKEN_FIELD}${viewToken}`) return null;
  const field = fields[1]!;
  if (!field.startsWith(TERMINAL_VIEW_BLOCK_FIELD)) return null;
  const digits = field.slice(TERMINAL_VIEW_BLOCK_FIELD.length);
  const id = /^[1-9][0-9]{0,15}$/u.test(digits) ? Number(digits) : NaN;
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Renderer-only anchors for command blocks. A marker sits on the row where the block's command was entered (the row
 * above the cursor when the shell reports C), and an annotation is an xterm decoration on that row, after the command
 * text. Nothing is written to the PTY or the xterm buffer, so rows, scrollback and what the shell sees are unchanged;
 * the decoration scrolls with its block and disappears when the row leaves the scrollback (or `clear` erases it).
 */
/** Cells the row's text occupies, wide characters counting two, trailing blanks not at all. */
function usedColumns(line: IBufferLine | undefined): number {
  if (!line) return 0;
  for (let x = line.length - 1; x >= 0; x--) {
    const cell = line.getCell(x);
    if (cell && cell.getChars().trim() !== "") return x + Math.max(1, cell.getWidth());
  }
  return 0;
}

export class XtermBlockAnchors implements TerminalBlockAnchors {
  private readonly markers = new Map<number, IMarker>();
  private readonly annotations = new Map<number, { decoration: IDecoration; slot: TerminalAnnotationSlot }>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  constructor(private readonly term: Terminal) {}

  /** Call from the OSC 133 handler while xterm parses the C marker, so the cursor is still just below the command. */
  noteCommandStart(blockId: number): void {
    if (this.markers.has(blockId)) return;
    const marker = this.term.registerMarker(-1);
    if (!marker || marker.isDisposed) return;
    this.markers.set(blockId, marker);
    marker.onDispose(() => {
      this.markers.delete(blockId);
      this.annotations.get(blockId)?.decoration.dispose();
      this.annotations.delete(blockId);
      this.bump();
    });
    this.bump();
  }

  attach(blockId: number): TerminalAnnotationSlot | null {
    const existing = this.annotations.get(blockId);
    if (existing) return existing.slot;
    const marker = this.markers.get(blockId);
    if (!marker || marker.isDisposed) return null;
    const cols = this.term.cols;
    // Starts after the command text, in cells; a command that fills its row gets no annotation there (the header badge
    // still counts the files), never one drawn over what the user typed.
    const x = usedColumns(this.term.buffer.active.getLine(marker.line)) + ANNOTATION_GAP;
    if (cols - x < MIN_ANNOTATION_COLUMNS) return null;
    const decoration = this.term.registerDecoration({ marker, x, width: cols - x, height: 1, layer: "top" });
    if (!decoration) return null;
    const container = document.createElement("div");
    container.dataset.testid = "terminal-block-annotation-anchor";
    container.dataset.blockId = String(blockId);
    container.style.height = "100%";
    container.style.pointerEvents = "auto";
    decoration.onRender((element) => {
      if (!element.contains(container)) element.appendChild(container);
    });
    decoration.onDispose(() => {
      container.remove();
      if (this.annotations.get(blockId)?.decoration === decoration) this.annotations.delete(blockId);
    });
    const slot = { container, columns: cols - x };
    this.annotations.set(blockId, { decoration, slot });
    return slot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  version(): number { return this.revision; }

  dispose(): void {
    for (const { decoration } of this.annotations.values()) decoration.dispose();
    this.annotations.clear();
    for (const marker of this.markers.values()) marker.dispose();
    this.markers.clear();
    this.listeners.clear();
  }

  private bump(): void {
    this.revision++;
    for (const listener of [...this.listeners]) listener();
  }
}
