/** Why main refused one file a person picked or dropped. */
export type AttachFileRejectReason =
  | "denied-extension"
  | "sensitive-path"
  | "not-a-file"
  | "not-found"
  | "too-many";

/** Every reason a file did not become an attachment: main's verdicts, plus the ones only the composer can observe. */
export type AttachmentRejectReason =
  | AttachFileRejectReason
  /** The item is not a file on this computer (a web image or an in-memory blob has no path to attach). */
  | "no-file-path"
  /** The one-shot drop token was unknown, already used, or older than its lifetime. */
  | "drop-expired"
  | "image-too-large"
  | "unreadable"
  /** Main refused the request itself, not a particular file. */
  | "refused";

/** One file that was not attached, named for the person who chose it. */
export interface AttachmentRejection {
  name: string;
  reason: AttachmentRejectReason;
}
