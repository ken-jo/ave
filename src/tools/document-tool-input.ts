import { z } from "zod";

export const DOCUMENT_TOOL_LIMITS = Object.freeze({
  defaultRows: 20,
  defaultColumns: 10,
  maxRows: 100,
  maxColumns: 50,
  maxCells: 500,
  maxOutputChars: 6000,
  maxOutputBytes: 16 * 1024,
  maxEstimatedTokens: 1800,
  maxOutputLines: 100,
  maxSheetNames: 10,
  maxLabelChars: 120,
});

const NonnegativeIndexSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const SheetSelectionSchema = z.object({
  kind: z.literal("sheet"),
  sheet: NonnegativeIndexSchema.default(0),
  rowOffset: NonnegativeIndexSchema.optional(),
  columnOffset: NonnegativeIndexSchema.optional(),
  rowCount: z.number().int().min(1).max(DOCUMENT_TOOL_LIMITS.maxRows).default(DOCUMENT_TOOL_LIMITS.defaultRows),
  columnCount: z.number().int().min(1).max(DOCUMENT_TOOL_LIMITS.maxColumns).default(DOCUMENT_TOOL_LIMITS.defaultColumns),
}).strict();

const PageSelectionSchema = z.object({
  kind: z.literal("page"),
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  textOffset: NonnegativeIndexSchema.default(0),
  includeImage: z.boolean().default(false),
}).strict();

const InfoSelectionSchema = z.object({
  kind: z.literal("info"),
  sheetOffset: NonnegativeIndexSchema.default(0),
}).strict();

export const ReadDocumentInputSchema = z.object({
  path: z.string().min(1),
  selection: z.discriminatedUnion("kind", [SheetSelectionSchema, PageSelectionSchema, InfoSelectionSchema]).optional(),
}).strict().superRefine((input, context) => {
  if (input.selection?.kind === "sheet") {
    const { rowOffset, columnOffset, rowCount, columnCount } = input.selection;
    if (rowCount * columnCount > DOCUMENT_TOOL_LIMITS.maxCells) {
      context.addIssue({ code: "custom", path: ["selection"], message: `A sheet window may contain at most ${DOCUMENT_TOOL_LIMITS.maxCells} cells` });
    }
    if (!Number.isSafeInteger((rowOffset ?? 0) + rowCount) || !Number.isSafeInteger((columnOffset ?? 0) + columnCount)) {
      context.addIssue({ code: "custom", path: ["selection"], message: "Sheet window endpoints must be safe integers" });
    }
  }
});

export const OpenDocumentInputSchema = z.object({ path: z.string().min(1) }).strict();

export type ReadDocumentInput = z.output<typeof ReadDocumentInputSchema>;
export type ReadDocumentSelection = NonNullable<ReadDocumentInput["selection"]>;
