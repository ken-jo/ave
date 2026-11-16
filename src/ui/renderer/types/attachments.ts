/** Textarea markers are authoritative; attachment numbers remain stable after lower-numbered attachments are removed. */
import type { FileMentionReference } from "../../../shared/file-mention-reference.js";

/** Renderer compatibility name for the shared composer input capacity. The main-process picker and subscription transport
 * consume the same limit. */
export { MAX_COMPOSER_ATTACHMENT_COUNT as ATTACH_MAX_COUNT } from "../../../shared/composer-image-input.js";
import { MAX_COMPOSER_ATTACHMENT_COUNT } from "../../../shared/composer-image-input.js";

/** Longest pasted text that goes into the composer verbatim, line breaks and all. Anything longer becomes a pasted-text
 * chip (its marker stays in the body), and the chip shows the original text when opened. */
export const PASTE_INLINE_MAX_CHARS = 500;

/** Largest text another surface may hand the composer as one pasted-text chip (`attachPastedText`, e.g. a terminal block).
 * Longer text keeps its start and its end — where a command's error usually is — and the user is told. */
export const PASTE_TEXT_MAX_CHARS = 128 * 1024;

/**
 * Path-collapse trigger threshold. The check applies to the *stem*: the
 * substring before the last `.` of the input path, including any parent
 * directory segments. See `collapsePath()` for why whole-path collapse
 * (rather than basename-only) is intentional in the overlay UX.
 */
export const PATH_COLLAPSE_THRESHOLD = 10;


export interface ImageAttachment {
  id: string;
  n: number;
  kind: "image";
  path: string;
  mimeType: string;
  width: number;
  height: number;
  bytes: number;
  /** Base64 dataURL kept in renderer memory for thumbnail rendering. */
  dataUrl: string;
}

export interface FileAttachment {
  id: string;
  n: number;
  kind: "file";
  path: string;
  name: string;
  ext: string;
  bytes: number;
  /** True for an `@file` mention: a path reference the model reads through read_file. Not in main's attach allowlist, so the
   * chip offers no open-in-OS action for it. */
  reference?: true;
  /** A selected location in the latest settled turn; main verifies it before supplying file context. */
  location?: Omit<FileMentionReference, "path">;
}

export interface PasteAttachment {
  id: string;
  n: number;
  kind: "paste";
  text: string;
  lines: number;
  chars: number;
}

/** Keep resource markers in the body and host-built fences verbatim in separate content parts; inlining server text would
 * bypass main's per-turn resource bound. */
export interface ResourceAttachment {
  id: string;
  n: number;
  kind: "resource";
  serverId: string;
  uri: string;
  /** Display label — the server's `title` or `name`, already bounded by main. */
  label: string;
  /** The host-built fenced block. Opaque to the renderer. */
  text: string;
  /**
   * The read clipped what the server returned, or dropped non-text blocks.
   *
   * The COUNT of omitted blocks is deliberately not carried: the fence body already
   * admits each omission in a line the model reads, so a second copy in renderer state
   * would be a number nothing renders and nothing checks.
   */
  truncated: boolean;
}

export type Attachment =
  | ImageAttachment
  | FileAttachment
  | PasteAttachment
  | ResourceAttachment;

/** How many of the composer's ATTACH_MAX_COUNT slots `attachments` take. An image, a file, an `@file` reference and a pasted
 * text take one each. An MCP resource takes none: it is text under its own per-turn budget, which main enforces apart from
 * this count. Every place that enforces or shows the limit counts with this function, so they cannot disagree. */
export function attachmentSlotsUsed(attachments: readonly Attachment[]): number {
  let used = 0;
  for (const attachment of attachments) {
    if (attachment.kind !== "resource") used += 1;
  }
  return used;
}

/** True when no further image, file or pasted text fits. */
export function attachmentSlotsFull(attachments: readonly Attachment[]): boolean {
  return attachmentSlotsUsed(attachments) >= MAX_COMPOSER_ATTACHMENT_COUNT;
}
