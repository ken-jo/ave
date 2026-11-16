// Portions adapted from xtermjs/xterm.js addons/addon-serialize/src/SerializeAddon.ts @ @xterm/addon-serialize 0.14.0, Copyright (c) 2019 The xterm.js authors, MIT License.

import type { IBuffer, IBufferCell, Terminal } from "@xterm/xterm";
import { TERMINAL_REPLAY_MAX_BYTES } from "../../../shared/terminal-session.js";

/**
 * After the kept screen: leave the modes a program that was running at the end had set (mouse and focus reporting, bracketed paste, and with a soft
 * reset the scroll region, character set, keypad and cursor-key modes, a hidden cursor, colours), so the new shell starts below the old output on a
 * normal screen. A soft reset moves nothing and clears nothing. The kept text is the normal screen's; the alternate screen is not kept, and is left
 * with mode 1047, not 1049: 1049 also restores the saved cursor, which on a terminal that never saved one is the top-left corner, and the new shell
 * would draw over the last screen of the old output.
 */
export const TERMINAL_SCROLLBACK_RESET = "\x1b[?1047l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[!p\x1b[?25h\x1b[0m\r\n";

/** The UTF-8 length of `text`, counted without encoding it. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

const RESET_BYTES = utf8Bytes(TERMINAL_SCROLLBACK_RESET);

/**
 * What a host tab shows, to be kept across a restart: the terminal's screen and as much of its scrollback as fits a terminal's replay, followed by
 * {@link TERMINAL_SCROLLBACK_RESET}. When not even the screen fits, only the reset is kept. A buffer with nothing on it keeps nothing (""). Output
 * is never cut: what is kept is whole rows, as the terminal drew them.
 *
 * Every attempt stops as soon as its text passes the replay's size, so no attempt builds more than a replay's worth of text; what it reads is the
 * rows it serializes, up to that point. The whole buffer is tried first: a buffer that fits is read once. One that does not is read again from the
 * newest rows back, twice as many each time until they no longer fit, then halved down to the most that do: about twice as many attempts as the
 * screen's rows double before the replay is full, each reading at most the rows a replay's worth of text takes.
 */
export function keptTerminalOutput(terminal: Terminal): string {
  const room = TERMINAL_REPLAY_MAX_BYTES - RESET_BYTES;
  const total = terminal.buffer.normal.length;
  const links = hyperlinks(terminal);
  const newest = (rows: number): string | null => new TextSerializer(terminal.buffer.normal, terminal, links, room).serialize(total - rows, total - 1, terminal.cols);
  const whole = newest(total);
  if (whole !== null) return whole === "" ? "" : `${whole}${TERMINAL_SCROLLBACK_RESET}`;
  let fits = Math.min(total, terminal.rows);
  let best = newest(fits);
  if (best === null) return TERMINAL_SCROLLBACK_RESET;
  let over = total + 1;
  while (fits < total) {
    const rows = Math.min(total, fits * 2);
    const kept = newest(rows);
    if (kept === null) {
      over = rows;
      break;
    }
    best = kept;
    fits = rows;
  }
  while (over - fits > 1) {
    const rows = Math.floor((fits + over) / 2);
    const kept = newest(rows);
    if (kept === null) over = rows;
    else {
      best = kept;
      fits = rows;
    }
  }
  return best === "" ? "" : `${best}${TERMINAL_SCROLLBACK_RESET}`;
}

/** The emulator keeps each hyperlink's target in a registry its cells point into; the cells carry only the registry id. */
interface LinkRegistry {
  getLinkData(linkId: number): { readonly id?: string; readonly uri: string } | undefined;
}
interface LinkedCell {
  readonly fg: number;
  hasExtendedAttrs(): number;
  readonly extended: { readonly urlId: number };
}

const FG_UNDERLINE = 0x10000000;

function hyperlinks(terminal: Terminal): LinkRegistry {
  const registry = (terminal as unknown as { _core?: { _oscLinkService?: Partial<LinkRegistry> } })._core?._oscLinkService;
  if (typeof registry?.getLinkData !== "function") throw new Error("the terminal emulator has no hyperlink registry to read");
  return registry as LinkRegistry;
}

function linkId(cell: IBufferCell): number {
  const linked = cell as unknown as LinkedCell;
  return linked.hasExtendedAttrs() ? linked.extended.urlId : 0;
}

/** A cell's own underline: the emulator also reports every hyperlink cell as underlined, and the hyperlink itself draws that again. */
function underlined(cell: IBufferCell): boolean {
  return linkId(cell) === 0 ? cell.isUnderline() !== 0 : ((cell as unknown as LinkedCell).fg & FG_UNDERLINE) !== 0;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: a control character would end or break the control string a link is written as.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

/** A hyperlink as the control string that opens it, or null for one that cannot be written back as one. */
function openLink(data: { readonly id?: string; readonly uri: string } | undefined): string | null {
  if (!data || data.uri === "" || CONTROL_CHARACTER.test(data.uri)) return null;
  // The id is one parameter of the string: it cannot hold the separators between parameters and fields.
  if (data.id !== undefined && (CONTROL_CHARACTER.test(data.id) || /[;:]/u.test(data.id))) return null;
  return `\x1b]8;${data.id === undefined ? "" : `id=${data.id}`};${data.uri}\x07`;
}
const CLOSE_LINK = "\x1b]8;;\x07";

function equalFg(a: IBufferCell, b: IBufferCell): boolean {
  return a.getFgColorMode() === b.getFgColorMode() && a.getFgColor() === b.getFgColor();
}

function equalBg(a: IBufferCell, b: IBufferCell): boolean {
  return a.getBgColorMode() === b.getBgColorMode() && a.getBgColor() === b.getBgColor();
}

function equalFlags(a: IBufferCell, b: IBufferCell): boolean {
  return a.isInverse() === b.isInverse()
    && a.isBold() === b.isBold()
    && underlined(a) === underlined(b)
    && a.isOverline() === b.isOverline()
    && a.isBlink() === b.isBlink()
    && a.isInvisible() === b.isInvisible()
    && a.isItalic() === b.isItalic()
    && a.isDim() === b.isDim()
    && a.isStrikethrough() === b.isStrikethrough();
}

function isAttributeDefault(cell: IBufferCell): boolean {
  return cell.getFgColorMode() === 0 && cell.getBgColorMode() === 0 && !cell.isInverse() && !cell.isBold() && !underlined(cell)
    && !cell.isOverline() && !cell.isBlink() && !cell.isInvisible() && !cell.isItalic() && !cell.isDim() && !cell.isStrikethrough();
}

class TextSerializer {
  private rowIndex = 0;
  private allRows: string[] = [];
  private allRowSeparators: string[] = [];
  private currentRow = "";
  private nullCellCount = 0;
  /** The style the text written so far leaves set, and where that cell is (a cell cannot be copied, only read again). */
  private readonly cursorStyle: IBufferCell;
  private cursorStyleRow = 0;
  private cursorStyleCol = 0;
  /** A null cell, for whether a background is the default one. */
  private readonly backgroundCell: IBufferCell;
  private firstRow = 0;
  private lastContentRow = 0;
  /** The hyperlink the text written so far leaves open (0: none). */
  private openLinkId = 0;
  private readonly thisRowLastChar: IBufferCell;
  private readonly thisRowLastSecondChar: IBufferCell;
  private readonly nextRowFirstChar: IBufferCell;

  /** The UTF-8 size of the text written so far, rows the end may still trim included. */
  private bytes = 0;

  /** `limit`: the most UTF-8 bytes of text it writes; past that it stops and has no text to give. */
  constructor(
    private readonly buffer: IBuffer,
    private readonly terminal: Terminal,
    private readonly links: LinkRegistry,
    private readonly limit: number,
  ) {
    this.cursorStyle = buffer.getNullCell();
    this.backgroundCell = buffer.getNullCell();
    this.thisRowLastChar = buffer.getNullCell();
    this.thisRowLastSecondChar = buffer.getNullCell();
    this.nextRowFirstChar = buffer.getNullCell();
  }

  serialize(startRow: number, endRow: number, cols: number): string | null {
    // Two cells to flip between the old one and the new one.
    const cell1 = this.buffer.getNullCell();
    const cell2 = this.buffer.getNullCell();
    let oldCell = cell1;
    this.allRows = new Array<string>(Math.max(0, endRow - startRow));
    this.lastContentRow = startRow;
    this.firstRow = startRow;
    for (let row = startRow; row <= endRow; row++) {
      const line = this.buffer.getLine(row);
      if (line) {
        const end = Math.min(cols, line.length);
        for (let col = 0; col < end; col++) {
          const cell = line.getCell(col, oldCell === cell1 ? cell2 : cell1);
          if (!cell) throw new Error(`the terminal has no cell at row ${row}, column ${col}`);
          this.nextCell(cell, row, col);
          if (this.bytes > this.limit) return null;
          oldCell = cell;
        }
      }
      this.rowEnd(row, row === endRow);
      if (this.bytes > this.limit) return null;
    }
    return this.text();
  }

  private rowEnd(row: number, isLastRow: boolean): void {
    // A coloured empty cell at the end of the row is padded back, or its colour would be missing.
    if (this.nullCellCount > 0 && !equalBg(this.cursorStyle, this.backgroundCell)) this.add(`\x1b[${this.nullCellCount}X`);
    // No hyperlink stays open over what moves to the next row: the next linked cell opens it again.
    if (this.openLinkId !== 0) {
      this.add(CLOSE_LINK);
      this.openLinkId = 0;
    }
    let rowSeparator = "";
    if (!isLastRow) {
      // Background colour erase.
      if (row - this.firstRow >= this.terminal.rows) this.buffer.getLine(this.cursorStyleRow)?.getCell(this.cursorStyleCol, this.backgroundCell);
      const currentLine = this.buffer.getLine(row);
      const nextLine = this.buffer.getLine(row + 1);
      if (!currentLine || !nextLine) throw new Error(`the terminal has no row ${currentLine ? row + 1 : row}`);
      if (!nextLine.isWrapped) {
        rowSeparator = "\r\n";
      } else {
        const thisRowLastChar = currentLine.getCell(currentLine.length - 1, this.thisRowLastChar);
        const thisRowLastSecondChar = currentLine.getCell(currentLine.length - 2, this.thisRowLastSecondChar);
        const nextRowFirstChar = nextLine.getCell(0, this.nextRowFirstChar);
        if (!thisRowLastChar || !thisRowLastSecondChar || !nextRowFirstChar) throw new Error(`the terminal has no cells at the wrap of row ${row}`);
        const isNextRowFirstCharDoubleWidth = nextRowFirstChar.getWidth() > 1;
        // Whether this wrap can happen by printing: the cursor reaches the column past the last only through a printed character.
        let isValid = false;
        if (nextRowFirstChar.getChars() && (isNextRowFirstCharDoubleWidth ? this.nullCellCount <= 1 : this.nullCellCount <= 0)) {
          // The last character is not null, and a change of background on the first wrapped cell would also change the erase colour.
          if ((thisRowLastChar.getChars() || thisRowLastChar.getWidth() === 0) && equalBg(thisRowLastChar, nextRowFirstChar)) isValid = true;
          // Before a wide character on the next row, the second to last is not null either.
          if (isNextRowFirstCharDoubleWidth && (thisRowLastSecondChar.getChars() || thisRowLastSecondChar.getWidth() === 0)
            && equalBg(thisRowLastChar, nextRowFirstChar) && equalBg(thisRowLastSecondChar, nextRowFirstChar)) isValid = true;
        }
        if (!isValid) {
          // Force the wrap: print enough to wrap, step back and erase the next row's head.
          rowSeparator = "-".repeat(this.nullCellCount + 1);
          rowSeparator += "\x1b[1D\x1b[1X";
          if (this.nullCellCount > 0) {
            // Undo the filling of the null cells, which should stay null.
            rowSeparator += "\x1b[A";
            rowSeparator += `\x1b[${currentLine.length - this.nullCellCount}C`;
            rowSeparator += `\x1b[${this.nullCellCount}X`;
            rowSeparator += `\x1b[${currentLine.length - this.nullCellCount}D`;
            rowSeparator += "\x1b[B";
          }
          // The wrap is content even when nothing on the next row is visible.
          this.lastContentRow = row + 1;
        }
      }
    }
    this.bytes += utf8Bytes(rowSeparator);
    this.allRows[this.rowIndex] = this.currentRow;
    this.allRowSeparators[this.rowIndex++] = rowSeparator;
    this.currentRow = "";
    this.nullCellCount = 0;
  }

  private add(text: string): void {
    this.currentRow += text;
    this.bytes += utf8Bytes(text);
  }

  private diffStyle(cell: IBufferCell, oldCell: IBufferCell): number[] {
    const sgr: number[] = [];
    const fgChanged = !equalFg(cell, oldCell);
    const bgChanged = !equalBg(cell, oldCell);
    const flagsChanged = !equalFlags(cell, oldCell);
    if (!fgChanged && !bgChanged && !flagsChanged) return sgr;
    if (isAttributeDefault(cell)) {
      if (!isAttributeDefault(oldCell)) sgr.push(0);
      return sgr;
    }
    if (fgChanged) {
      const color = cell.getFgColor();
      if (cell.isFgRGB()) sgr.push(38, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
      else if (cell.isFgPalette()) sgr.push(...(color >= 16 ? [38, 5, color] : [color & 8 ? 90 + (color & 7) : 30 + (color & 7)]));
      else sgr.push(39);
    }
    if (bgChanged) {
      const color = cell.getBgColor();
      if (cell.isBgRGB()) sgr.push(48, 2, (color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
      else if (cell.isBgPalette()) sgr.push(...(color >= 16 ? [48, 5, color] : [color & 8 ? 100 + (color & 7) : 40 + (color & 7)]));
      else sgr.push(49);
    }
    if (flagsChanged) {
      if (cell.isInverse() !== oldCell.isInverse()) sgr.push(cell.isInverse() ? 7 : 27);
      if (cell.isBold() !== oldCell.isBold()) sgr.push(cell.isBold() ? 1 : 22);
      if (underlined(cell) !== underlined(oldCell)) sgr.push(underlined(cell) ? 4 : 24);
      if (cell.isOverline() !== oldCell.isOverline()) sgr.push(cell.isOverline() ? 53 : 55);
      if (cell.isBlink() !== oldCell.isBlink()) sgr.push(cell.isBlink() ? 5 : 25);
      if (cell.isInvisible() !== oldCell.isInvisible()) sgr.push(cell.isInvisible() ? 8 : 28);
      if (cell.isItalic() !== oldCell.isItalic()) sgr.push(cell.isItalic() ? 3 : 23);
      if (cell.isDim() !== oldCell.isDim()) sgr.push(cell.isDim() ? 2 : 22);
      if (cell.isStrikethrough() !== oldCell.isStrikethrough()) sgr.push(cell.isStrikethrough() ? 9 : 29);
    }
    return sgr;
  }

  /** Skip the null cells counted so far: move over them, and colour them first when the style has a background. */
  private skipNullCells(): void {
    if (this.nullCellCount === 0) return;
    if (!equalBg(this.cursorStyle, this.backgroundCell)) this.add(`\x1b[${this.nullCellCount}X`);
    this.add(`\x1b[${this.nullCellCount}C`);
    this.nullCellCount = 0;
  }

  private nextCell(cell: IBufferCell, row: number, col: number): void {
    // A zero-width cell is the placeholder after a wide character.
    if (cell.getWidth() === 0) return;
    const isEmptyCell = cell.getChars() === "";
    const sgr = this.diffStyle(cell, this.cursorStyle);
    // An empty cell's style counts as changed only with its background: its foreground is never drawn.
    const styleChanged = isEmptyCell ? !equalBg(this.cursorStyle, cell) : sgr.length > 0;
    if (styleChanged) {
      this.skipNullCells();
      this.lastContentRow = row;
      this.add(`\x1b[${sgr.join(";")}m`);
      const line = this.buffer.getLine(row);
      if (line !== undefined) {
        line.getCell(col, this.cursorStyle);
        this.cursorStyleRow = row;
        this.cursorStyleCol = col;
      }
    }
    if (isEmptyCell) {
      this.nullCellCount += cell.getWidth();
      return;
    }
    this.skipNullCells();
    const link = linkId(cell);
    if (link !== this.openLinkId) {
      if (this.openLinkId !== 0) this.add(CLOSE_LINK);
      const opened = link === 0 ? null : openLink(this.links.getLinkData(link));
      if (opened !== null) this.add(opened);
      this.openLinkId = opened === null ? 0 : link;
    }
    this.add(cell.getChars());
    this.lastContentRow = row;
  }

  /** The rows up to the last one with content, joined; the cursor is left after that content. */
  private text(): string {
    const rowEnd = this.lastContentRow + 1 - this.firstRow;
    let content = "";
    for (let i = 0; i < rowEnd; i++) {
      content += this.allRows[i] ?? "";
      if (i + 1 < rowEnd) content += this.allRowSeparators[i] ?? "";
    }
    return content;
  }
}
