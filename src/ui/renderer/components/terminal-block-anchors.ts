import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { TERMINAL_VIEW_BLOCK_FIELD } from "../../../shared/terminal-blocks.js";

/** Columns kept free after the command text before an annotation starts, and the narrowest annotation worth drawing. */
const ANNOTATION_GAP = 2;
const MIN_ANNOTATION_COLUMNS = 24;

/** Where a block annotation renders: a container inside an xterm decoration on the block's command row. */
export interface TerminalBlockAnchors {
  /** The annotation container for a block, or null when its command row is unknown or left the scrollback. */
  attach(blockId: number): HTMLElement | null;
  subscribe(listener: () => void): () => void;
  version(): number;
}

/** The block id main put on an authenticated OSC 133 C marker, or null for any other payload. */
export function viewBlockId(oscData: string): number | null {
  const fields = oscData.split(";");
  if (fields[0] !== "C") return null;
  const field = fields.find((value) => value.startsWith(TERMINAL_VIEW_BLOCK_FIELD));
  const id = field ? Number(field.slice(TERMINAL_VIEW_BLOCK_FIELD.length)) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Renderer-only anchors for command blocks. A marker sits on the row where the block's command was entered (the row
 * above the cursor when the shell reports C), and an annotation is an xterm decoration on that row, after the command
 * text. Nothing is written to the PTY or the xterm buffer, so rows, scrollback and what the shell sees are unchanged;
 * the decoration scrolls with its block and disappears when the row leaves the scrollback (or `clear` erases it).
 */
export class XtermBlockAnchors implements TerminalBlockAnchors {
  private readonly markers = new Map<number, IMarker>();
  private readonly annotations = new Map<number, { decoration: IDecoration; container: HTMLElement }>();
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

  attach(blockId: number): HTMLElement | null {
    const existing = this.annotations.get(blockId);
    if (existing) return existing.container;
    const marker = this.markers.get(blockId);
    if (!marker || marker.isDisposed) return null;
    const line = this.term.buffer.active.getLine(marker.line)?.translateToString(true) ?? "";
    const cols = this.term.cols;
    const width = Math.min(cols, MIN_ANNOTATION_COLUMNS);
    const x = Math.max(0, Math.min(line.length + ANNOTATION_GAP, cols - width));
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
    this.annotations.set(blockId, { decoration, container });
    return container;
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
