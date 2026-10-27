import { MAX_TEXT_FILE_BYTES } from "../tools/file-read-core.js";
import { OBSERVATION_LIMITS, type PreviewObservedTextDocument } from "../shared/agent-observation.js";
import { hasExactKeys, isPlainRecord } from "../shared/is-record.js";

const TEXT_DOCUMENT_FIELDS = ["format", "content", "lines", "totalLines", "truncated"] as const;

/** Decode one admitted immutable input; source separators match the text preview. */
export function parseObservedTextDocument(bytes: Buffer): PreviewObservedTextDocument {
  if (bytes.length > MAX_TEXT_FILE_BYTES || bytes.includes(0)) throw new Error("Invalid observed text document.");
  const text = bytes.toString("utf8");
  const lines: string[] = [];
  const separators = /\r\n|\r|\n/g;
  let start = 0;
  let end = 0;
  let totalLines = 0;
  let match: RegExpExecArray | null;
  while ((match = separators.exec(text)) !== null) {
    totalLines += 1;
    if (lines.length < OBSERVATION_LIMITS.maxTextLines) {
      lines.push(text.slice(start, match.index));
      end = match.index;
    }
    start = separators.lastIndex;
  }
  if (start < text.length) {
    totalLines += 1;
    if (lines.length < OBSERVATION_LIMITS.maxTextLines) {
      lines.push(text.slice(start));
      end = text.length;
    }
  }
  return { format: "text", content: text.slice(0, end), lines, totalLines,
    truncated: totalLines > lines.length };
}

/** Replacement engines must preserve the bounded text display contract. */
export function readObservedTextDocument(value: unknown): PreviewObservedTextDocument {
  if (!isPlainRecord(value) || !hasExactKeys(value, TEXT_DOCUMENT_FIELDS)) throw new Error("Invalid observed text result.");
  const document = value as Partial<PreviewObservedTextDocument> | null;
  if (!document || document.format !== "text"
    || typeof document.content !== "string" || Buffer.byteLength(document.content) > MAX_TEXT_FILE_BYTES
    || !Array.isArray(document.lines) || document.lines.length > OBSERVATION_LIMITS.maxTextLines
    || !document.lines.every((line) => typeof line === "string" && !/[\r\n\0]/.test(line))
    || !Number.isSafeInteger(document.totalLines) || document.totalLines! < document.lines.length
    || document.truncated !== (document.totalLines! > document.lines.length)
    || JSON.stringify(document.content === "" && document.lines.length === 0 ? [] : document.content.split(/\r\n|\r|\n/))
      !== JSON.stringify(document.lines)) throw new Error("Invalid observed text result.");
  return document as PreviewObservedTextDocument;
}
