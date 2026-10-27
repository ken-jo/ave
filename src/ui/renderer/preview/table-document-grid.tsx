/**
 * Virtualized grid for the side-panel table preview. Loaded only through
 * `React.lazy` (see `table-document-preview.tsx`) so react-data-grid lives in
 * its own renderer chunk instead of the startup bundle.
 *
 * No paste/fill handlers. Every display cell is rendered as a
 * React text node (react-data-grid's default `renderValue`), so a cell that
 * looks like markup or a formula is shown verbatim.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DataGrid, type Column, type DataGridHandle } from "react-data-grid";
import type { PreviewTableSheet } from "../../../shared/preview-document.js";

import { useTranslation } from "../../../i18n/react.js";
import { XLSX_EDIT_LIMITS } from "../../../shared/xlsx-panel-edit.js";

export type TableCellDraft = {
  row: number;
  column: number;
  type: "text" | "number" | "boolean" | "empty";
  text: string;
  formula: boolean;
};

type GridRow = readonly string[];

/** 0-based column index → spreadsheet letters (0 → A, 25 → Z, 26 → AA). */
export function columnLetters(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const ROW_NUMBER_KEY = "__row";
const ROW_HEIGHT = 24;
const HEADER_ROW_HEIGHT = 26;
/** react-data-grid draws a 1px border on each block edge of its root. */
const GRID_BORDER_BLOCK = 2;
/**
 * Below the header and two rows the grid stops shrinking and the panel scrolls
 * instead. Kept small so the file browser's default split (a ~320px preview
 * pane holding the header, path, sheet tabs and a notice) still fits whole.
 */
const GRID_MIN_BLOCK_PX = HEADER_ROW_HEIGHT + 2 * ROW_HEIGHT + GRID_BORDER_BLOCK;

/**
 * Block-axis sizing for the grid inside the side panel's flex column. The flex
 * basis is 0, so the grid adds nothing to the column's own height and takes the
 * height the panel has left; it never grows past its rows, so a short sheet
 * keeps its natural height and shows no scrollbar.
 *
 * `horizontalScrollbarPx` is the height of the grid's own horizontal scrollbar
 * when its columns overflow (0 for overlay scrollbars or when they fit). A
 * classic scrollbar takes that height out of the rows' space, so both bounds
 * make room for it — otherwise a short wide sheet would scroll vertically and
 * a one-row sheet would hide its row behind the bar.
 */
export function tableGridBlockStyle(rowCount: number, horizontalScrollbarPx: number): {
  flex: string;
  minBlockSize: string;
  maxBlockSize: string;
} {
  const contentBlock = HEADER_ROW_HEIGHT + rowCount * ROW_HEIGHT + GRID_BORDER_BLOCK;
  return {
    flex: "1 1 0",
    minBlockSize: `${Math.min(contentBlock, GRID_MIN_BLOCK_PX) + horizontalScrollbarPx}px`,
    maxBlockSize: `${contentBlock + horizontalScrollbarPx}px`,
  };
}

/** Height the element's horizontal scrollbar takes from its padding box (0 when there is none). */
export function horizontalScrollbarBlockPx(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  return Math.max(0, Math.round(element.offsetHeight - element.clientHeight - borders));
}

/** Preserve raw newline spellings outside the interval changed by the normalized textarea. */
function applyCellTextChange(raw: string, next: string): string {
  const normalized = raw.replace(/\r\n?/g, "\n");
  let prefix = 0;
  while (prefix < normalized.length && prefix < next.length && normalized[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < normalized.length - prefix && suffix < next.length - prefix
    && normalized[normalized.length - suffix - 1] === next[next.length - suffix - 1]) suffix += 1;
  const rawOffsets = [0];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === "\r" && raw[index + 1] === "\n") index += 1;
    rawOffsets.push(index + 1);
  }
  let before = raw.slice(0, rawOffsets[prefix]);
  const inserted = next.slice(prefix, next.length - suffix);
  const after = raw.slice(rawOffsets[normalized.length - suffix]);
  // An edit joining a bare CR to LF must still represent two separate newlines.
  if (before.endsWith("\r") && (inserted + after).startsWith("\n")) {
    before = before.replace(/\r+$/, (ending) => "\n".repeat(ending.length));
  }
  return before + inserted + after;
}

function CellValueEditor({ draft, locked, onChange, onSave, onCancel }: {
  draft: TableCellDraft;
  locked: boolean;
  onChange: (draft: TableCellDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, [draft.row, draft.column, draft.type]);
  return <div className="flex h-full min-w-0 items-center gap-0.5" data-testid="xlsx-cell-editor"
    onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape" && !locked) { event.preventDefault(); onCancel(); }
      if (event.key === "Enter" && !locked) { event.preventDefault(); onSave(); }
    }}>
    <select aria-label={t("chatPreviewRail.xlsxValueType")} title={t("chatPreviewRail.xlsxValueType")}
      value={draft.type} disabled={locked} className="h-full w-12 min-w-0 shrink-0 border bg-background text-[10px]"
      ref={(element) => { if (draft.type === "empty") inputRef.current = element; }}
      onChange={(event) => onChange({ ...draft, type: event.target.value as TableCellDraft["type"],
        text: event.target.value === "boolean" ? "false" : draft.text })}>
      <option value="text">{t("chatPreviewRail.xlsxTypeText")}</option>
      <option value="number">{t("chatPreviewRail.xlsxTypeNumber")}</option>
      <option value="boolean">{t("chatPreviewRail.xlsxTypeBoolean")}</option>
      <option value="empty">{t("chatPreviewRail.xlsxTypeEmpty")}</option>
    </select>
    {draft.type === "boolean" ? <select aria-label={t("chatPreviewRail.xlsxValue")} value={draft.text}
      ref={(element) => { inputRef.current = element; }} disabled={locked}
      className="h-full min-w-0 flex-1 border bg-background text-xs"
      onChange={(event) => onChange({ ...draft, text: event.target.value })}>
      <option value="true">true</option><option value="false">false</option>
    </select> : draft.type === "text" ? <textarea aria-label={t("chatPreviewRail.xlsxValue")} value={draft.text}
      ref={(element) => { inputRef.current = element; }} disabled={locked} maxLength={XLSX_EDIT_LIMITS.maxValueChars} rows={1}
      className="h-full min-w-0 flex-1 resize-none border bg-background px-1 text-xs"
      onChange={(event) => {
        const text = applyCellTextChange(draft.text, event.target.value);
        if (text.length <= XLSX_EDIT_LIMITS.maxValueChars) onChange({ ...draft, text });
      }} /> : draft.type === "number" ? <input
      aria-label={t("chatPreviewRail.xlsxValue")} value={draft.text}
      ref={(element) => { inputRef.current = element; }} disabled={locked} inputMode="decimal"
      className="h-full min-w-0 flex-1 border bg-background px-1 text-xs"
      onChange={(event) => onChange({ ...draft, text: event.target.value })} /> : null}
  </div>;
}

export function TableDocumentGrid({ sheet, label, onEditCell, draft, editLocked = false, onDraftChange, onSave, onCancel }: {
  sheet: PreviewTableSheet;
  label: string;
  onEditCell?: (row: number, column: number) => void;
  draft?: TableCellDraft | null;
  editLocked?: boolean;
  onDraftChange?: (draft: TableCellDraft) => void;
  onSave?: () => void;
  onCancel?: () => void;
}) {
  const activateCell = (row: number, key: string | undefined) => {
    if (!onEditCell || key === undefined || key === ROW_NUMBER_KEY || row < 0) return;
    const column = Number(key);
    if (Number.isInteger(column) && column >= 0 && column < (sheet.rows[row]?.length ?? 0)) {
      onEditCell(sheet.firstRow + row, sheet.firstColumn + column);
    }
  };
  const columns = useMemo<readonly Column<GridRow>[]>(() => {
    const width = sheet.rows[0]?.length ?? 0;
    const rowNumberWidth = Math.max(36, String(sheet.firstRow + sheet.rows.length).length * 8 + 16);
    return [
      {
        key: ROW_NUMBER_KEY,
        name: "",
        frozen: true,
        width: rowNumberWidth,
        minWidth: rowNumberWidth,
        resizable: false,
        cellClass: "ave-table-grid-rownum",
        renderCell: ({ rowIdx }) => sheet.firstRow + rowIdx + 1,
      },
      ...Array.from({ length: width }, (_, c): Column<GridRow> => ({
        key: String(c),
        name: columnLetters(sheet.firstColumn + c),
        resizable: true,
        minWidth: draft?.column === sheet.firstColumn + c ? 104 : 48,
        width: 120,
        renderCell: ({ row, rowIdx }) => draft && draft.row === sheet.firstRow + rowIdx
          && draft.column === sheet.firstColumn + c && onDraftChange && onSave && onCancel
          ? <CellValueEditor draft={draft} locked={editLocked} onChange={onDraftChange} onSave={onSave} onCancel={onCancel} />
          : row[c],
      })),
    ];
  }, [sheet, draft, editLocked, onDraftChange, onSave, onCancel]);

  // A classic horizontal scrollbar appears or goes away as the grid's width or
  // its column widths change; either changes the grid's content-box height, so
  // the ResizeObserver sees it. jsdom has no ResizeObserver (react-data-grid
  // guards the same way); there is no scrollbar to measure there either.
  const gridRef = useRef<DataGridHandle>(null);
  const [horizontalScrollbarPx, setHorizontalScrollbarPx] = useState(0);
  useLayoutEffect(() => {
    const element = gridRef.current?.element;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const measure = () => setHorizontalScrollbarPx(horizontalScrollbarBlockPx(element));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <DataGrid<GridRow>
      ref={gridRef}
      className="ave-table-grid"
      aria-label={label}
      data-testid="chat-side-panel-table-grid"
      columns={columns}
      rows={sheet.rows}
      onCellDoubleClick={({ rowIdx, column }, event) => {
        if (!onEditCell) return;
        event.preventGridDefault();
        activateCell(rowIdx, column.key);
      }}
      onCellKeyDown={({ rowIdx, column }, event) => {
        if (!onEditCell || event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        event.preventGridDefault();
        activateCell(rowIdx, column?.key);
      }}
      rowHeight={ROW_HEIGHT}
      headerRowHeight={HEADER_ROW_HEIGHT}
      style={{ ...tableGridBlockStyle(sheet.rows.length, horizontalScrollbarPx), inlineSize: "100%" }}
    />
  );
}
