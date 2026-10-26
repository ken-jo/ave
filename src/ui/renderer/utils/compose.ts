import type { RolePreset } from "../../../data/role-presets.js";
import { buildActivePersonaPromptId } from "../../../data/role-presets.js";
import type { UserContentPart } from "../../../engine/llm/types.js";
import type { Attachment } from "../types/attachments.js";
import { formatFileMentionReference, parseFileMentionReferences } from "../../../shared/file-mention-reference.js";

export interface ComposedOutgoing {
  /** Plain-text portion that becomes the textual body of the user turn. */
  text: string;
  /**
   * Multimodal user content parts (vision images today; reserved for inline
   * file payloads later). Empty array when no images were attached. The
   * caller passes this through the appropriate chat IPC surface
   * — the IPC layer forwards it to `runTurn(input, { attachments })`.
   */
  attachments: UserContentPart[];
  /** Per-turn Persona id; main resolves it from the file-backed prompt store. */
  personaPromptId?: string;
}

/** Preserve location selectors in text-only queues and transcript echoes without expanding ordinary attachments. */
export function augmentFileReferenceMarkers(raw: string, attachments: readonly Attachment[]): string {
  return augmentFileMarkers(raw, attachments, false);
}

function augmentFileMarkers(raw: string, attachments: readonly Attachment[], includeOrdinaryFiles: boolean): string {
  let encoded: ReturnType<typeof parseFileMentionReferences>;
  try { encoded = parseFileMentionReferences(raw); } catch {
    // Preserve malformed selectors verbatim for the host's authoritative refusal rather than rewriting their contents.
    return raw;
  }
  const files = new Map(attachments.filter((attachment) => attachment.kind === "file")
    .map((attachment) => [attachment.n, attachment]));
  // Replace only the original input so marker-shaped path text never becomes another selector.
  return raw.replace(/\[File #(\d+)\]/g, (marker, number: string, offset: number) => {
    if (encoded.some((reference) => offset >= reference.start && offset < reference.end)) return marker;
    const attachment = files.get(Number(number));
    if (!attachment) return marker;
    if (attachment.location) {
      return formatFileMentionReference(attachment.n, { path: attachment.path, ...attachment.location });
    }
    return includeOrdinaryFiles ? `[File #${attachment.n} — path: ${attachment.path}]` : marker;
  });
}

/** Keep image/resource markers and separate payload parts; augment file markers with paths and inline user pastes with
 * plain delimiters. Resource fences stay host-authored and verbatim. */
export function composeOutgoing(params: {
  raw: string;
  activePreset: RolePreset | null;
  attachments: Attachment[];
}): ComposedOutgoing {
  const { raw, activePreset, attachments } = params;

  // File augmentation precedes paste expansion so pasted marker-shaped content stays verbatim.
  let body = augmentFileMarkers(raw, attachments, true);

  // Match edited paste line-count suffixes rather than rebuilt original markers; file augmentation must already have run on
  // the original body.
  for (const att of attachments) {
    if (att.kind !== "paste") continue;
    const re = new RegExp(`\\[Pasted text #${att.n}(?:\\s+\\+\\d+\\s+lines)?\\]`, "g");
    const replacement = `\n\n----- Pasted text #${att.n} (${att.lines} lines) -----\n${att.text}\n----- end Pasted text #${att.n} -----\n\n`;
    // Replacer FUNCTION (not string) — `String.prototype.replace`'s string
    // form interprets `$&`, `$1`, `$$`, etc. as backreference tokens. The
    // pasted text could contain literal `$` sequences (regex snippets,
    // template literals, currency, etc.) and we must not mutate them.
    body = body.replace(re, () => replacement);
  }

  // 3. Image attachments become vision parts.
  const imageParts: UserContentPart[] = attachments
    .filter((a): a is Extract<Attachment, { kind: "image" }> => a.kind === "image")
    .map((img) => ({
      type: "image",
      image: img.dataUrl,
      mimeType: img.mimeType,
      width: img.width,
      height: img.height,
      bytes: img.bytes,
    }));

  // Keep host-built resource fences in separate content parts so main can enforce its bound; preserve text verbatim until
  // main applies any configured PII redaction.
  const resourceParts: UserContentPart[] = attachments
    .filter((a): a is Extract<Attachment, { kind: "resource" }> => a.kind === "resource")
    .map((res) => ({ type: "text", text: res.text }));

  return {
    text: body,
    attachments: [...imageParts, ...resourceParts],
    personaPromptId: buildActivePersonaPromptId(activePreset) ?? undefined,
  };
}

/**
 * Compose a plugin-imported trigger exactly as the plugin runtime emitted it.
 * Imported triggers already carry their overlay trigger provenance envelope; adding
 * role presets or the user's current composer attachments would change both
 * authorship and trust-origin classification.
 */
export function composeImportedTriggerOutgoing(raw: string): ComposedOutgoing {
  return {
    text: raw,
    attachments: [],
  };
}
