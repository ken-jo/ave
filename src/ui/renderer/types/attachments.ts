/** Textarea markers are authoritative; attachment numbers remain stable after lower-numbered attachments are removed. */
import type { FileMentionReference } from "../../../shared/file-mention-reference.js";

/** Renderer compatibility name for the shared composer input capacity. The main-process picker and subscription transport
 * consume the same limit. */
export { MAX_COMPOSER_ATTACHMENT_COUNT as ATTACH_MAX_COUNT } from "../../../shared/composer-image-input.js";

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

/** Extensions that are unconditionally rejected by the file picker. Lowercase comparison; users see a non-blocking error
 * toast on attempt. */
export { DENY_EXTENSIONS } from "../../../shared/attachments-deny-list.js";

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
