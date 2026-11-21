/**
 * What the in-app text editor can take and give back without changing a byte the person did not edit.
 *
 * A text box holds line breaks as "\n" only and knows nothing of a byte order mark, so a file is editable only when its
 * bytes can be rebuilt exactly from that form: valid UTF-8, no NUL, one line ending throughout. Anything else is refused
 * with the reason, and the person's own editor takes it.
 */

/** A text box gets slow long before this; larger files go to the person's editor. */
export const EDITABLE_TEXT_MAX_BYTES = 1024 * 1024;

export type EditableTextRefusal = "too-large" | "not-text" | "mixed-line-endings";

export interface EditableTextShape {
  /** The file's one line ending. A file with no line break is written with "\n" if lines are added. */
  eol: "\n" | "\r\n";
  bom: boolean;
}

const BOM = "﻿";

/** Split a file into the text a text box edits and the shape that turns that text back into the file. */
export function decodeEditableText(bytes: Uint8Array):
  | { ok: true; text: string; shape: EditableTextShape }
  | { ok: false; error: EditableTextRefusal } {
  if (bytes.byteLength > EDITABLE_TEXT_MAX_BYTES) return { ok: false, error: "too-large" };
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ok: false, error: "not-text" }; }
  if (decoded.includes("\0")) return { ok: false, error: "not-text" };
  const bom = decoded.startsWith(BOM);
  const body = bom ? decoded.slice(1) : decoded;
  const crlf = body.split("\r\n").length - 1;
  const withoutCrlf = crlf === 0 ? body : body.replaceAll("\r\n", "");
  // A lone "\r", or both endings in one file, cannot be told apart again once the text box has made them all "\n".
  if (withoutCrlf.includes("\r") || (crlf > 0 && withoutCrlf.includes("\n"))) return { ok: false, error: "mixed-line-endings" };
  return { ok: true, text: crlf === 0 ? body : body.replaceAll("\r\n", "\n"), shape: { eol: crlf > 0 ? "\r\n" : "\n", bom } };
}

/** The bytes of `text` (as a text box returns it) in the shape of the file it came from. */
export function encodeEditableText(text: string, shape: EditableTextShape): Uint8Array {
  // A text box may hand back "\r\n" from a paste on some platforms; one form in, one form out.
  const lines = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const body = shape.eol === "\n" ? lines : lines.replaceAll("\n", "\r\n");
  return new TextEncoder().encode((shape.bom ? BOM : "") + body);
}
